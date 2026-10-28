function Get-DevSpaceSettings {
  param([switch]$IgnoreInheritedPort)
  $directory = if ($env:DEVSPACE_CONFIG_DIR) { $env:DEVSPACE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.devspace' }
  $path = Join-Path $directory 'config.json'
  $config = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { $null }
  $portValue = if (-not $IgnoreInheritedPort -and $null -ne $env:PORT) { $env:PORT } elseif ($config.port) { $config.port } else { 7676 }
  $port = 0
  if (-not [int]::TryParse([string]$portValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'Invalid DevSpace port.'
  }
  return [pscustomobject]@{
    Port = $port
    PublicBaseUrl = if ($env:DEVSPACE_PUBLIC_BASE_URL) { $env:DEVSPACE_PUBLIC_BASE_URL } else { $config.publicBaseUrl }
  }
}
