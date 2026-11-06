# Lance MediaMTX + Dashboard, accessible sur tout le réseau local

$mediamtxPath  = "$PSScriptRoot\mediamtx.exe"
$configPath    = "$PSScriptRoot\mediamtx.yml"
$serverJsPath  = "$PSScriptRoot\server.js"
$dashboardPort = 8080

$logsDir = "$PSScriptRoot\logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$lanIP = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" } |
    Select-Object -First 1 -ExpandProperty IPAddress

# --- Stoppe les instances précédentes ---
Stop-Process -Name mediamtx -Force -ErrorAction SilentlyContinue
# Uniquement le Node qui occupe le port du dashboard : ne pas toucher aux autres
# programmes Node du PC (regie, plugins Stream Deck, Adobe...).
Get-NetTCPConnection -LocalPort $dashboardPort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# --- Lance MediaMTX ---
# Fenetre visible (logs SRT en direct utiles pendant l'evenement) ; la
# persistance des logs est deja geree par mediamtx.yml (logDestinations:
# [stdout, file]), donc pas besoin de rediriger ici. Un fichier de log distinct
# est genere par lancement (mediamtx_<date>_<heure>.log) via une copie de
# config temporaire, pour ne pas ecraser les logs d'un lancement precedent.
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$mtxLogRelPath = "logs/mediamtx_$timestamp.log"
$runConfigPath = "$logsDir\mediamtx-run.yml"
$configContent = (Get-Content $configPath -Raw) -replace '(?m)^logFile:\s*.*$', "logFile: $mtxLogRelPath"
[System.IO.File]::WriteAllText($runConfigPath, $configContent, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[*] Démarrage MediaMTX..." -ForegroundColor Cyan
$mtx = Start-Process -FilePath $mediamtxPath -ArgumentList "`"$runConfigPath`"" -WorkingDirectory $PSScriptRoot -PassThru
Start-Sleep -Seconds 1
if ($mtx.HasExited) {
    Write-Host "[ERR] MediaMTX a planté. Vérifier mediamtx.yml et $logsDir\mediamtx_$timestamp.log." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] MediaMTX PID $($mtx.Id) — SRT :8890" -ForegroundColor Green

# --- Lance le dashboard (proxy Node, bindé sur 0.0.0.0 -> accessible LAN) ---
# Fenetre cachee (rien d'utile a regarder en direct) ; stdout/stderr sont
# rediriges vers un fichier pour pouvoir diagnostiquer un plantage.
Write-Host "[*] Démarrage du dashboard..." -ForegroundColor Cyan
$dash = Start-Process -FilePath "node" -ArgumentList "`"$serverJsPath`"" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logsDir\dashboard-stdout.log" -RedirectStandardError "$logsDir\dashboard-stderr.log"
Start-Sleep -Seconds 1
if ($dash.HasExited) {
    Write-Host "[ERR] Le dashboard Node a planté. Voir $logsDir\dashboard-stderr.log." -ForegroundColor Red
    Stop-Process -Id $mtx.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "[OK] Dashboard PID $($dash.Id)" -ForegroundColor Green
Write-Host "     Local : http://127.0.0.1:$dashboardPort" -ForegroundColor Green
if ($lanIP) {
    Write-Host "     LAN   : http://$lanIP`:$dashboardPort" -ForegroundColor Green
}
Write-Host "     Ctrl+C pour arrêter`n" -ForegroundColor DarkGray

Start-Process "http://127.0.0.1:$dashboardPort"

try {
    Wait-Process -Id $dash.Id
} finally {
    Stop-Process -Id $mtx.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $dash.Id -Force -ErrorAction SilentlyContinue
    Write-Host "`n[*] Arrêt MediaMTX + Dashboard." -ForegroundColor Yellow
}
