param(
	[Parameter(Mandatory = $true)]
	[string]$VcpkgRoot,
	[Parameter(Mandatory = $true)]
	[string]$OverlayPortsRoot
)

$ErrorActionPreference = 'Stop'
$expectedVcpkgRevision = '37bb045f3c7a747d3e5d1c13b6fe6a0aec4b5d00'
$VcpkgRoot = (Resolve-Path -LiteralPath $VcpkgRoot).Path
$OverlayPortsRoot = [IO.Path]::GetFullPath($OverlayPortsRoot)

$actualRevision = (& git -C $VcpkgRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualRevision -ne $expectedVcpkgRevision) {
	throw "Expected vcpkg $expectedVcpkgRevision; found '$actualRevision'."
}
$dirty = & git -C $VcpkgRoot status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $dirty) {
	throw 'The pinned vcpkg checkout must be clean before preparing the overlay.'
}

$vcpkgPort = Join-Path $VcpkgRoot 'ports\vtk'
$overlayVtk = Join-Path $OverlayPortsRoot 'vtk'
if (-not (Test-Path -LiteralPath $vcpkgPort -PathType Container)) {
	throw "Pinned VTK port is missing: $vcpkgPort"
}
if (Test-Path -LiteralPath $OverlayPortsRoot) {
	throw "Overlay output already exists; choose a fresh scratch path: $OverlayPortsRoot"
}

$sourcePortfile = Join-Path $vcpkgPort 'portfile.cmake'
$sourceText = [IO.File]::ReadAllText($sourcePortfile) -replace "`r`n?", "`n"
$newline = "`n"
$oldGroup = @(
	'        -DVTK_GROUP_ENABLE_StandAlone=YES',
	'        -DVTK_GROUP_ENABLE_Rendering=YES',
	'        -DVTK_GROUP_ENABLE_Views=YES'
) -join $newline
$newGroup = @(
	'        # Study overlay: build only required native IO modules and transitive dependencies.',
	'        -DVTK_MODULE_ENABLE_VTK_IOXML=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOGeometry=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOLegacy=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOPLY=YES',
	'        -DVTK_GROUP_ENABLE_StandAlone=DONT_WANT',
	'        -DVTK_GROUP_ENABLE_Rendering=DONT_WANT',
	'        -DVTK_GROUP_ENABLE_Views=DONT_WANT'
) -join $newline

$matches = [regex]::Matches($sourceText, [regex]::Escape($oldGroup))
if ($matches.Count -ne 1) {
	throw "Expected exactly one pinned VTK group block, found $($matches.Count). Refusing to prepare an overlay."
}
$patchedText = $sourceText.Replace($oldGroup, $newGroup)

New-Item -ItemType Directory -Path $OverlayPortsRoot | Out-Null
Copy-Item -LiteralPath $vcpkgPort -Destination $overlayVtk -Recurse
[IO.File]::WriteAllText((Join-Path $overlayVtk 'portfile.cmake'), $patchedText, [Text.UTF8Encoding]::new($false))

$installedPortfile = [IO.File]::ReadAllText((Join-Path $overlayVtk 'portfile.cmake')) -replace "`r`n?", "`n"
if ($installedPortfile -cne $patchedText) {
	throw 'The VTK overlay differs from the expected pinned source transformation.'
}
$portHash = (Get-FileHash -LiteralPath (Join-Path $overlayVtk 'portfile.cmake') -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Prepared CPU-only VTK overlay at $overlayVtk from vcpkg $expectedVcpkgRevision."
Write-Output "Pinned overlay portfile SHA-256: $portHash"
