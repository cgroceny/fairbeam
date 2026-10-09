param(
    [Parameter(Mandatory = $true)] [string]$SourceRoot,
    [Parameter(Mandatory = $true)] [string]$BuildRoot,
    [Parameter(Mandatory = $true)] [string]$Compiler
)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$Compiler = (Resolve-Path -LiteralPath $Compiler).Path
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (Test-Path -LiteralPath $BuildRoot) { throw 'Choose a fresh harness output directory.' }
$headerRoot = Join-Path $SourceRoot 'FDTD\extensions'
$header = Join-Path $headerRoot 'conducting_sheet_periodic_topology.h'
$production = Join-Path $headerRoot 'operator_ext_conductingsheet.cpp'
if (-not (Test-Path -LiteralPath $header -PathType Leaf)) { throw 'Patched native header is missing.' }
foreach ($marker in @('ConductingSheetPeriodicTopology::Enabled', 'ConductingSheetPeriodicTopology::BoundaryBlocked',
    'ConductingSheetPeriodicTopology::PrimitiveAlpha', 'ConductingSheetPeriodicTopology::Previous',
    'typeid(*m_Op) == typeid(Operator_Cylinder)', 'numLines[1], m_OriginalSheetExtension',
    'm_OriginalSheetExtension = false')) {
    if (-not (Select-String -LiteralPath $production -SimpleMatch $marker -Quiet)) {
        throw "The native production source is missing the integrated helper or exact-type gate: $marker"
    }
}
New-Item -ItemType Directory -Path $BuildRoot | Out-Null
$executable = Join-Path $BuildRoot 'periodic-sheets-harness.exe'
$source = Join-Path $PSScriptRoot 'tests\periodic_sheets_harness.cpp'
if ([IO.Path]::GetFileName($Compiler) -ieq 'cl.exe') {
    # Run from an x64 MSVC developer shell with its SDK environment loaded.
    $arguments = @('/nologo', '/EHsc', '/std:c++14', '/W4', '/WX', '/O2',
        "/I$headerRoot", $source, "/Fe:$executable", "/Fo:$BuildRoot\")
} else {
    $arguments = @('-std=c++11', '-Wall', '-Wextra', '-Werror', '-O2',
        "-I$headerRoot", $source, '-o', $executable)
}
& $Compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Native harness compilation failed: $LASTEXITCODE" }
& $executable
if ($LASTEXITCODE -ne 0) { throw "Native harness failed: $LASTEXITCODE" }
