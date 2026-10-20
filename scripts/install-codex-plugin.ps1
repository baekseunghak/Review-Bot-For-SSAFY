param(
  [string]$MarketplacePath = (Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'),
  [string]$PluginPath = (Join-Path $env:USERPROFILE 'plugins\mmp')
)

$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pluginParent = Split-Path $PluginPath -Parent
$pluginName = Split-Path $PluginPath -Leaf

if ($pluginName -ne 'mmp') {
  throw 'PluginPath must end with mmp.'
}

if (Test-Path $PluginPath) {
  throw "Plugin path already exists: $PluginPath. Remove or rename it before a fresh install."
}

New-Item -ItemType Directory -Force -Path $pluginParent, $PluginPath | Out-Null
foreach ($item in @('.codex-plugin', 'assets', 'skills', 'src', 'bin', 'docs', '.mcp.json', 'package.json', 'package-lock.json', 'README.md')) {
  Copy-Item -Path (Join-Path $repoPath $item) -Destination $PluginPath -Recurse
}

Push-Location $PluginPath
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) {
    throw 'npm ci failed.'
  }
} finally {
  Pop-Location
}

$marketplaceDir = Split-Path $MarketplacePath -Parent
New-Item -ItemType Directory -Force -Path $marketplaceDir | Out-Null

if (Test-Path $MarketplacePath) {
  $marketplace = Get-Content -Raw $MarketplacePath | ConvertFrom-Json
} else {
  $marketplace = [pscustomobject]@{
    name = 'personal'
    interface = [pscustomobject]@{ displayName = 'Personal' }
    plugins = @()
  }
}

if (-not $marketplace.name) {
  throw "Marketplace name is missing: $MarketplacePath"
}

$existing = @($marketplace.plugins | Where-Object { $_.name -eq $pluginName })
if ($existing.Count -gt 0) {
  throw "Marketplace already contains $pluginName. Use the plugin update flow instead."
}

$entry = [pscustomobject]@{
  name = $pluginName
  source = [pscustomobject]@{ source = 'local'; path = "./plugins/$pluginName" }
  policy = [pscustomobject]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
  category = 'Productivity'
}
$marketplace.plugins = @($marketplace.plugins) + $entry
$marketplace | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $MarketplacePath

codex plugin add "$pluginName@$($marketplace.name)"
if ($LASTEXITCODE -ne 0) {
  throw 'codex plugin add failed.'
}

Write-Host "Installed $pluginName from $PluginPath"
Write-Host 'Open a new Codex task to load the MCP tools and skill.'
