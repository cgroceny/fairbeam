param(
	[Parameter(Mandatory = $true)]
	[string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$expectedRevision = '08e15ff532a7f4cfd1d4e7164ec262f5187bf30e'
$patchPath = Join-Path $PSScriptRoot 'openems-cpu-phase-dispatch.patch'

$actualRevision = (& git -C $SourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
	throw "Could not read the source revision at $SourceRoot."
}
if ($actualRevision -ne $expectedRevision) {
	throw "Expected openEMS $expectedRevision, found $actualRevision. No files were changed."
}
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
	throw "Patch file is missing: $patchPath"
}

$dirty = & git -C $SourceRoot status --porcelain
if ($LASTEXITCODE -ne 0) {
	throw "Could not inspect the source worktree at $SourceRoot."
}
if ($dirty) {
	throw 'The source worktree must be clean before applying this experimental patch. No files were changed.'
}

& git -C $SourceRoot apply --check $patchPath
if ($LASTEXITCODE -ne 0) {
	throw 'The patch does not match the pinned source files. No files were changed.'
}
& git -C $SourceRoot apply $patchPath
if ($LASTEXITCODE -ne 0) {
	throw 'git apply failed. Inspect the source worktree before retrying.'
}
Write-Output "Applied experimental CPU phase dispatch to $SourceRoot at $expectedRevision. No commit was created."
