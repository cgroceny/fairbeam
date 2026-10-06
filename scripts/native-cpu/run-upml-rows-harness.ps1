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
$rowHeader = Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_rows.h'
if (-not (Test-Path -LiteralPath $rowHeader -PathType Leaf)) { throw "Apply the UPML rows patch first; missing $rowHeader" }
$dispatchSource = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml.cpp'))
$requiredMarkers = @(
	'OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS',
	'IsExactUpmlSSECursorEngineType<Engine_sse, Engine_SSE_Compressed, Engine_Multithread>',
	'UpmlSSENIJKRow3<FDTD_FLOAT>',
	'TryDoPreVoltageUpdatesSSECursorRows',
	'TryDoPostVoltageUpdatesSSECursorRows',
	'TryDoPreCurrentUpdatesSSECursorRows',
	'TryDoPostCurrentUpdatesSSECursorRows',
	'LogUpmlSSERowsActivated(g_UpmlSSERowsActivateFlags[0], "pre-voltage")',
	'LogUpmlSSERowsActivated(g_UpmlSSERowsActivateFlags[1], "post-voltage")',
	'LogUpmlSSERowsActivated(g_UpmlSSERowsActivateFlags[2], "pre-current")',
	'LogUpmlSSERowsActivated(g_UpmlSSERowsActivateFlags[3], "post-current")',
	'LogUpmlSSERowsRejected(g_UpmlSSERowsRejectFlags[0], "pre-voltage")',
	'LogUpmlSSERowsRejected(g_UpmlSSERowsRejectFlags[1], "post-voltage")',
	'LogUpmlSSERowsRejected(g_UpmlSSERowsRejectFlags[2], "pre-current")',
	'LogUpmlSSERowsRejected(g_UpmlSSERowsRejectFlags[3], "post-current")'
)
foreach ($marker in $requiredMarkers) {
	if (-not $dispatchSource.Contains($marker)) { throw "Production UPML rows source is missing marker: $marker" }
}
$guardedAdvances = [regex]::Matches($dispatchSource, 'if \(loc_z \+ 1 < zCount\)').Count
if ($guardedAdvances -ne 4) { throw "Expected four terminal-pointer guards; found $guardedAdvances" }
$harnessSource = Join-Path $PSScriptRoot 'tests\upml_rows_harness.cpp'
if (-not (Test-Path -LiteralPath $harnessSource -PathType Leaf)) { throw "Harness source is missing: $harnessSource" }

$tempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("openems-upml-rows-" + [Guid]::NewGuid().ToString('N'))))
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
	$executable = Join-Path $tempRoot 'upml_rows_harness.exe'
	$compilerArguments = @(
		'/nologo', '/EHsc', '/std:c++14', '/W4', "/I$SourceRoot",
		"/Fo$tempRoot\", "/Fe$executable", $harnessSource
	)
	Invoke-Native 'rows-compile' $CompilerPath $compilerArguments (Join-Path $tempRoot 'compile.log')
	if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Compiler did not produce $executable" }
	Invoke-Native 'rows-run' $executable @() (Join-Path $tempRoot 'run.log')
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

Write-Output 'UPML row-pointer helper passed ArrayNIJK stride, empty-work, terminal-row, and bounds checks.'