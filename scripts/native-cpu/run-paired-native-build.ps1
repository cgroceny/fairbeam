param(
	[Parameter(Mandatory = $true)] [string]$StudyRoot,
	[Parameter(Mandatory = $true)] [string]$RunName,
	[Parameter(Mandatory = $true)] [string]$VcpkgRoot,
	[Parameter(Mandatory = $true)] [string]$VcpkgManifestRoot,
	[Parameter(Mandatory = $true)] [string]$VcpkgTripletsRoot,
	[Parameter(Mandatory = $true)] [string]$VcpkgOverlayPortsRoot,
	[Parameter(Mandatory = $true)] [string]$VcpkgInstalledRoot,
	[Parameter(Mandatory = $true)] [string]$FParserSource,
	[Parameter(Mandatory = $true)] [string]$CSXCADSource,
	[Parameter(Mandatory = $true)] [string]$BaselineSource,
	[Parameter(Mandatory = $true)] [string]$CandidateSource,
	[Parameter(Mandatory = $true)] [string]$CMakeExe,
	[Parameter(Mandatory = $true)] [string]$NinjaExe,
	[Parameter(Mandatory = $true)] [string]$ClExe
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OpenEMSRevision = '08e15ff532a7f4cfd1d4e7164ec262f5187bf30e'
$VcpkgRevision = '37bb045f3c7a747d3e5d1c13b6fe6a0aec4b5d00'
$FParserRevision = '4b9c845b449b520c4b8c5f23c74cd04820084f81'
$CSXCADRevision = '1ceb60bbdd0c0ac975025a8f71df7279791804ce'
$TargetTriplet = 'x64-windows-cpu-study'
$HostTriplet = 'x64-windows'
$Jobs = '2'
$ReleaseCFlags = '/MD /O2 /Ob2 /DNDEBUG /fp:precise'
$ReleaseCxxFlags = '/MD /O2 /Ob2 /DNDEBUG /fp:precise'
$Commands = @()

function Resolve-Dir([string]$Path, [string]$Label) {
	if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label directory is missing: $Path" }
	return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-Exe([string]$Path, [string]$Label) {
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label executable is missing: $Path" }
	return (Resolve-Path -LiteralPath $Path).Path
}

function Hash-File([string]$Path) {
	return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Hash-Text([string]$Text) {
	$sha = [Security.Cryptography.SHA256]::Create()
	try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
	finally { $sha.Dispose() }
}

function Normalize-LF([string]$Text) { return ($Text -replace "`r`n?", "`n") }

function Git-Text([string]$Root, [string[]]$Arguments) {
	$result = & git -C $Root @Arguments 2>&1
	if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed in ${Root}: $($result -join ' ')" }
	return ($result -join "`n").Trim()
}

function Check-Revision([string]$Root, [string]$Expected, [string]$Label) {
	$actual = Git-Text $Root @('rev-parse', 'HEAD')
	if ($actual -ne $Expected) { throw "$Label must be $Expected; found $actual." }
}

function Check-Clean([string]$Root, [string]$Label) {
	$changes = Git-Text $Root @('status', '--porcelain=v1', '--untracked-files=all')
	if ($changes) { throw "$Label must be clean; found local changes:`n$changes" }
}

function Check-Under([string]$Parent, [string]$Child) {
	$parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
	$childPath = [IO.Path]::GetFullPath($Child)
	if (-not $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Build output must remain under $Parent; got $Child"
	}
}

function Save-Provenance {
	if (-not $script:ProvenanceFile -or -not $script:provenance) { return }
	$script:provenance.updatedUtc = [DateTime]::UtcNow.ToString('o')
	$script:provenance.commands = @($script:Commands)
	$script:provenance | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $script:ProvenanceFile -Encoding UTF8
}

function Set-RunStep([string]$Step) {
	if ($script:provenance.status -eq 'preflight-passed') { $script:provenance.status = 'running' }
	$script:provenance.currentStep = $Step
	Save-Provenance
}

function Save-Commands {
	$script:Commands | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:CommandsFile -Encoding UTF8
}

function Invoke-Logged([string]$Name, [string]$Exe, [string[]]$CommandArguments) {
	$log = Join-Path $LogsRoot "$Name.log"
	$commandRecord = [ordered]@{ name = $Name; exe = $Exe; args = @($CommandArguments); log = $log; status = 'running'; startedUtc = [DateTime]::UtcNow.ToString('o') }
	$script:Commands += ,$commandRecord
	Set-RunStep $Name
	Save-Commands
	Write-Host "[$Name] $Exe $($CommandArguments -join ' ')"
	$previousErrorAction = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try {
		& $Exe @CommandArguments 2>&1 | Tee-Object -FilePath $log | Out-Host
		$exitCode = $LASTEXITCODE
	}
	catch {
		$invocationError = $_.Exception.Message
		$exitCode = -1
	}
	finally { $ErrorActionPreference = $previousErrorAction }
	if ($exitCode -ne 0) {
		$commandRecord.status = 'failed'
		$commandRecord.exitCode = $exitCode
		$commandRecord.error = $invocationError
		$commandRecord.completedUtc = [DateTime]::UtcNow.ToString('o')
		Save-Provenance
		Save-Commands
		throw "$Name failed with exit code $exitCode. See $log"
	}
	$commandRecord.status = 'complete'
	$commandRecord.exitCode = $exitCode
	$commandRecord.completedUtc = [DateTime]::UtcNow.ToString('o')
	Save-Provenance
	Save-Commands
}

function Get-Cache([string]$Path) {
	$cache = @{}
	foreach ($line in Get-Content -LiteralPath $Path) {
		if ($line.StartsWith('#') -or $line.StartsWith('//') -or -not $line.Contains('=')) { continue }
		$equals = $line.IndexOf('=')
		$left = $line.Substring(0, $equals)
		$colon = $left.IndexOf(':')
		if ($colon -ge 0) { $cache[$left.Substring(0, $colon)] = $line.Substring($equals + 1) }
	}
	return $cache
}

function Check-CacheValue([hashtable]$Cache, [string]$Key, [string]$Expected, [string]$Label) {
	if (-not $Cache.ContainsKey($Key)) {
		$actual = if ($Cache.ContainsKey($Key)) { [string]$Cache[$Key] } else { '<missing>' }
		throw "$Label CMake cache $Key='$actual'; expected '$Expected'."
	}
	$actual = [string]$Cache[$Key]
	if ($Key -in @('CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_MAKE_PROGRAM', 'CMAKE_TOOLCHAIN_FILE')) {
		$actualPath = [IO.Path]::GetFullPath($actual.Replace('/', '\'))
		$expectedPath = [IO.Path]::GetFullPath($Expected.Replace('/', '\'))
		if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
			throw "$Label CMake cache $Key='$actual'; expected '$Expected'."
		}
		return
	}
	if ($actual -ine $Expected) { throw "$Label CMake cache $Key='$actual'; expected '$Expected'." }
}

function Check-CachePrefix([hashtable]$Cache, [string]$Key, [string]$Prefix, [string]$Label) {
	if (-not $Cache.ContainsKey($Key)) { throw "$Label CMake cache is missing $Key." }
	$value = [IO.Path]::GetFullPath([string]$Cache[$Key]).TrimEnd('\')
	$root = [IO.Path]::GetFullPath($Prefix).TrimEnd('\')
	if (-not $value.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and
		-not $value.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
		throw "$Label resolved $Key outside the prepared prefix: $value"
	}
}

function Configure-BuildInstall([string]$Name, [string]$Source, [string]$Build, [string]$Prefix, [string[]]$SpecificArgs) {
	$common = @(
		'-S', $Source, '-B', $Build, '-G', 'Ninja',
		"-DCMAKE_MAKE_PROGRAM=$NinjaExe",
		"-DCMAKE_C_COMPILER=$ClExe",
		"-DCMAKE_CXX_COMPILER=$ClExe",
		'-DCMAKE_BUILD_TYPE=Release',
		'-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON',
		"-DCMAKE_INSTALL_PREFIX=$Prefix",
		'-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
		"-DCMAKE_C_FLAGS_RELEASE=$ReleaseCFlags",
		"-DCMAKE_CXX_FLAGS_RELEASE=$ReleaseCxxFlags",
		"-DCMAKE_TOOLCHAIN_FILE=$VcpkgToolchain",
		'-DVCPKG_MANIFEST_MODE=OFF',
		"-DVCPKG_INSTALLED_DIR=$VcpkgInstalledRoot",
		"-DVCPKG_TARGET_TRIPLET=$TargetTriplet",
		"-DVCPKG_HOST_TRIPLET=$HostTriplet",
		"-DVCPKG_OVERLAY_PORTS=$VcpkgOverlayPortsRoot",
		"-DVCPKG_OVERLAY_TRIPLETS=$VcpkgTripletsRoot",
		'-DCMAKE_FIND_USE_PACKAGE_REGISTRY=FALSE',
		'-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=FALSE'
	) + $SpecificArgs
	# CMake's package wrappers evaluate path arguments; native backslashes can
	# become escapes such as \a in a nested find_package call.
	$common = @($common | ForEach-Object { $_.Replace('\', '/') })
	Invoke-Logged "$Name-configure" $CMakeExe $common

	$cachePath = Join-Path $Build 'CMakeCache.txt'
	$cache = Get-Cache $cachePath
	Check-CacheValue $cache 'CMAKE_BUILD_TYPE' 'Release' $Name
	Check-CacheValue $cache 'CMAKE_C_COMPILER' $ClExe $Name
	Check-CacheValue $cache 'CMAKE_CXX_COMPILER' $ClExe $Name
	Check-CacheValue $cache 'CMAKE_MAKE_PROGRAM' $NinjaExe $Name
	Check-CacheValue $cache 'CMAKE_C_FLAGS_RELEASE' $ReleaseCFlags $Name
	Check-CacheValue $cache 'CMAKE_CXX_FLAGS_RELEASE' $ReleaseCxxFlags $Name
	Check-CacheValue $cache 'VCPKG_TARGET_TRIPLET' $TargetTriplet $Name
	Check-CacheValue $cache 'VCPKG_MANIFEST_MODE' 'OFF' $Name

	Invoke-Logged "$Name-build" $CMakeExe @('--build', $Build, '--config', 'Release', '--parallel', $Jobs, '--verbose')
	Invoke-Logged "$Name-install" $CMakeExe @('--install', $Build, '--config', 'Release', '--prefix', $Prefix)
	return [ordered]@{
		name = $Name
		source = $Source
		build = $Build
		installPrefix = $Prefix
		configureArgs = $common
		cacheSha256 = (Hash-File $cachePath)
		compileCommandsSha256 = (Hash-File (Join-Path $Build 'compile_commands.json'))
	}
}

function Find-CMakeConfig([string]$Root, [string]$FileName) {
	$match = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $FileName -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1
	if (-not $match -and $FileName.EndsWith('Config.cmake')) {
		$alternate = $FileName.Substring(0, $FileName.Length - 'Config.cmake'.Length).ToLowerInvariant() + '-config.cmake'
		$match = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $alternate -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1
	}
	if (-not $match) { throw "Missing $FileName under $Root" }
	return $match.FullName
}

function Copy-Dlls([string]$From, [string]$To) {
	if (-not (Test-Path -LiteralPath $From -PathType Container)) { throw "Runtime DLL source missing: $From" }
	Get-ChildItem -LiteralPath $From -File -Filter '*.dll' | ForEach-Object {
		$destination = Join-Path $To $_.Name
		if (Test-Path -LiteralPath $destination -PathType Leaf) {
			if ((Hash-File $_.FullName) -ne (Hash-File $destination)) { throw "Conflicting runtime DLL name: $destination" }
		}
		else { Copy-Item -LiteralPath $_.FullName -Destination $destination }
	}
}

if ($RunName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'RunName must be 1-64 simple filename characters.' }
$StudyRoot = Resolve-Dir $StudyRoot 'Study root'
$VcpkgRoot = Resolve-Dir $VcpkgRoot 'vcpkg source'
$VcpkgManifestRoot = Resolve-Dir $VcpkgManifestRoot 'vcpkg manifest'
$VcpkgTripletsRoot = Resolve-Dir $VcpkgTripletsRoot 'vcpkg triplets'
$VcpkgOverlayPortsRoot = Resolve-Dir $VcpkgOverlayPortsRoot 'vcpkg overlay ports'
$VcpkgInstalledRoot = Resolve-Dir $VcpkgInstalledRoot 'vcpkg installed root'
$FParserSource = Resolve-Dir $FParserSource 'fparser source'
$CSXCADSource = Resolve-Dir $CSXCADSource 'CSXCAD source'
$BaselineSource = Resolve-Dir $BaselineSource 'baseline openEMS source'
$CandidateSource = Resolve-Dir $CandidateSource 'candidate openEMS source'
$CMakeExe = Resolve-Exe $CMakeExe 'CMake'
$NinjaExe = Resolve-Exe $NinjaExe 'Ninja'
$ClExe = Resolve-Exe $ClExe 'MSVC compiler'

foreach ($path in @($VcpkgManifestRoot, $VcpkgTripletsRoot, $VcpkgOverlayPortsRoot, $VcpkgInstalledRoot, $FParserSource, $CSXCADSource)) {
	Check-Under $StudyRoot $path
}
if ($BaselineSource.Equals($CandidateSource, [StringComparison]::OrdinalIgnoreCase)) { throw 'Baseline and candidate must be separate checkouts.' }

Check-Revision $VcpkgRoot $VcpkgRevision 'vcpkg source'
Check-Clean $VcpkgRoot 'vcpkg source'
Check-Revision $FParserSource $FParserRevision 'fparser source'
Check-Clean $FParserSource 'fparser source'
Check-Revision $CSXCADSource $CSXCADRevision 'CSXCAD source'
Check-Clean $CSXCADSource 'CSXCAD source'
Check-Revision $BaselineSource $OpenEMSRevision 'baseline openEMS source'
Check-Clean $BaselineSource 'baseline openEMS source'
Check-Revision $CandidateSource $OpenEMSRevision 'candidate openEMS source'
$expectedCandidate = @('FDTD/engine_multithread.cpp', 'FDTD/engine_multithread.h', 'FDTD/extensions/engine_extension_phase_dispatch.h') | Sort-Object
$candidateStatusLines = & git -C $CandidateSource status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw "Could not read candidate status: $CandidateSource" }
$candidateStatus = $candidateStatusLines -join "`n"
$actualCandidate = @($candidateStatusLines | Where-Object { $_ } | ForEach-Object { ([string]$_).Substring(3).Trim() } | Sort-Object)
if (Compare-Object $expectedCandidate $actualCandidate) { throw "Candidate must contain only the pinned phase-dispatch patch files:`n$candidateStatus" }
foreach ($source in @($BaselineSource, $CandidateSource)) {
	if (Test-Path -LiteralPath (Join-Path $source 'localConfig.cmake')) { throw "Remove localConfig.cmake before building: $source" }
}
$candidateCode = [IO.File]::ReadAllText((Join-Path $CandidateSource 'FDTD\engine_multithread.cpp'))
foreach ($marker in @('OPENEMS_EXPERIMENTAL_CPU_PHASE_DISPATCH', 'phase-lists', 'Experimental CPU phase dispatch enabled')) {
	if (-not $candidateCode.Contains($marker)) { throw "Candidate patch is missing expected opt-in marker: $marker" }
}

$manifest = Join-Path $VcpkgManifestRoot 'vcpkg.json'
$lock = Join-Path $VcpkgManifestRoot 'vcpkg-lock.json'
$triplet = Join-Path $VcpkgTripletsRoot "$TargetTriplet.cmake"
$status = Join-Path $VcpkgInstalledRoot 'vcpkg\status'
$vcpkgToolchain = Join-Path $VcpkgRoot 'scripts\buildsystems\vcpkg.cmake'
$targetPrefix = Join-Path $VcpkgInstalledRoot $TargetTriplet
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Prepared manifest must exist under $VcpkgManifestRoot" }
if ((Normalize-LF ([IO.File]::ReadAllText($manifest))) -cne (Normalize-LF ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'vcpkg.json'))))) { throw 'Prepared manifest differs from checked-in scripts/native-cpu/vcpkg.json.' }
if (-not (Test-Path -LiteralPath $triplet -PathType Leaf) -or
	(Normalize-LF ([IO.File]::ReadAllText($triplet))) -cne (Normalize-LF ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'triplets\x64-windows-cpu-study.cmake'))))) {
	throw 'Prepared triplet differs from the checked-in CPU study triplet.'
}
if (-not (Test-Path -LiteralPath $vcpkgToolchain -PathType Leaf) -or -not (Test-Path -LiteralPath $status -PathType Leaf)) { throw 'vcpkg toolchain or installed status file is missing.' }
$statusText = [IO.File]::ReadAllText($status)
foreach ($package in @('boost-thread', 'boost-date-time', 'boost-serialization', 'boost-chrono', 'boost-program-options', 'boost-algorithm', 'boost-fusion', 'boost-predef', 'tinyxml', 'hdf5', 'vtk', 'cgal', 'gmp', 'mpfr')) {
	if ($statusText -notmatch "(?m)^Package: $([regex]::Escape($package))$") { throw "Prepared vcpkg prefix is missing package $package." }
}

$overlayVtk = Join-Path $VcpkgOverlayPortsRoot 'vtk'
$baseVtk = Join-Path $VcpkgRoot 'ports\vtk'
$basePort = Normalize-LF ([IO.File]::ReadAllText((Join-Path $baseVtk 'portfile.cmake')))
$overlayPort = Normalize-LF ([IO.File]::ReadAllText((Join-Path $overlayVtk 'portfile.cmake')))
$oldBlock = @('        -DVTK_GROUP_ENABLE_StandAlone=YES', '        -DVTK_GROUP_ENABLE_Rendering=YES', '        -DVTK_GROUP_ENABLE_Views=YES') -join "`n"
$newBlock = @(
	'        # Study overlay: build only required native IO modules and transitive dependencies.',
	'        -DVTK_MODULE_ENABLE_VTK_IOXML=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOGeometry=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOLegacy=YES',
	'        -DVTK_MODULE_ENABLE_VTK_IOPLY=YES',
	'        -DVTK_GROUP_ENABLE_StandAlone=DONT_WANT',
	'        -DVTK_GROUP_ENABLE_Rendering=DONT_WANT',
	'        -DVTK_GROUP_ENABLE_Views=DONT_WANT'
) -join "`n"
if ([regex]::Matches($basePort, [regex]::Escape($oldBlock)).Count -ne 1 -or $overlayPort -cne $basePort.Replace($oldBlock, $newBlock)) {
	throw 'VTK overlay is not the single reviewed module-selection change on the pinned port.'
}
$overlayFiles = @(Get-ChildItem -LiteralPath $overlayVtk -File -Recurse -Force | ForEach-Object { $_.FullName.Substring($overlayVtk.Length + 1).Replace('\', '/') } | Sort-Object)
$baseFiles = @(Get-ChildItem -LiteralPath $baseVtk -File -Recurse -Force | ForEach-Object { $_.FullName.Substring($baseVtk.Length + 1).Replace('\', '/') } | Sort-Object)
if (Compare-Object $baseFiles $overlayFiles) { throw 'VTK overlay file list differs from the pinned port.' }
foreach ($relative in $baseFiles | Where-Object { $_ -ne 'portfile.cmake' }) {
	if ((Hash-File (Join-Path $baseVtk ($relative -replace '/', '\'))) -ne (Hash-File (Join-Path $overlayVtk ($relative -replace '/', '\')))) { throw "VTK overlay changes unexpected file $relative" }
}

$boostConfig = Find-CMakeConfig $targetPrefix 'BoostConfig.cmake'
$vtkConfig = Find-CMakeConfig $targetPrefix 'VTKConfig.cmake'
$cgalConfig = Find-CMakeConfig $targetPrefix 'CGALConfig.cmake'
foreach ($required in @((Join-Path $targetPrefix 'include\boost\version.hpp'), (Join-Path $targetPrefix 'include\hdf5.h'))) {
	if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required dependency header missing: $required" }
}
$tinyXmlHeaders = @((Join-Path $targetPrefix 'include\tinyxml.h'), (Join-Path $targetPrefix 'include\tinyxml\tinyxml.h'))
$tinyXmlLibs = @(Get-ChildItem -LiteralPath (Join-Path $targetPrefix 'lib') -File -Filter 'tinyxml*.lib' -ErrorAction SilentlyContinue)
if (-not ($tinyXmlHeaders | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) -or $tinyXmlLibs.Count -eq 0) { throw 'TinyXML development header/library missing from prepared target prefix.' }

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
	$cmakeVersionLines = & $CMakeExe --version 2>&1
	$cmakeExitCode = $LASTEXITCODE
	$ninjaVersion = ((& $NinjaExe --version 2>&1) -join "`n").Trim()
	$ninjaExitCode = $LASTEXITCODE
	$clVersion = (& $ClExe /Bv /? 2>&1) -join "`n"
	$clExitCode = $LASTEXITCODE
}
finally { $ErrorActionPreference = $previousErrorAction }
$cmakeVersion = $cmakeVersionLines -join "`n"
if ($cmakeExitCode -ne 0 -or $cmakeVersion -notmatch 'cmake version 3\.29\.5') { throw "Use CMake 3.29.5; found $($cmakeVersion -split "`n" | Select-Object -First 1)" }
if ($ninjaExitCode -ne 0) { throw 'Could not read Ninja version.' }
if ($clExitCode -ne 0 -or $clVersion -notmatch '19\.42\.') { throw 'The native study requires MSVC 14.42 / compiler 19.42.' }

$BuildRoot = Join-Path (Join-Path $StudyRoot 'builds') $RunName
$StageRoot = Join-Path (Join-Path $StudyRoot 'stages') $RunName
$LogsRoot = Join-Path (Join-Path $StudyRoot 'results') (Join-Path $RunName 'logs')
$ResultRoot = Split-Path -Parent $LogsRoot
$NativePrefix = Join-Path (Join-Path $StudyRoot 'native-deps') $RunName
foreach ($path in @($BuildRoot, $StageRoot, $ResultRoot, $NativePrefix)) {
	Check-Under $StudyRoot $path
	if (Test-Path -LiteralPath $path) { throw "Output path exists; use a fresh RunName and preserve existing evidence: $path" }
}
New-Item -ItemType Directory -Path $BuildRoot, $StageRoot, $LogsRoot, $NativePrefix | Out-Null
$CommandsFile = Join-Path $ResultRoot 'commands.json'

$patchFile = Join-Path $PSScriptRoot 'openems-cpu-phase-dispatch.patch'
if (-not (Test-Path -LiteralPath $patchFile -PathType Leaf)) { throw "Pinned source patch missing: $patchFile" }
$patchHash = Hash-File $patchFile
$candidateFiles = @()
foreach ($relative in $expectedCandidate) {
	$full = Join-Path $CandidateSource ($relative -replace '/', '\')
	$candidateFiles += [ordered]@{ path = $relative; sha256 = (Hash-File $full) }
}
$overlayEntries = @()
foreach ($file in Get-ChildItem -LiteralPath $VcpkgOverlayPortsRoot -File -Recurse -Force | Sort-Object FullName) {
	$relative = $file.FullName.Substring($VcpkgOverlayPortsRoot.Length + 1).Replace('\', '/')
	$overlayEntries += "$relative`t$(Hash-File $file.FullName)"
}
$overlayHash = Hash-Text ($overlayEntries -join "`n")
$provenance = [ordered]@{
	status = 'preflight-passed'
	createdUtc = [DateTime]::UtcNow.ToString('o')
	currentStep = 'preflight-complete'
	completedStages = @()
	builds = @()
	studyRoot = $StudyRoot
	runName = $RunName
	buildType = 'Release'
	parallelJobs = 2
	cuda = 'OFF'
	flushToZero = 'ON'
	floatPoint = [ordered]@{ CFlagsRelease = $ReleaseCFlags; CxxFlagsRelease = $ReleaseCxxFlags; fastMath = $false }
	compiler = [ordered]@{ cmakePath = $CMakeExe; cmakeVersion = $cmakeVersion; ninjaPath = $NinjaExe; ninjaVersion = $ninjaVersion; clPath = $ClExe; clVersion = $clVersion }
	sources = [ordered]@{
		vcpkg = [ordered]@{ root = $VcpkgRoot; revision = $VcpkgRevision }
		fparser = [ordered]@{ root = $FParserSource; revision = $FParserRevision }
		CSXCAD = [ordered]@{ root = $CSXCADSource; revision = $CSXCADRevision }
		openEMSBaseline = [ordered]@{ root = $BaselineSource; revision = $OpenEMSRevision }
		openEMSCandidate = [ordered]@{ root = $CandidateSource; revision = $OpenEMSRevision; files = $candidateFiles; dispatchPatchSha256 = $patchHash }
	}
	dependencies = [ordered]@{
		manifest = [ordered]@{
			path = $manifest
			sha256 = (Hash-File $manifest)
			lockPath = $(if (Test-Path -LiteralPath $lock -PathType Leaf) { $lock } else { $null })
			lockSha256 = $(if (Test-Path -LiteralPath $lock -PathType Leaf) { Hash-File $lock } else { $null })
		}
		triplet = [ordered]@{ path = $triplet; sha256 = (Hash-File $triplet) }
		installedStatus = [ordered]@{ path = $status; sha256 = (Hash-File $status) }
		overlayPorts = [ordered]@{ root = $VcpkgOverlayPortsRoot; sha256 = $overlayHash; files = $overlayEntries }
		targetTriplet = $TargetTriplet
		hostTriplet = $HostTriplet
		targetPrefix = $targetPrefix
		BoostConfig = $boostConfig
		VTKConfig = $vtkConfig
		CGALConfig = $cgalConfig
	}
	outputs = [ordered]@{ builds = $BuildRoot; stages = $StageRoot; results = $ResultRoot; nativePrefix = $NativePrefix }
	commands = $Commands
}
$script:provenance = $provenance
$script:ProvenanceFile = Join-Path $ResultRoot 'provenance.json'
Save-Provenance
Write-Output "Preflight passed for $RunName. Sequential build output will be under $StudyRoot."

try {
$CMakePrefix = "$targetPrefix;$NativePrefix"
$CMakeCommon = @(
	"-DCMAKE_TOOLCHAIN_FILE=$vcpkgToolchain",
	"-DCMAKE_PREFIX_PATH=$CMakePrefix",
	"-DTinyXML_ROOT_DIR=$targetPrefix",
	"-DHDF5_ROOT=$targetPrefix",
	"-DBoost_DIR=$(Split-Path -Parent $boostConfig)",
	"-DVTK_DIR=$(Split-Path -Parent $vtkConfig)",
	"-DCGAL_DIR=$(Split-Path -Parent $cgalConfig)",
	'-DBoost_USE_STATIC_LIBS=OFF',
	'-DBoost_USE_STATIC_RUNTIME=OFF'
)
$FParserBuild = Join-Path $BuildRoot 'fparser'
$CSXCADBuild = Join-Path $BuildRoot 'CSXCAD'
$BaselineBuild = Join-Path $BuildRoot 'baseline'
$CandidateBuild = Join-Path $BuildRoot 'candidate'
$BaselineStage = Join-Path $StageRoot 'baseline'
$CandidateStage = Join-Path $StageRoot 'candidate'

$fparserResult = Configure-BuildInstall 'fparser' $FParserSource $FParserBuild $NativePrefix ($CMakeCommon + @("-DCMAKE_PREFIX_PATH=$targetPrefix"))
foreach ($file in @('include\fparser.hh', 'lib\fparser.lib', 'bin\fparser.dll')) {
	if (-not (Test-Path -LiteralPath (Join-Path $NativePrefix $file) -PathType Leaf)) { throw "fparser install is incomplete: $file" }
}
$provenance.builds += ,$fparserResult
$provenance.completedStages += 'fparser'
$provenance.currentStep = 'fparser-installed'
Save-Provenance
$csxcadResult = Configure-BuildInstall 'CSXCAD' $CSXCADSource $CSXCADBuild $NativePrefix ($CMakeCommon + @("-DFPARSER_ROOT_DIR=$NativePrefix"))
foreach ($file in @('include\CSXCAD\ContinuousStructure.h', 'lib\CSXCAD.lib', 'bin\CSXCAD.dll')) {
	if (-not (Test-Path -LiteralPath (Join-Path $NativePrefix $file) -PathType Leaf)) { throw "CSXCAD install is incomplete: $file" }
}
$provenance.builds += ,$csxcadResult
$provenance.completedStages += 'CSXCAD'
$provenance.currentStep = 'CSXCAD-installed'
Save-Provenance

$openEMSArgs = $CMakeCommon + @(
	'-DENABLE_CUDA=OFF',
	'-DENABLE_FLUSH_TO_ZERO=ON',
	"-DCSXCAD_ROOT_DIR=$NativePrefix",
	"-DFPARSER_ROOT_DIR=$NativePrefix"
)
$baselineResult = Configure-BuildInstall 'baseline' $BaselineSource $BaselineBuild $BaselineStage $openEMSArgs
$provenance.builds += ,$baselineResult
$provenance.completedStages += 'baseline'
$provenance.currentStep = 'baseline-installed'
Save-Provenance
$candidateResult = Configure-BuildInstall 'candidate' $CandidateSource $CandidateBuild $CandidateStage $openEMSArgs
$provenance.builds += ,$candidateResult
$provenance.completedStages += 'candidate'
$provenance.currentStep = 'candidate-installed'
Save-Provenance

$provenance.currentStep = 'paired-cache-check'
Save-Provenance
$baselineCache = Get-Cache (Join-Path $BaselineBuild 'CMakeCache.txt')
$candidateCache = Get-Cache (Join-Path $CandidateBuild 'CMakeCache.txt')
foreach ($key in @('CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_MAKE_PROGRAM', 'CMAKE_C_FLAGS_RELEASE', 'CMAKE_CXX_FLAGS_RELEASE', 'VCPKG_TARGET_TRIPLET', 'ENABLE_CUDA', 'ENABLE_FLUSH_TO_ZERO', 'Boost_DIR', 'VTK_DIR', 'CGAL_DIR', 'CSXCAD_ROOT_DIR', 'FPARSER_ROOT_DIR')) {
	Check-CacheValue $baselineCache $key ([string]$candidateCache[$key]) 'candidate'
}
foreach ($spec in @(@('Boost_DIR', $targetPrefix), @('VTK_DIR', $targetPrefix), @('CGAL_DIR', $targetPrefix), @('CSXCAD_ROOT_DIR', $NativePrefix), @('FPARSER_ROOT_DIR', $NativePrefix))) {
	Check-CachePrefix $baselineCache $spec[0] $spec[1] 'baseline'
	Check-CachePrefix $candidateCache $spec[0] $spec[1] 'candidate'
}

foreach ($stage in @($BaselineStage, $CandidateStage)) {
	$provenance.currentStep = "stage-runtime:$([IO.Path]::GetFileName($stage))"
	Save-Provenance
	$bin = Join-Path $stage 'bin'
	if (-not (Test-Path -LiteralPath (Join-Path $bin 'openEMS.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $bin 'openEMS.dll') -PathType Leaf)) { throw "openEMS install is missing from $bin" }
	Copy-Dlls (Join-Path $NativePrefix 'bin') $bin
	Copy-Dlls (Join-Path $targetPrefix 'bin') $bin
	$stageName = [IO.Path]::GetFileName($stage)
	$provenance.completedStages += "$stageName-stage"
	$provenance.currentStep = "$stageName-stage-complete"
	Save-Provenance
}

$provenance.currentStep = 'hash-stage-artifacts'
Save-Provenance
$binaryRecords = @()
$libraryRecords = @()
$executableRecords = @()
foreach ($stage in @('baseline', 'candidate')) {
	$stagePath = Join-Path $StageRoot $stage
	$bin = Join-Path $stagePath 'bin'
	foreach ($required in @('openEMS.exe', 'nf2ff.exe', 'openEMS.dll', 'nf2ff.dll', 'CSXCAD.dll', 'fparser.dll')) {
		if (-not (Test-Path -LiteralPath (Join-Path $bin $required) -PathType Leaf)) { throw "Staged runtime is missing $(Join-Path $bin $required)" }
	}
	foreach ($file in Get-ChildItem -LiteralPath $bin -File -Filter '*.dll' -Recurse | Sort-Object FullName) {
		$binaryRecords += [ordered]@{ stage = $stage; path = $file.FullName; sha256 = (Hash-File $file.FullName) }
	}
	foreach ($file in @('openEMS.exe', 'nf2ff.exe')) {
		$path = Join-Path $bin $file
		$executableRecords += [ordered]@{ stage = $stage; path = $path; sha256 = (Hash-File $path) }
	}
	$libRoot = Join-Path $stagePath 'lib'
	foreach ($required in @('openEMS.lib', 'nf2ff.lib')) {
		if (-not (Test-Path -LiteralPath (Join-Path $libRoot $required) -PathType Leaf)) { throw "Staged import library is missing $(Join-Path $libRoot $required)" }
	}
	foreach ($file in Get-ChildItem -LiteralPath $libRoot -File -Filter '*.lib' -Recurse | Sort-Object FullName) {
		$libraryRecords += [ordered]@{ stage = $stage; path = $file.FullName; sha256 = (Hash-File $file.FullName) }
	}
}
$nativeDependencyRecords = @()
foreach ($relative in @('bin\fparser.dll', 'lib\fparser.lib', 'bin\CSXCAD.dll', 'lib\CSXCAD.lib')) {
	$path = Join-Path $NativePrefix $relative
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Rebuilt native dependency artifact is missing: $path" }
	$nativeDependencyRecords += [ordered]@{ path = $path; sha256 = (Hash-File $path) }
}
$provenance.status = 'paired-native-builds-and-stages-complete'
$provenance.currentStep = 'complete'
$provenance.completedUtc = [DateTime]::UtcNow.ToString('o')
$provenance.stagedRuntimeFiles = $binaryRecords
$provenance.stagedExecutables = $executableRecords
$provenance.stagedImportLibraries = $libraryRecords
$provenance.nativeDependencyFiles = $nativeDependencyRecords
Save-Provenance
Write-Output "Paired baseline and candidate builds are staged under $StageRoot."
Write-Output 'No solver was run; native numerical parity and timing remain separate validation gates.'
}
catch {
	$provenance.status = 'failed'
	$provenance.failedUtc = [DateTime]::UtcNow.ToString('o')
	$provenance.failure = $_.Exception.Message
	Save-Provenance
	throw
}
