param(
	[Parameter(Mandatory = $true)] [string]$SourceRoot,
	[Parameter(Mandatory = $true)] [string]$CompilerPath
)

$ErrorActionPreference = 'Stop'
$ExpectedRevision = '08e15ff532a7f4cfd1d4e7164ec262f5187bf30e'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$CompilerPath = (Resolve-Path -LiteralPath $CompilerPath).Path
if (-not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw "Compiler executable is missing: $CompilerPath" }

$head = & git -C $SourceRoot rev-parse HEAD 2>&1
if ($LASTEXITCODE -ne 0 -or ($head -join '').Trim() -ne $ExpectedRevision) {
	throw "Harness source must be based on $ExpectedRevision."
}
$cursorHeader = Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_cursor.h'
if (-not (Test-Path -LiteralPath $cursorHeader -PathType Leaf)) { throw "Apply the UPML cursor patch first; missing $cursorHeader" }
$dispatchSource = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml.cpp'))
$expectedDispatchMarker = 'IsExactUpmlSSECursorEngineType<Engine_sse, Engine_SSE_Compressed, Engine_Multithread>'
if (-not $dispatchSource.Contains($expectedDispatchMarker)) {
	throw 'Production source does not contain the reviewed exact UPML engine allowlist.'
}
$harnessSource = Join-Path $PSScriptRoot 'tests\upml_cursor_harness.cpp'
if (-not (Test-Path -LiteralPath $harnessSource -PathType Leaf)) { throw "Harness source is missing: $harnessSource" }

$tempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("openems-upml-cursor-" + [Guid]::NewGuid().ToString('N'))))
$tempGuard = $tempBase + '\'
if (-not $tempRoot.StartsWith($tempGuard, [StringComparison]::OrdinalIgnoreCase)) {
	throw "Temporary output escaped the system temp directory: $tempRoot"
}
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$completed = $false

function Invoke-Native([string]$Name, [string]$Exe, [string[]]$CommandArguments, [string]$LogPath) {
	Write-Host "[$Name] $Exe $($CommandArguments -join ' ')"
	$previousErrorAction = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	$invocationError = $null
	try {
		& $Exe @CommandArguments 2>&1 | Tee-Object -FilePath $LogPath | Out-Host
		$exitCode = $LASTEXITCODE
	}
	catch {
		$invocationError = $_.Exception.Message
		$exitCode = -1
	}
	finally { $ErrorActionPreference = $previousErrorAction }
	if ($exitCode -ne 0) { throw "$Name failed with exit code $exitCode. $invocationError" }
}

try {
	foreach ($layout in @('ijk-n', 'n-ijk')) {
		$buildDirectory = Join-Path $tempRoot $layout
		New-Item -ItemType Directory -Path $buildDirectory | Out-Null
		$executable = Join-Path $buildDirectory 'upml_cursor_harness.exe'
		$compilerArguments = @(
			'/nologo', '/EHsc', '/std:c++14', '/W4', "/I$SourceRoot",
			"/Fo$buildDirectory\", "/Fe$executable", $harnessSource
		)
		if ($layout -eq 'n-ijk') { $compilerArguments += '/DOPENEMS_ENGINE_NIJK' }
		Invoke-Native "$layout-compile" $CompilerPath $compilerArguments (Join-Path $buildDirectory 'compile.log')
		if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Compiler did not produce $executable" }
		Invoke-Native "$layout-run" $executable @() (Join-Path $buildDirectory 'run.log')
	}
	$completed = $true
}
finally {
	$resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
	if (-not $resolvedTempRoot.StartsWith($tempGuard, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to remove a path outside the system temp directory: $resolvedTempRoot"
	}
	if ($completed -and (Test-Path -LiteralPath $resolvedTempRoot)) {
		Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
	}
	elseif (Test-Path -LiteralPath $resolvedTempRoot) {
		Write-Warning "Harness failed; compile/run logs retained at $resolvedTempRoot"
	}
}

Write-Output 'UPML cursor mapping and exact-type allowlist harness passed for both ArrayENG storage layouts.'