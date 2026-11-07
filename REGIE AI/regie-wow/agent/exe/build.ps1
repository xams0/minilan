# Compile AgentRegie.exe avec le compilateur fourni dans Windows : rien à installer.
# L'exe obtenu n'a besoin que de .NET Framework 4.8, déjà présent sur Windows 10 et 11 à jour.
#   .\build.ps1                                       adresse de régie par défaut : celle du test
#   .\build.ps1 -Regie http://192.168.1.20:8081       adresse pré-remplie pour une autre installation
#   .\build.ps1 -Version 1.2.0                        version de l'exe. Sans elle (0.0.0), il ne se met jamais à jour tout seul
param(
    [string]$Regie = 'http://192.168.1.31:8081',
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.0.0'
)

$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Compilateur introuvable : $csc" }

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$out = Join-Path $dist 'AgentRegie.exe'

# L'adresse par défaut et la version sont intégrées à l'exe ; le joueur peut toujours changer l'adresse dans la fenêtre
$defaults = Join-Path $env:TEMP ("AgentRegieDefaults_{0}.cs" -f [guid]::NewGuid().ToString('N'))
$escaped = $Regie.Replace('\', '\\').Replace('"', '\"')
Set-Content -Path $defaults -Encoding UTF8 -Value @"
[assembly: System.Reflection.AssemblyVersion("$Version")]
namespace AgentRegie { static class Defaults { public const string Server = "$escaped"; public const string Version = "$Version"; public const string TagPrefix = "agent-v"; public const string AssetName = "AgentRegie.exe"; } }
"@

try {
    $sources = @(Get-ChildItem -Path $PSScriptRoot -Filter '*.cs' | ForEach-Object { $_.FullName }) + $defaults
    & $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$out" `
        /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
        $sources
    if ($LASTEXITCODE -ne 0) { throw "Échec de la compilation (code $LASTEXITCODE)" }
} finally {
    Remove-Item -Path $defaults -ErrorAction SilentlyContinue
}

Write-Output ("Compilé : {0} ({1:N0} Ko), version {2}, régie par défaut {3}" -f $out, ((Get-Item $out).Length / 1KB), $Version, $Regie)
