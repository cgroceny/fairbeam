# Optional: the CUDA GPU engine of openEMS (SeanMollet/openEMS, GPL-3.0, beta) on Windows x64, side
# by side with the regular install, in its own folder and venv. Nothing in the regular install
# (OPENEMS_INSTALL_PATH, the repository venv) is changed. The counterpart of
# scripts/install-openems-gpu-macos.sh (docs/GPU.md).
#
# It uses the fork's own Windows package of the same tag the macOS script builds: MSVC 2022 and
# CUDA 12.8.1, built by the fork's CI (.github/workflows/packages.yml, "Windows MSVC, CUDA") for
# sm_60 to sm_120. The CUDA runtime is linked statically: the only requirement is an NVIDIA driver
# compatible with CUDA 12 (Windows 528.33 or newer); no CUDA toolkit.
#
# Usage (Windows PowerShell or PowerShell 7):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-openems-gpu-windows.ps1 [-Prefix C:\opt\openEMS-gpu]
#   $env:OPENEMS_INSTALL_PATH = "C:\opt\openEMS-gpu"      # this venv loads its DLLs from there
#   C:\opt\openEMS-gpu\venv\Scripts\python.exe -m fairbeam run python\models\patch_antenna.py --engine gpu
#
# This file must stay ASCII: Windows PowerShell 5.1 reads a script without BOM in the ANSI code page.
param(
    [string]$Prefix = "C:\opt\openEMS-gpu",
    [string]$Archive,                 # a local copy of the package instead of downloading it
    [string]$Python = "3.13",         # the package has cp313 and cp314 wheels
    [switch]$Reinstall
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# pinned: the fork's release v0.37.0-beta1+gpu
$Tag = "v0.37.0-beta1+gpu"
$Url = "https://github.com/SeanMollet/openEMS/releases/download/v0.37.0-beta1%2Bgpu/openEMS_x64_v0.37.0-beta1+gpu_msvc_cuda.zip"
$Sha = "ca308c03de41054056b20b4d40c3fe51c07f2a7fb5702fe1042d6406f741764f"
$Repo = Split-Path -Parent $PSScriptRoot

function Step([string]$m) { Write-Host "==> $m" }
function Die([string]$m) { [Console]::Error.WriteLine("install-openems-gpu-windows: error: $m"); exit 1 }
function Sha256([string]$p) {
    $h = [System.Security.Cryptography.SHA256]::Create(); $f = [System.IO.File]::OpenRead($p)
    try { return (-join ($h.ComputeHash($f) | ForEach-Object { $_.ToString("x2") })) } finally { $f.Dispose(); $h.Dispose() }
}

# ---------------------------------------------------------------- driver
$smi = Join-Path $env:SystemRoot "System32\nvidia-smi.exe"
if (-not (Test-Path $smi)) { Die "no NVIDIA driver found (nvidia-smi.exe); the CUDA engine needs an NVIDIA GPU" }
$ErrorActionPreference = "Continue"
$gpu = & $smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader 2>&1 | Select-Object -First 1
$ErrorActionPreference = "Stop"
Step "GPU: $gpu"
$driver = [double](("$gpu" -split ",")[2].Trim() -replace "^(\d+\.\d+).*", '$1')
if ($driver -lt 528.33) { Die "NVIDIA driver $driver is too old: Windows driver 528.33 or newer is needed for CUDA 12" }

# ---------------------------------------------------------------- package
$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$exe = Join-Path $Prefix "openEMS.exe"
if ($Reinstall -and (Test-Path $Prefix)) {
    Step "Removing $Prefix"
    Remove-Item -Recurse -Force $Prefix
}
if (-not (Test-Path $exe)) {
    if (-not $Archive) {
        $Archive = Join-Path $env:TEMP (Split-Path -Leaf ([uri]::UnescapeDataString($Url)))
        if (-not ((Test-Path $Archive) -and ((Sha256 $Archive) -eq $Sha))) {
            Step "Downloading $Tag (66 MB)"
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
        }
    }
    $got = Sha256 $Archive
    if ($got -ne $Sha) { Die "${Archive}: SHA-256 mismatch (expected $Sha, got $got)" }
    Step "Unpacking to $Prefix"
    $tmp = "$Prefix.unpack"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $tmp)
    $top = Get-ChildItem -Path $tmp -Recurse -Filter openEMS.exe | Select-Object -First 1
    if (-not $top) { Die "openEMS.exe not found in $Archive" }
    New-Item -ItemType Directory -Force (Split-Path -Parent $Prefix) | Out-Null
    Move-Item $top.Directory.FullName $Prefix
    Remove-Item -Recurse -Force $tmp
}
$ErrorActionPreference = "Continue"
$help = & $exe --help 2>&1 | Out-String
$ErrorActionPreference = "Stop"
if ($help -notmatch "(?m)^\s+gpu:") { Die "$exe has no gpu engine" }

# ---------------------------------------------------------------- venv
$venv = Join-Path $Prefix "venv"
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
    Step "Creating $venv (Python $Python)"
    & py "-$Python" -m venv $venv
    if ($LASTEXITCODE -ne 0) { Die "could not create the venv with py -$Python" }
}
$env:OPENEMS_INSTALL_PATH = $Prefix   # for this process only: the wheels load their DLLs from here
Step "Installing numpy, h5py, matplotlib, the package's CSXCAD/openEMS wheels and fairbeam"
& $py -m pip install -q --upgrade pip
& $py -m pip install -q numpy h5py matplotlib
if ($LASTEXITCODE -ne 0) { Die "pip could not install numpy/h5py/matplotlib" }
& $py -m pip install -q --force-reinstall --no-deps --no-index --find-links (Join-Path $Prefix "python") CSXCAD openEMS
if ($LASTEXITCODE -ne 0) { Die "pip could not install the package's CSXCAD/openEMS wheels" }
& $py -m pip install -q -e (Join-Path $Repo "python")
if ($LASTEXITCODE -ne 0) { Die "pip could not install fairbeam from $Repo\python" }

$check = & $py -c "import openEMS, CSXCAD, fairbeam; from importlib import metadata as m; print(m.version('openEMS'), m.version('CSXCAD'), fairbeam.__version__)"
if ($LASTEXITCODE -ne 0 -or "$check" -notmatch "\+gpu") { Die "the venv does not import the GPU build of openEMS: $check" }
Step "Done: openEMS / CSXCAD / fairbeam $check"
Write-Host ""
Write-Host "Use it with OPENEMS_INSTALL_PATH pointing at this folder (the regular install keeps its own):"
Write-Host "  `$env:OPENEMS_INSTALL_PATH = `"$Prefix`""
Write-Host "  & `"$py`" -m fairbeam run python\models\patch_antenna.py --engine gpu"
