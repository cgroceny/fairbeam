"""Windows PowerShell 5.1 tests for the managed runtime downloader."""

import base64
import hashlib
import http.server
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "runtime" / "setup-runtime.ps1"
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
PORTS = range(5510, 5541)


def ps_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def run_powershell(body, proxy_env=None):
    # Loading the file itself would execute the installer. Parse its top-level
    # function definitions instead, so every request in these tests is local.
    setup = """
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$Invariant = [Globalization.CultureInfo]::InvariantCulture
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(%s, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($definition in $ast.EndBlock.Statements) {
    if ($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
}
""" % ps_string(SCRIPT)
    command = setup + "\n" + body + "\n"
    # -EncodedCommand takes base64-encoded UTF-16LE, independent of the console
    # code page and safe for Windows paths containing quotes or non-ASCII text.
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    env = os.environ.copy()
    for name in list(env):
        if name.lower() in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}:
            del env[name]
    env.update(proxy_env or {})
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=30,
    )


class LocalServer:
    def __init__(self, handler):
        for port in PORTS:
            try:
                self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
                break
            except OSError:
                continue
        else:
            raise RuntimeError("No test port available in 5510-5540")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


class QuietHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass


@unittest.skipUnless(os.name == "nt" and Path(POWERSHELL).is_file(),
                     "requires Windows PowerShell 5.1")
class RuntimeBootstrapDownload(unittest.TestCase):
    def download(self, url, destination, payload, proxy_env=None):
        return run_powershell(
            "Get-Pinned %s %s %s 'download-test'" % (
                ps_string(url), ps_string(destination),
                ps_string(hashlib.sha256(payload).hexdigest())),
            proxy_env,
        )

    def assert_downloaded(self, result, destination, payload):
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(destination.read_bytes(), payload)
        self.assertFalse(Path(str(destination) + ".part").exists())

    def test_environment_proxy_routes_actual_download(self):
        payload = b"through the configured proxy"
        requests = []

        class Proxy(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        with LocalServer(Proxy) as proxy, tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "İzmir çalışma"
            folder.mkdir()
            destination = folder / "uv.zip"
            url = "http://fairbeam-download.invalid/uv.zip"
            result = self.download(url, destination, payload, {"HTTP_PROXY": proxy.url})
            self.assert_downloaded(result, destination, payload)
            self.assertEqual(requests, [url])

    def test_no_proxy_bypasses_environment_proxy(self):
        payload = b"direct local response"
        direct_requests = []
        proxy_requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                direct_requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        class Proxy(QuietHandler):
            def do_GET(self):
                proxy_requests.append(self.path)
                self.send_error(502)

        with LocalServer(Origin) as origin, LocalServer(Proxy) as proxy:
            with tempfile.TemporaryDirectory() as tmp:
                destination = Path(tmp) / "uv.zip"
                result = self.download(
                    origin.url + "/uv.zip", destination, payload,
                    {"HTTP_PROXY": proxy.url, "NO_PROXY": "127.0.0.1"},
                )
                self.assert_downloaded(result, destination, payload)
        self.assertEqual(direct_requests, ["/uv.zip"])
        self.assertEqual(proxy_requests, [])

    def test_proxy_selection_and_system_proxy_preservation(self):
        def selected(uri, env):
            result = run_powershell(
                "$uri = [Uri]%s\n"
                "$request = [System.Net.HttpWebRequest]::Create($uri)\n"
                "Set-DownloadProxy $request\n"
                "[Console]::Out.WriteLine($request.Proxy.GetProxy($uri).AbsoluteUri)\n"
                "$request.Abort()" % ps_string(uri), env)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            return result.stdout.strip()

        self.assertEqual(
            selected("https://download.example.test/uv.zip",
                     {"https_proxy": "http://127.0.0.1:5511"}),
            "http://127.0.0.1:5511/",
        )
        self.assertEqual(
            selected("http://download.example.test/uv.zip",
                     {"ALL_PROXY": "http://127.0.0.1:5512"}),
            "http://127.0.0.1:5512/",
        )
        self.assertEqual(
            selected("http://download.example.test/uv.zip",
                     {"HTTP_PROXY": "http://127.0.0.1:5513",
                      "ALL_PROXY": "http://127.0.0.1:5512"}),
            "http://127.0.0.1:5513/",
        )
        result = run_powershell(
            "$request = [System.Net.HttpWebRequest]::Create('http://download.example.test/')\n"
            "$original = New-Object System.Net.WebProxy 'http://127.0.0.1:5514'\n"
            "$request.Proxy = $original\n"
            "Set-DownloadProxy $request\n"
            "[Console]::Out.WriteLine([object]::ReferenceEquals($original, $request.Proxy))\n"
            "$request.Abort()")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(result.stdout.strip(), "True")
        result = run_powershell(
            "$uri = [Uri]'http://download.example.test/uv.zip'\n"
            "$request = [System.Net.HttpWebRequest]::Create($uri)\n"
            "Set-DownloadProxy $request\n"
            "$credential = $request.Proxy.Credentials.GetCredential($request.Proxy.Address, 'Basic')\n"
            "$valid = ($credential.UserName -eq 'user') -and "
            "($credential.Password -eq 'fake:password') -and "
            "(-not $request.Proxy.Address.UserInfo)\n"
            "[Console]::Out.WriteLine($valid)\n"
            "$request.Abort()",
            {"HTTP_PROXY": "http://user:fake%3Apassword@127.0.0.1:5515"},
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(result.stdout.strip(), "True")

    def test_interrupted_transfer_retries_and_discards_partial_file(self):
        payload = b"complete payload after interrupted response"
        requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if len(requests) == 1:
                    self.wfile.write(payload[:7])
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_WR)
                else:
                    self.wfile.write(payload)

        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            Path(str(destination) + ".part").write_bytes(b"stale partial download")
            result = self.download(origin.url + "/uv.zip", destination, payload,
                                   {"NO_PROXY": "127.0.0.1"})
            self.assert_downloaded(result, destination, payload)
        self.assertEqual(requests, ["/uv.zip", "/uv.zip"])

    def test_hash_mismatch_does_not_retry(self):
        requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                payload = b"corrupt data"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            result = self.download(origin.url + "/uv.zip", destination, b"expected data",
                                   {"NO_PROXY": "127.0.0.1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 mismatch", result.stderr)
            self.assertFalse(destination.exists())
            self.assertFalse(Path(str(destination) + ".part").exists())
        self.assertEqual(requests, ["/uv.zip"])

    def test_verified_cache_is_reused_without_request(self):
        requests = []
        payload = b"previously verified payload"

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_error(500)

        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            destination.write_bytes(payload)
            Path(str(destination) + ".part").write_bytes(b"stale partial download")
            result = self.download(origin.url + "/uv.zip", destination, payload,
                                   {"NO_PROXY": "127.0.0.1"})
            self.assert_downloaded(result, destination, payload)
        self.assertEqual(requests, [])

    def test_transient_status_is_bounded_and_cleans_partial_file(self):
        requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_error(503)

        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            result = self.download(origin.url + "/uv.zip", destination, b"expected",
                                   {"NO_PROXY": "127.0.0.1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())
            self.assertFalse(Path(str(destination) + ".part").exists())
        self.assertEqual(requests, ["/uv.zip"] * 3)

    def test_permanent_status_and_local_file_failure_do_not_retry(self):
        requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path == "/missing":
                    self.send_error(404)
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "4")
                    self.end_headers()
                    self.wfile.write(b"data")

        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            result = self.download(origin.url + "/missing", destination, b"data",
                                   {"NO_PROXY": "127.0.0.1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(Path(str(destination) + ".part").exists())
            unavailable = Path(tmp) / "missing-parent" / "uv.zip"
            result = self.download(origin.url + "/data", unavailable, b"data",
                                   {"NO_PROXY": "127.0.0.1"})
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(Path(str(unavailable) + ".part").exists())
            self.assertIn("could not remove partial download", result.stderr)
        # The absent parent is detected while cleaning a stale .part, before any
        # network request. It must not enter the retry loop.
        self.assertEqual(requests, ["/missing"])

    def test_invalid_proxy_does_not_expose_credentials(self):
        requests = []

        class Origin(QuietHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_error(500)

        secret = "bootstrap-proxy-secret"
        with LocalServer(Origin) as origin, tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "uv.zip"
            result = self.download(
                origin.url + "/uv.zip", destination, b"expected",
                {"HTTP_PROXY": f"http://user:{secret}@127.0.0.1:notaport"},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())
            self.assertFalse(Path(str(destination) + ".part").exists())
        self.assertEqual(requests, [])
        self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
