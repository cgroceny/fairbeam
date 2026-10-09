param([Parameter(Mandatory = $true)] [string]$SourceRoot)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$expectedRevision = '67d378488ee40de815eed00f8aaa808f0a9e3c6d'
$patchPath = Join-Path $PSScriptRoot 'openems-periodic-sheets.patch'
$revision = & git -C $SourceRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision.Trim() -ne $expectedRevision) {
    throw "Expected openEMS $expectedRevision. No files were changed."
}
$dirty = & git -C $SourceRoot status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $dirty) {
    throw 'The pinned source checkout must be clean. No files were changed.'
}
& git -C $SourceRoot apply --check $patchPath
if ($LASTEXITCODE -ne 0) { throw 'The patch does not match. No files were changed.' }
& git -C $SourceRoot apply --intent-to-add $patchPath
if ($LASTEXITCODE -ne 0) { throw 'git apply failed. Inspect the checkout before retrying.' }
Write-Output "Applied opt-in closed-alpha sheet patch at $expectedRevision; the new header is marked intent-to-add for diff auditing. No commit or runtime installation was made."
