$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$avatarNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $avatarNode) {
  Write-Host '没有找到 Node.js，请安装 Node.js 20.12 或更高版本。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
$avatarPort = if ($env:PORT) { $env:PORT } else { '4173' }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env.local')) {
  $avatarPortLine = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env.local') | Where-Object { $_ -match '^\s*PORT\s*=\s*\d+\s*$' } | Select-Object -Last 1
  if ($avatarPortLine -match '=\s*(\d+)') { $avatarPort = $Matches[1] }
}
$avatarUrl = "http://127.0.0.1:$avatarPort"
Write-Host "数字人网页：$avatarUrl" -ForegroundColor Cyan
Write-Host '按 Ctrl+C 关闭本地服务。'
Start-Process $avatarUrl
& $avatarNode.Source (Join-Path $PSScriptRoot 'server.mjs')
