param(
	[Parameter(Mandatory = $true)] [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$ExpectedRevision = '08e15ff532a7f4cfd1d4e7164ec262f5187bf30e'
$ExpectedPatchSha256 = 'F7FC923AEA49BFFDD2241DA62A3C515CFD3C6EB90ADE06E2B29878318404655A'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$patchFile = Join-Path $PSScriptRoot 'openems-cpu-upml-rows.patch'
if (-not (Test-Path -LiteralPath $patchFile -PathType Leaf)) { throw "Rows patch is missing: $patchFile" }

$head = & git -C $SourceRoot rev-parse HEAD 2>&1
if ($LASTEXITCODE -ne 0 -or ($head -join '').Trim() -ne $ExpectedRevision) {
	throw "Source must be based on $ExpectedRevision."
}
$patchHash = (Get-FileHash -LiteralPath $patchFile -Algorithm SHA256).Hash.ToUpperInvariant()
if ($patchHash -ne $ExpectedPatchSha256) { throw "Rows patch hash mismatch: $patchHash" }

$expectedStatus = @(
	' M FDTD/engine_multithread.cpp',
	' M FDTD/engine_multithread.h',
	' M FDTD/extensions/engine_ext_upml.cpp',
	' M FDTD/extensions/engine_ext_upml.h',
	'?? FDTD/extensions/engine_ext_upml_sse_cursor.h',
	'?? FDTD/extensions/engine_extension_phase_dispatch.h'
) | Sort-Object
$actualStatus = @(& git -C $SourceRoot status --porcelain=v1 --untracked-files=all | Sort-Object)
if ($LASTEXITCODE -ne 0) { throw "Could not read source status: $SourceRoot" }
if (Compare-Object $expectedStatus $actualStatus -CaseSensitive) {
	throw 'Source must contain exactly the frozen phase-dispatch plus cursor patch state.'
}

$expectedBaseHashes = @{
	'FDTD/engine_multithread.cpp' = '1f5f0e1992ee577bb775a5cb3774819ee5992858c994bf9c9354b1afb8e2d8d5'
	'FDTD/engine_multithread.h' = 'eb60fe5e3804fe145ea4b379e6e3ff1c6dfc00fcfb9f606ad51e9c9dad8555b8'
	'FDTD/extensions/engine_extension_phase_dispatch.h' = '4c4cd3f9ae9097a13f1d23001f3c44166d9e3202e2282cbe91e8b99620b27a0e'
	'FDTD/extensions/engine_ext_upml.cpp' = '198ef7dc6205d250f16526579798798f156f560eaf94b2f01bd2dc84b8ab50aa'
	'FDTD/extensions/engine_ext_upml.h' = '3e3e5ab75282d1feb914ec81cbf1cd0d98401acaa4433fdcf05312e80eeef5e2'
	'FDTD/extensions/engine_ext_upml_sse_cursor.h' = '9c3bc2af156fdff0704fc2ba83b42d79343af971321c155417aa6b9bdb9fc954'
}
foreach ($relative in $expectedBaseHashes.Keys) {
	$path = Join-Path $SourceRoot ($relative -replace '/', '\')
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required phase/cursor source is missing: $relative" }
	$actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actualHash -ne $expectedBaseHashes[$relative]) { throw "Phase/cursor source changed: $relative" }
}

$patchText = [IO.File]::ReadAllText($patchFile)
$patchPaths = @([regex]::Matches($patchText, '(?m)^\+\+\+ b/([^\r\n\t]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
$expectedPatchPaths = @(
	'FDTD/extensions/engine_ext_upml.cpp',
	'FDTD/extensions/engine_ext_upml.h',
	'FDTD/extensions/engine_ext_upml_sse_rows.h'
) | Sort-Object
if (Compare-Object $expectedPatchPaths $patchPaths -CaseSensitive) { throw 'Rows patch file list is not the reviewed three-file change.' }

& git -C $SourceRoot apply --check $patchFile
if ($LASTEXITCODE -ne 0) { throw 'Rows patch does not apply cleanly; source was not changed.' }
& git -C $SourceRoot apply $patchFile
if ($LASTEXITCODE -ne 0) { throw 'Rows patch application failed.' }

try {
	& git -C $SourceRoot diff --check
	if ($LASTEXITCODE -ne 0) { throw 'Rows patch has whitespace errors.' }
	$cursorSource = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml.cpp'))
	$rowsHeader = [IO.File]::ReadAllText((Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_rows.h'))
	$requiredMarkers = @(
		'OPENEMS_EXPERIMENTAL_CPU_UPML_ROWS',
		'std::strcmp(setting, "rows") == 0',
		'IsExactUpmlSSECursorEngineType<Engine_sse, Engine_SSE_Compressed, Engine_Multithread>',
		'UpmlSSENIJKRow3<FDTD_FLOAT>',
		'array.linearIndex({0, x, y, 0})',
		'array.stride(3)',
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
		if (-not $cursorSource.Contains($marker) -and -not $rowsHeader.Contains($marker)) {
			throw "Applied source is missing expected rows marker: $marker"
		}
	}
	$boundedAdvances = [regex]::Matches($cursorSource, 'if \(loc_z \+ 1 < zCount\)').Count
	if ($boundedAdvances -ne 4) { throw "Expected four guarded row advances; found $boundedAdvances" }
	$headerWhitespace = Select-String -LiteralPath (Join-Path $SourceRoot 'FDTD\extensions\engine_ext_upml_sse_rows.h') -Pattern '[ \t]+$'
	if ($headerWhitespace) { throw 'Rows helper header has trailing whitespace.' }
	foreach ($relative in @('FDTD/engine_multithread.cpp','FDTD/engine_multithread.h','FDTD/extensions/engine_extension_phase_dispatch.h','FDTD/extensions/engine_ext_upml_sse_cursor.h')) {
		$path = Join-Path $SourceRoot ($relative -replace '/', '\')
		$actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
		if ($actualHash -ne $expectedBaseHashes[$relative]) { throw "Frozen phase/cursor file changed: $relative" }
	}
	Write-Output "Applied experimental UPML row-pointer patch at pinned source $ExpectedRevision. Set both the cursor and rows opt-ins before loading the native runtime."
}
catch {
	& git -C $SourceRoot apply --reverse $patchFile
	if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not roll back the rows patch after post-application validation failed.' }
	throw
}