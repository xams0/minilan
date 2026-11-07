# Compile RegieIA.exe : un seul fichier qui contient Node et la régie, avec le compilateur fourni dans Windows.
# Node doit être installé sur le PC qui compile, pas sur celui qui lance l'exe.
#   .\build.ps1                    version 0.0.0 : ne se met jamais à jour toute seule
#   .\build.ps1 -Version 1.2.0     version de l'exe
param([ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.0.0')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Compilateur introuvable : $csc" }
$node = (Get-Command node -ErrorAction Stop).Source
$project = Split-Path $PSScriptRoot -Parent

$temp = Join-Path $env:TEMP ("RegieIA_{0}" -f [guid]::NewGuid().ToString('N'))
$stage = Join-Path $temp 'app'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    # Liste explicite : config.json et data/ contiennent des mots de passe et ne doivent jamais entrer dans l'exe
    foreach ($item in 'src', 'public', 'scripts', 'node_modules', 'config.example.json', 'package.json') {
        Copy-Item -Path (Join-Path $project $item) -Destination $stage -Recurse
    }
    Copy-Item -Path $node -Destination (Join-Path $stage 'node.exe')

    $zip = Join-Path $temp 'regie-app.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)

    $defaults = Join-Path $temp 'Defaults.cs'
    Set-Content -Path $defaults -Encoding UTF8 -Value @"
[assembly: System.Reflection.AssemblyVersion("$Version")]
namespace AgentRegie { static class Defaults { public const string Version = "$Version"; public const string TagPrefix = "regie-v"; public const string AssetName = "RegieIA.exe"; } }
"@

    $dist = Join-Path $PSScriptRoot 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $out = Join-Path $dist 'RegieIA.exe'
    $updater = Join-Path $project 'agent\exe\Updater.cs' # partagé avec AgentRegie.exe
    $sources = @(Get-ChildItem -Path $PSScriptRoot -Filter '*.cs' | ForEach-Object { $_.FullName }) + $updater + $defaults
    & $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$out" "/resource:$zip,regie-app.zip" `
        /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
        /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
        $sources
    if ($LASTEXITCODE -ne 0) { throw "Échec de la compilation (code $LASTEXITCODE)" }
} finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ("Compilé : {0} ({1:N0} Mo), version {2}, Node {3}" -f $out, ((Get-Item $out).Length / 1MB), $Version, (& $node -v))
