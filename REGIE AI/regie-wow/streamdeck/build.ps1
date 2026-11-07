# Crée dans dist\ le plugin Stream Deck (profil inclus) et le profil seul. Node doit être installé sur le PC qui compile.
#   .\build.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Séparateurs « / » écrits à la main : PowerShell 5 mettrait sinon des « \ », refusés hors de Windows
function New-Zip([string]$Source, [string]$Target) {
    if (Test-Path $Target) { Remove-Item $Target -Force }
    $zip = [IO.Compression.ZipFile]::Open($Target, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $base = (Get-Item $Source).FullName.TrimEnd('\') + '\'
        foreach ($f in Get-ChildItem -Path $Source -Recurse -File) {
            $name = $f.FullName.Substring($base.Length).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name)
        }
    } finally { $zip.Dispose() }
}

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$temp = Join-Path $env:TEMP ("RegieIADeck_{0}" -f [guid]::NewGuid().ToString('N'))
try {
    $profileDir = Join-Path $temp 'profil'
    & node (Join-Path $PSScriptRoot 'make-profile.mjs') $profileDir
    if ($LASTEXITCODE -ne 0) { throw "Échec de la génération du profil" }
    $profileFile = Join-Path $dist 'RegieIA.streamDeckProfile'
    New-Zip $profileDir $profileFile

    $name = 'fr.lanppart.regieia.sdPlugin'
    $stage = Join-Path $temp 'plugin'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $PSScriptRoot $name) -Destination $stage -Recurse
    Copy-Item -Path $profileFile -Destination (Join-Path $stage $name)
    New-Zip $stage (Join-Path $dist 'RegieIA.streamDeckPlugin')
} finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "Créés dans $dist : RegieIA.streamDeckPlugin et RegieIA.streamDeckProfile"
