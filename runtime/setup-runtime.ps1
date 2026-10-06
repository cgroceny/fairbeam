# Fairbeam managed runtime, stage 1 for Windows x64 (see docs/DESKTOP.md). Windows PowerShell 5.1
# or later; no system Python, no admin rights, and nothing outside the runtime root is changed (no
# PATH edit, no registry entry, no python.exe shim in ~\.local\bin).
#   1. download the pinned uv (runtime/pins.json) and verify its SHA-256,
#   2. install a uv-managed CPython (pins.json "python") into <root>\python,
#   3. create <root>\venv with it,
#   4. hand over to stage 2 (runtime\install.py) with the venv's Python.
# Progress: lines "FAIRBEAM-PROGRESS {json}" on stdout (ASCII JSON; stage 2 continues the same
# protocol). Errors: "Fairbeam runtime: error: ..." on stderr and a non-zero exit code.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup-runtime.ps1 -RuntimeRoot C:\...\runtime -Resources C:\...\resources [-Repair] [-OpenemsArchive FILE]
#
# This file must stay ASCII: Windows PowerShell 5.1 reads a script without BOM in the ANSI code page.
param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$Resources,
    [switch]$Repair,
    [string]$OpenemsArchive,
    [ValidateSet("cpu", "gpu")][string]$Engine = "cpu"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$Invariant = [Globalization.CultureInfo]::InvariantCulture

function Write-Line([System.IO.TextWriter]$w, [string]$s) { $w.WriteLine($s); $w.Flush() }

function Fail([string]$msg) {
    Write-Line ([Console]::Error) "Fairbeam runtime: error: $msg"
    exit 1
}

function ConvertTo-JsonString([string]$s) {
    # ASCII-only JSON string: non-ASCII characters (a user name in a path) as \uXXXX, so the line
    # reads the same whatever code page the reader assumes
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($c in $s.ToCharArray()) {
        $i = [int]$c
        if ($c -eq '"') { [void]$sb.Append('\"') }
        elseif ($c -eq '\') { [void]$sb.Append('\\') }
        elseif ($i -lt 0x20 -or $i -gt 0x7e) { [void]$sb.Append('\u' + $i.ToString('x4')) }
        else { [void]$sb.Append($c) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Progress([string]$step, [string]$msg, $fraction = $null) {
    $json = '{"step": ' + (ConvertTo-JsonString $step)
    if ($null -ne $fraction) {
        $f = [Math]::Max(0.0, [Math]::Min(1.0, [double]$fraction))
        $json += ', "fraction": ' + $f.ToString("0.####", $Invariant)  # never "0,5" (tr-TR, de-DE ...)
    }
    $json += ', "message": ' + (ConvertTo-JsonString $msg) + '}'
    Write-Line ([Console]::Out) "FAIRBEAM-PROGRESS $json"
}

function Get-Sha256([string]$path) {
    # .NET, not Get-FileHash / Expand-Archive: those live in script modules that Windows PowerShell
    # autoloads from PSModulePath, and a PSModulePath inherited from PowerShell 7 (the app started
    # from a pwsh terminal) points it at incompatible copies
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $f = [System.IO.File]::OpenRead($path)
    try { return (-join ($sha.ComputeHash($f) | ForEach-Object { $_.ToString("x2") })) }
    finally { $f.Dispose(); $sha.Dispose() }
}

function Get-ProxyEnvironment([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name.ToLowerInvariant()) }
    if ($value) { return $value.Trim() }
    return $null
}

function Test-NoProxy([System.Uri]$uri, [string]$noProxy) {
    if (-not $noProxy) { return $false }
    $hostName = $uri.DnsSafeHost.TrimEnd('.')
    foreach ($item in $noProxy.Split(',')) {
        $entry = $item.Trim()
        if ($entry -eq '*') { return $true }
        if (-not $entry) { continue }
        $port = $null
        if ($entry -match '^\[([^]]+)\](?::([0-9]+))?$') {
            $entry = $Matches[1]
            $port = $Matches[2]
        } elseif ($entry -match '^([^:]+):([0-9]+)$') {
            $entry = $Matches[1]
            $port = $Matches[2]
        }
        if ($port -and $port -ne [string]$uri.Port) { continue }
        if ($entry.StartsWith('*.')) { $entry = $entry.Substring(2) }
        $entry = $entry.TrimStart('.').TrimEnd('.')
        if ($hostName -ieq $entry -or $hostName.EndsWith(".$entry", [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Set-DownloadProxy([System.Net.HttpWebRequest]$request) {
    $noProxy = Get-ProxyEnvironment 'NO_PROXY'
    if ($noProxy -and (Test-NoProxy $request.RequestUri $noProxy)) {
        $request.Proxy = $null
        return
    }
    $name = if ($request.RequestUri.Scheme -eq 'https') { 'HTTPS_PROXY' } else { 'HTTP_PROXY' }
    $address = Get-ProxyEnvironment $name
    if (-not $address) { $name = 'ALL_PROXY'; $address = Get-ProxyEnvironment $name }
    if ($address) {
        try {
            if ($address -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') { $address = "http://$address" }
            $proxyUri = [System.Uri]$address
            if ($proxyUri.Scheme -ne 'http' -or -not $proxyUri.Host) { throw 'unsupported scheme' }
            $proxyAddress = [System.UriBuilder]::new($proxyUri)
            $proxyAddress.UserName = ''
            $proxyAddress.Password = ''
            $proxy = [System.Net.WebProxy]::new($proxyAddress.Uri)
            if ($proxyUri.UserInfo) {
                $userPass = $proxyUri.UserInfo -split ':', 2
                $user = [System.Uri]::UnescapeDataString($userPass[0])
                $password = if ($userPass.Count -gt 1) { [System.Uri]::UnescapeDataString($userPass[1]) } else { '' }
                $proxy.Credentials = [System.Net.NetworkCredential]::new($user, $password)
            }
            $request.Proxy = $proxy
        } catch {
            throw "invalid $name setting (use an http:// proxy URL)"
        }
    }
    # When no environment proxy applies, retain HttpWebRequest's system proxy.
    if ($request.Proxy -and -not $request.Proxy.Credentials) {
        $request.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
    }
}

function Get-Pinned([string]$url, [string]$dest, [string]$sha, [string]$step) {
    # a verified copy in <root>\downloads is reused; a damaged one is downloaded again
    $name = Split-Path -Leaf $dest
    $part = "$dest.part"
    try { [System.IO.File]::Delete($part) } catch { Fail "could not remove partial download ${part}: $($_.Exception.Message)" }
    if (Test-Path -LiteralPath $dest) {
        if ((Get-Sha256 $dest) -eq $sha) { Progress $step "$name already downloaded" 1.0; return }
        Progress $step "$name in the download cache is damaged; downloading it again" 0.0
        Remove-Item -Force -LiteralPath $dest
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $req = $null; $resp = $null; $in = $null; $out = $null
        $failure = $null; $cleanupFailure = $null; $downloaded = $false; $httpCode = $null
        $phase = 'request'
        try {
            $req = [System.Net.HttpWebRequest]::Create($url)
            $req.UserAgent = "fairbeam-runtime"
            $req.Timeout = 60000
            $req.ReadWriteTimeout = 60000
            Set-DownloadProxy $req
            $phase = 'response'
            $resp = $req.GetResponse()
            $total = $resp.ContentLength
            $in = $resp.GetResponseStream()
            $phase = 'file'
            $out = [System.IO.File]::Create($part)
            $buf = New-Object byte[] (1MB)
            [long]$done = 0
            $last = [DateTime]::MinValue
            while ($true) {
                $phase = 'response'
                $n = $in.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $phase = 'file'
                $out.Write($buf, 0, $n)
                $done += $n
                if (((Get-Date) - $last).TotalSeconds -gt 0.25 -and $total -gt 0) {
                    $last = Get-Date
                    Progress $step ("{0:0} / {1:0} MB" -f ($done / 1MB), ($total / 1MB)) ($done / $total)
                }
            }
            $phase = 'response'
            if ($total -ge 0 -and $done -ne $total) {
                throw [System.IO.EndOfStreamException]::new("received $done of $total bytes")
            }
            $downloaded = $true
        }
        catch { $failure = $_ }
        finally {
            foreach ($stream in @($out, $in, $resp)) {
                if ($null -ne $stream) {
                    try { $stream.Dispose() } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
                }
            }
            if ($failure) {
                $errorEx = $failure.Exception
                while ($errorEx) {
                    if ($errorEx -is [System.Net.WebException] -and $errorEx.Response) {
                        if ($errorEx.Response -is [System.Net.HttpWebResponse]) {
                            $httpCode = [int]$errorEx.Response.StatusCode
                        }
                        try { $errorEx.Response.Dispose() } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
                        break
                    }
                    $errorEx = $errorEx.InnerException
                }
            }
            if ($req) { try { $req.Abort() } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } } }
            if (-not $downloaded -or $cleanupFailure) {
                try { [System.IO.File]::Delete($part) } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
            }
        }
        if ($cleanupFailure) { Fail "could not finish download ${url}: $($cleanupFailure.Exception.Message)" }
        if ($downloaded) { break }
        $retry = $false
        $why = if ($phase -eq 'request' -or $phase -eq 'file') {
            $failure.Exception.Message
        } else {
            'network or response read failure'
        }
        $ex = $failure.Exception
        while ($ex) {
            if ($ex -is [System.Net.WebException]) {
                if ($ex.Response -is [System.Net.HttpWebResponse]) {
                    $why = "HTTP $httpCode"
                    $retry = $httpCode -in @(408, 429, 500, 502, 503, 504)
                } else {
                    $why = "network error ($($ex.Status))"
                    $retry = $ex.Status -in @(
                        [System.Net.WebExceptionStatus]::Timeout,
                        [System.Net.WebExceptionStatus]::ConnectFailure,
                        [System.Net.WebExceptionStatus]::ConnectionClosed,
                        [System.Net.WebExceptionStatus]::ReceiveFailure,
                        [System.Net.WebExceptionStatus]::SendFailure,
                        [System.Net.WebExceptionStatus]::KeepAliveFailure,
                        [System.Net.WebExceptionStatus]::PipelineFailure,
                        [System.Net.WebExceptionStatus]::NameResolutionFailure,
                        [System.Net.WebExceptionStatus]::ProxyNameResolutionFailure
                    )
                }
                break
            }
            if ($phase -eq 'response' -and $ex -is [System.IO.IOException]) { $retry = $true; $why = 'response ended before the download completed' }
            $ex = $ex.InnerException
        }
        if (-not $retry -or $attempt -eq 3) {
            $tries = if ($attempt -eq 1) { '' } else { " after $attempt attempts" }
            $advice = if ($retry) { ' Check the internet connection or proxy and retry.' } else { '' }
            Fail "could not download ${url}${tries}: $why$advice"
        }
        Start-Sleep -Milliseconds (250 * $attempt)
    }
    try { $got = Get-Sha256 $part }
    catch {
        [System.IO.File]::Delete($part)
        Fail "could not verify ${url}: $($_.Exception.Message)"
    }
    if ($got -ne $sha) {
        [System.IO.File]::Delete($part)
        Fail "${url}: SHA-256 mismatch (expected $sha, got $got)"
    }
    try { Move-Item -Force -LiteralPath $part -Destination $dest }
    catch {
        [System.IO.File]::Delete($part)
        Fail "could not save ${url}: $($_.Exception.Message)"
    }
    Progress $step "$name verified" 1.0
}

function Invoke-Tool([string]$what, [string]$exe, [string[]]$arguments) {
    # capture the tool's output; Windows PowerShell 5.1 would otherwise turn its stderr into
    # terminating NativeCommandErrors (ErrorActionPreference Stop) when our stderr is a pipe
    $ErrorActionPreference = "Continue"
    $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($code -ne 0) { Fail "$what failed (exit code $code):`n$(($out | Select-Object -Last 40) -join "`n")" }
    return $out
}

function Join-CommandLine([string[]]$argv) {
    # Windows command-line quoting (CommandLineToArgvW rules, like subprocess.list2cmdline)
    $parts = foreach ($a in $argv) {
        if ($a -and $a -notmatch '[\s"]') { $a; continue }
        $s = '"'
        $bs = 0
        foreach ($c in $a.ToCharArray()) {
            if ($c -eq '\') { $bs++; continue }
            if ($c -eq '"') { $s += ('\' * (2 * $bs + 1)) + '"' } else { $s += ('\' * $bs) + $c }
            $bs = 0
        }
        $s + ('\' * (2 * $bs)) + '"'
    }
    return ($parts -join ' ')
}

function Remove-Folder([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $path
    if (Test-Path -LiteralPath $path) {
        Fail "cannot remove ${path}: a file in it is in use. Quit Fairbeam (or stop 'fairbeam serve') and retry."
    }
}

# ---------------------------------------------------------------- checks

if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot)) { Fail "the runtime root must be an absolute path" }
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$rootName = Split-Path -Leaf $RuntimeRoot
if ($Engine -eq "gpu" -and -not $rootName.StartsWith("gpu-runtime", [StringComparison]::OrdinalIgnoreCase)) {
    Fail "the GPU runtime root must be a dedicated folder named 'gpu-runtime'"
}
if ($Engine -eq "cpu" -and $rootName -ne "runtime") { Fail "the CPU runtime root must be a dedicated folder named 'runtime'" }
if ($Engine -eq "gpu") {
    $manifestPath = Join-Path $RuntimeRoot "manifest.json"
    if (Test-Path -LiteralPath $manifestPath) {
        try { $existingManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json }
        catch { $existingManifest = $null }
        if ($existingManifest -and $existingManifest.marker -eq "fairbeam runtime v1" -and $existingManifest.engine -ne "gpu") {
            Fail "refusing to replace a non-GPU runtime; choose a dedicated gpu-runtime folder"
        }
    }
}
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "this runtime is for Windows x64 (this machine: $arch)" }
$Resources = [System.IO.Path]::GetFullPath($Resources)
$pinsFile = Join-Path $Resources "runtime\pins.json"
$stage2File = Join-Path $Resources "runtime\install.py"
if (-not (Test-Path -LiteralPath $pinsFile) -or -not (Test-Path -LiteralPath $stage2File)) {
    Fail "runtime\pins.json or runtime\install.py not found in $Resources"
}
$pins = Get-Content -Raw -Encoding UTF8 -LiteralPath $pinsFile | ConvertFrom-Json
$uvPin = $pins.uv.'windows-x64'
$pyVer = [string]$pins.python
if (-not $uvPin.url -or -not $uvPin.sha256 -or -not $pyVer) { Fail "pins.json has no uv/python pin for windows-x64" }
$openemsPin = if ($Engine -eq "gpu") { $pins.openems_gpu.'windows-x64' } else { $pins.openems.'windows-x64' }
if (-not $openemsPin.url -or -not $openemsPin.sha256) { Fail "pins.json has no $Engine openEMS pin for windows-x64" }

# GitHub needs TLS 1.2; Windows PowerShell 5.1 on older Windows 10 does not offer it by default
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

# only our uv settings: a user's UV_INDEX_URL, uv.toml or global cache must not change the runtime
Get-ChildItem Env: | Where-Object { $_.Name -like "UV_*" } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
foreach ($v in "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV") { Remove-Item -ErrorAction SilentlyContinue -LiteralPath "Env:$v" }
$env:UV_NO_CONFIG = "1"
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot "python"
$env:PYTHONIOENCODING = "utf-8"

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeRoot "uv"), (Join-Path $RuntimeRoot "downloads") | Out-Null
# Stage 2 verifies the pinned archive before invalidating an installed manifest. Preserve the
# optional GPU environment during repair; only its native wheels and openEMS build are replaced.
if ($Repair -and $Engine -eq "cpu") {
    Remove-Folder (Join-Path $RuntimeRoot "venv")
    Remove-Folder (Join-Path $RuntimeRoot "python")
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $RuntimeRoot "uv\uv.exe")
}

# ---------------------------------------------------------------- 1. uv

$uv = Join-Path $RuntimeRoot "uv\uv.exe"
$haveUv = $false
if (Test-Path -LiteralPath $uv) {
    $ErrorActionPreference = "Continue"
    $v = & $uv --version 2>$null
    $ErrorActionPreference = "Stop"
    $haveUv = ($LASTEXITCODE -eq 0) -and ("$v" -match ("^uv " + [regex]::Escape([string]$pins.uv.version) + "\b"))
}
if ($haveUv) {
    Progress "download-uv" "uv $($pins.uv.version) already installed" 1.0
} else {
    Progress "download-uv" $uvPin.url 0.0
    $zip = Join-Path $RuntimeRoot ("downloads\" + (Split-Path -Leaf $uvPin.url))
    Get-Pinned $uvPin.url $zip $uvPin.sha256 "download-uv"
    $tmp = Join-Path $RuntimeRoot ("uv." + [guid]::NewGuid().ToString("N"))
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
        $found = Get-ChildItem -LiteralPath $tmp -Recurse -File -Filter uv.exe | Select-Object -First 1
        if (-not $found) { Fail "uv.exe not found in $zip" }
        Move-Item -Force -LiteralPath $found.FullName -Destination $uv
    }
    catch { Fail "could not unpack ${zip}: $($_.Exception.Message)" }
    finally { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $tmp }
}

# ---------------------------------------------------------------- 2. CPython, 3. venv

Progress "install-python" "CPython $pyVer"
# --no-bin: no python3.x.exe in ~\.local\bin; --no-registry: no PEP 514 entry (py.exe would list it)
Invoke-Tool "uv python install $pyVer" $uv @("python", "install", $pyVer, "--no-bin", "--no-registry") | Out-Null
$base = (Invoke-Tool "uv python find $pyVer" $uv @("python", "find", $pyVer, "--managed-python", "--no-project")) | Select-Object -Last 1
if (-not $base -or -not (Test-Path -LiteralPath $base)) { Fail "uv installed CPython $pyVer but it cannot be found in $($env:UV_PYTHON_INSTALL_DIR)" }
Progress "install-python" "$base" 1.0

$venv = Join-Path $RuntimeRoot "venv"
$py = Join-Path $venv "Scripts\python.exe"
$venvOk = $false
if (Test-Path -LiteralPath $py) {
    $ErrorActionPreference = "Continue"
    $pv = & $py -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    $ErrorActionPreference = "Stop"
    $venvOk = ($LASTEXITCODE -eq 0) -and ("$pv" -eq $pyVer)
}
if ($venvOk) {
    Progress "create-venv" "$venv is up to date" 1.0
} else {
    Progress "create-venv" $venv
    # --python <minor> (not the patch path): uv points the venv at its minor-version link, which
    # survives a patch update of the managed CPython
    Invoke-Tool "uv venv" $uv @("venv", $venv, "--python", $pyVer, "--managed-python", "--clear", "--no-project") | Out-Null
    Progress "create-venv" $venv 1.0
}

# ---------------------------------------------------------------- 4. stage 2

$argv = @($stage2File, "--runtime-root", $RuntimeRoot, "--resources", $Resources, "--engine", $Engine)
if ($Repair) { $argv += "--repair" }
if ($OpenemsArchive) { $argv += @("--openems-archive", [System.IO.Path]::GetFullPath($OpenemsArchive)) }
# started directly (not through the PowerShell pipeline), so stage 2 writes its progress lines and
# errors straight to our stdout/stderr, unchanged and unbuffered
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $py
$psi.Arguments = Join-CommandLine $argv
$psi.UseShellExecute = $false
try { $p = [System.Diagnostics.Process]::Start($psi) } catch { Fail "could not start stage 2 ($py): $($_.Exception.Message)" }
$p.WaitForExit()
exit $p.ExitCode
