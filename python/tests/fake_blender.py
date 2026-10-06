"""A stand-in for ``blender -b -P blender_render.py -- job.json`` (tests/test_blender_render.py).

Usage: fake_blender.py JOB.json MODE   (MODE: ok | fail | hang)
Prints Blender-style progress lines and the script's ``@AL`` markers, and writes the PNG / .blend files of the job.
"""

import json
import sys
import time
from pathlib import Path

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x9a\xa0\xa0\x00\x00\x00\x00IEND\xaeB`\x82")
LINE = ("Fra:1 Mem:227.14M (Peak 366.56M) | Time:00:01.94 | Remaining:00:01.84 | Mem:592.86M, Peak:592.86M | "
        "Scene, ViewLayer | Sample %d/%d")


def say(*parts):
    print("@AL", *parts, flush=True)


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    mode = sys.argv[2] if len(sys.argv) > 2 else "ok"
    say("stage", "import")
    if mode == "fail":
        say("error", "ValueError: no mesh objects")
        sys.exit(1)
    say("device", "fake gpu")
    n = len(job["outputs"])
    say("count", n)
    for i, out in enumerate(job["outputs"], 1):
        if i == 1 and job.get("blend"):
            Path(job["blend"]).write_bytes(b"BLENDER")
            say("blend", job["blend"])
        say("angle", i, n, Path(out).stem.split("_")[-2])
        for s in (1, 4, 8):
            print(LINE % (s, 8), flush=True)
            time.sleep(0.02)
        if mode == "hang":
            Path(out).write_bytes(b"partial")          # a half-written file must not survive a cancel
            time.sleep(60)
        Path(out).write_bytes(PNG)
        say("done", i, n, out, 0.1)
    say("finished", 0.5)


if __name__ == "__main__":
    main()
