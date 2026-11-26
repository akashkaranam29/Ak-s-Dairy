$pythonCommand = Get-Command python.exe -ErrorAction Stop
$pythonPath = $pythonCommand.Source
$existing = Get-NetFirewallRule -DisplayName "Ak's Dairy Wi-Fi Admin" -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName "Ak's Dairy Wi-Fi Admin" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -RemoteAddress LocalSubnet -Profile Private -Program $pythonPath | Out-Null
}
Write-Host "Ak's Dairy is allowed from devices on your private Wi-Fi network only."
Read-Host "Press Enter to close"
