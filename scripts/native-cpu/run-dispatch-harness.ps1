param(
	[Parameter(Mandatory = $true)]
	[string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$harnessPath = Join-Path $PSScriptRoot 'engine_extension_phase_dispatch_harness.cpp'
$fdtdDir = Join-Path $SourceRoot 'FDTD'
$extensionDir = Join-Path $fdtdDir 'extensions'
$requiredFiles = @(
	(Join-Path $extensionDir 'engine_extension.h'),
	(Join-Path $extensionDir 'engine_extension.cpp'),
	(Join-Path $extensionDir 'engine_extension_phase_dispatch.h'),
	(Join-Path $SourceRoot 'FDTD\engine_multithread.cpp')
)
foreach ($path in $requiredFiles) {
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
		throw "Patched source file is missing: $path"
	}
}
if (-not (Select-String -LiteralPath (Join-Path $SourceRoot 'FDTD\engine_multithread.cpp') -SimpleMatch 'EngineExtensionPhaseDispatch::Build' -Quiet)) {
	throw 'The source tree does not contain the integrated phase-dispatch prototype.'
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ('openems-cpu-dispatch-' + [Guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
	throw "Temporary harness path escaped the system temp directory: $tempRoot"
}
$tempExtensions = Join-Path $tempRoot 'extensions'
$tempFDTD = Join-Path $tempRoot 'FDTD'
New-Item -ItemType Directory -Path $tempExtensions, $tempFDTD | Out-Null
try {
	Copy-Item -LiteralPath (Join-Path $extensionDir 'engine_extension.h') -Destination $tempExtensions
	Copy-Item -LiteralPath (Join-Path $extensionDir 'engine_extension.cpp') -Destination $tempExtensions
	@'
#ifndef DISPATCH_HARNESS_OPERATOR_EXTENSION_H
#define DISPATCH_HARNESS_OPERATOR_EXTENSION_H
#include <string>
class Operator_Extension
{
public:
	std::string GetExtensionName() const { return "harness extension"; }
};
#endif
'@ | Set-Content -LiteralPath (Join-Path $tempExtensions 'operator_extension.h') -Encoding ascii
	@'
#ifndef DISPATCH_HARNESS_ENGINE_H
#define DISPATCH_HARNESS_ENGINE_H
class Engine;
#endif
'@ | Set-Content -LiteralPath (Join-Path $tempFDTD 'engine.h') -Encoding ascii

	$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
	$compiler = $null
	$useMsvc = $false
	if ($cl) {
		$compiler = $cl.Source
		$useMsvc = $true
	} else {
		$msvcRoot = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC'
		if (Test-Path -LiteralPath $msvcRoot -PathType Container) {
			$clPath = Get-ChildItem -LiteralPath $msvcRoot -Directory |
				Sort-Object { [version]$_.Name } -Descending |
				ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64\cl.exe' } |
				Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
				Select-Object -First 1
			if ($clPath) {
				$compiler = $clPath
				$useMsvc = $true
			}
		}
	}
	if (-not $compiler) {
		foreach ($name in @('clang++', 'g++', 'c++')) {
			$found = Get-Command $name -ErrorAction SilentlyContinue
			if ($found) {
				$compiler = $found.Source
				break
			}
		}
	}

	if ($useMsvc) {
		$searchDir = Split-Path $compiler -Parent
		$vsDevCmd = $null
		while ($searchDir -and -not $vsDevCmd) {
			$candidate = Join-Path $searchDir 'Common7\Tools\VsDevCmd.bat'
			if (Test-Path -LiteralPath $candidate -PathType Leaf) {
				$vsDevCmd = $candidate
			} else {
				$searchDir = Split-Path $searchDir -Parent
			}
		}
		if (-not $vsDevCmd -or -not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
			throw 'cl.exe is available, but VsDevCmd.bat could not be located to load its SDK environment.'
		}
		$envScript = Join-Path $tempRoot 'load-msvc-env.cmd'
		@"
@echo off
call "$vsDevCmd" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%
set
"@ | Set-Content -LiteralPath $envScript -Encoding ascii
		$environmentLines = & $env:ComSpec /d /c "`"$envScript`""
		if ($LASTEXITCODE -ne 0) {
			throw 'VsDevCmd.bat failed while preparing the native harness compiler environment.'
		}
		foreach ($line in $environmentLines) {
			if ($line -match '^([^=]+)=(.*)$') {
				[Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
			}
		}
	}
	if (-not $compiler) {
		throw 'A C++ compiler is required for this dependency-light harness; no compiler was found and nothing was installed.'
	}

	$harnessExe = Join-Path $tempRoot 'engine-extension-dispatch-harness.exe'
	$arguments = @()
	if ($useMsvc) {
		$arguments += @('/nologo', '/EHsc', '/std:c++14', "/I$tempExtensions", "/I$tempRoot", "/I$fdtdDir", $harnessPath,
			(Join-Path $tempExtensions 'engine_extension.cpp'), "/Fe:$harnessExe", "/Fo:$tempRoot\")
	} else {
		$arguments += @('-std=c++14', '-Wall', '-Wextra', "-I$tempExtensions", "-I$tempRoot", "-I$fdtdDir", $harnessPath,
			(Join-Path $tempExtensions 'engine_extension.cpp'), '-o', $harnessExe)
	}
	& $compiler @arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Native harness compilation failed with exit code $LASTEXITCODE."
	}
	& $harnessExe
	if ($LASTEXITCODE -ne 0) {
		throw "Native harness failed with exit code $LASTEXITCODE."
	}
} finally {
	Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
