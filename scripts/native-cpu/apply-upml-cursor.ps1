param(
	[Parameter(Mandatory = $true)] [string]$SourceRoot,
	[switch]$AllowKnownPhaseDispatchPatch
)

$ErrorActionPreference = 'Stop'
$ExpectedRevision = '08e15ff532a7f4cfd1d4e7164ec262f5187bf30e'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$patchFile = Join-Path $PSScriptRoot 'openems-cpu-upml-cursor.patch'
if (-not (Test-Path -LiteralPath $patchFile -PathType Leaf)) { throw "Cursor patch is missing: $patchFile" }

$head = & git -C $SourceRoot rev-parse HEAD 2>&1
if ($LASTEXITCODE -ne 0 -or ($head -join '').Trim() -ne $ExpectedRevision) {
	throw "Source must be based on $ExpectedRevision."
}
$statusLines = @(& git -C $SourceRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Could not read source status: $SourceRoot" }

$phasePaths = @(
	'FDTD/engine_multithread.cpp',
	'FDTD/engine_multithread.h',
	'FDTD/extensions/engine_extension_phase_dispatch.h'
) | Sort-Object
$allowKnownPhase = $false
if ($statusLines.Count -eq 0) {
	$allowKnownPhase = $false
}
elseif ($AllowKnownPhaseDispatchPatch) {
	$expectedStatus = @(
		' M FDTD/engine_multithread.cpp',
		' M FDTD/engine_multithread.h',
		'?? FDTD/extensions/engine_extension_phase_dispatch.h'
	) | Sort-Object
	$actualStatus = @($statusLines | Sort-Object)
	if (Compare-Object $expectedStatus $actualStatus -CaseSensitive) {
		throw 'The dirty source tree is not exactly the known phase-dispatch patch state.'
	}
	$expectedHashes = @{
		'FDTD/engine_multithread.cpp' = '1f5f0e1992ee577bb775a5cb3774819ee5992858c994bf9c9354b1afb8e2d8d5'
		'FDTD/engine_multithread.h' = 'eb60fe5e3804fe145ea4b379e6e3ff1c6dfc00fcfb9f606ad51e9c9dad8555b8'
		'FDTD/extensions/engine_extension_phase_dispatch.h' = '4c4cd3f9ae9097a13f1d23001f3c44166d9e3202e2282cbe91e8b99620b27a0e'
	}
	foreach ($relative in $phasePaths) {
		$path = Join-Path $SourceRoot ($relative -replace '/', '\')
		if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Known phase-patch file is missing: $relative" }
		$actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($actualHash -ne $expectedHashes[$relative]) { throw "Known phase-patch file changed: $relative" }
	}
	$allowKnownPhase = $true
}
else {
	throw 'Source must be clean. Use -AllowKnownPhaseDispatchPatch only for the exact frozen phase patch.'
}

$patchText = [IO.File]::ReadAllText($patchFile)
$patchPaths = @([regex]::Matches($patchText, '(?m)^\+\+\+ b/([^\r\n\t]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
$expectedPatchPaths = @(
	'FDTD/extensions/engine_ext_upml.cpp',
	'FDTD/extensions/engine_ext_upml.h',
	'FDTD/extensions/engine_ext_upml_sse_cursor.h'
) | Sort-Object
if (Compare-Object $expectedPatchPaths $patchPaths -CaseSensitive) { throw 'Cursor patch file list is not the reviewed three-file change.' }
foreach ($relative in $patchPaths) {
	if ($relative -in $phasePaths) { throw "Cursor patch overlaps the frozen phase-dispatch patch: $relative" }
}

& git -C $SourceRoot apply --check $patchFile
if ($LASTEXITCODE -ne 0) { throw 'Cursor patch does not apply cleanly; source was not changed.' }
& git -C $SourceRoot apply $patchFile
if ($LASTEXITCODE -ne 0) { throw 'Cursor patch application failed.' }

try {
	& git -C $SourceRoot diff --check
	if ($LASTEXITCODE -ne 0) { throw 'Cursor patch has whitespace errors.' }
	$headerWhitespace = Select-String -LiteralPath (Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_cursor.h') -Pattern '[ \t]+$'
	if ($headerWhitespace) { throw 'Cursor helper header has trailing whitespace.' }
	$cursorSource = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml.cpp'))
	$cursorHelper = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_cursor.h'))
	$requiredMarkers = @(
		'OPENEMS_EXPERIMENTAL_CPU_UPML_CURSOR',
		'Experimental UPML SSE cursor enabled',
		'IsExactUpmlSSECursorEngineType<Engine_sse, Engine_SSE_Compressed, Engine_Multithread>'
	)
	foreach ($marker in $requiredMarkers) {
		if (-not $cursorSource.Contains($marker) -and -not $cursorHelper.Contains($marker)) {
			throw "Applied source is missing expected cursor marker: $marker"
		}
	}
	if ($allowKnownPhase) {
		foreach ($relative in $phasePaths) {
			$path = Join-Path $SourceRoot ($relative -replace '/', '\')
			$actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
			if ($actualHash -ne $expectedHashes[$relative]) { throw "Phase-dispatch patch was altered: $relative" }
		}
	}
	Write-Output "Applied opt-in UPML cursor patch at pinned source $ExpectedRevision."
}
catch {
	& git -C $SourceRoot apply --reverse $patchFile
	if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not roll back the cursor patch after post-application validation failed.' }
	throw
}
