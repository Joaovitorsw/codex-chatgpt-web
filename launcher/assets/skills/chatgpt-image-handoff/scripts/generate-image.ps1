param(
  [Parameter(Mandatory = $true)][string]$Prompt,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$TraceId = "asset_$([Guid]::NewGuid().ToString('N'))"
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutputPath) -or [IO.Path]::GetExtension($OutputPath) -ne '.png') { throw 'OutputPath must be an absolute new .png path.' }
if (Test-Path -LiteralPath $OutputPath) { throw "Refusing to overwrite existing image: $OutputPath" }
$descriptorPath = $env:CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR
if ([string]::IsNullOrWhiteSpace($descriptorPath)) { $descriptorPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\runtime\launcher-browser.json' }
if (-not (Test-Path -LiteralPath $descriptorPath)) { throw 'The Codex Web GPT launcher browser descriptor is unavailable.' }
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$endpoint = [string]$descriptor.control.endpoint; $token = [string]$descriptor.control.token
if ([string]::IsNullOrWhiteSpace($endpoint) -or [string]::IsNullOrWhiteSpace($token)) { throw 'The launcher descriptor has no authenticated image-generation control channel.' }
$parent = Split-Path -Parent $OutputPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$headers = @{ Authorization = "Bearer $token" }; $body = @{ traceId = $TraceId; prompt = $Prompt; outputPath = $OutputPath } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Method Post -Uri "$endpoint/v1/image/generate" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 360
if ($result.ok -ne $true -or -not (Test-Path -LiteralPath $OutputPath)) { throw 'ChatGPT Web did not return a verified local PNG.' }
$file = Get-Item -LiteralPath $OutputPath; if ($file.Length -lt 1) { throw 'The generated PNG is empty.' }
[pscustomobject]@{ ok = $true; path = $file.FullName; bytes = $file.Length; width = $result.width; height = $result.height; mimeType = $result.mimeType } | ConvertTo-Json -Compress
