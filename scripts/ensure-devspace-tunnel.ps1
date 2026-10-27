param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'devspace-settings.ps1')
$settings = Get-DevSpaceSettings
$publicBase = $settings.PublicBaseUrl
if (-not $publicBase) { return }
$publicUri = [Uri]$publicBase
if ($publicUri.Scheme -ne 'https' -or -not $publicUri.Host.EndsWith('.ts.net')) { return }
if ($publicUri.AbsolutePath.TrimEnd('/') -ne '') { throw 'DevSpace Tailscale publicBaseUrl must use the configured origin.' }
if ($publicUri.Port -ne 443) { throw 'DevSpace Funnel verification requires the configured HTTPS port 443.' }
$port = $settings.Port
$tailscale = (Get-Command tailscale.exe -ErrorAction Stop).Source

if (-not $VerifyOnly) {
  $service = Get-Service -Name 'Tailscale' -ErrorAction Stop
  if ($service.Status -ne 'Running') {
    try {
      if ($service.Status -eq 'Stopped') { Start-Service -Name 'Tailscale' -ErrorAction Stop }
      $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(20))
    } catch {
      throw "Could not start the Tailscale Windows service. Run the silent startup as administrator if access was denied. $($_.Exception.Message)"
    }
    Write-Output 'Tailscale Windows service started.'
  }
}

function Get-TailscaleState {
  $json = & $tailscale status --json
  if ($LASTEXITCODE -ne 0) { throw 'Tailscale status is unavailable.' }
  return $json | ConvertFrom-Json
}

$state = Get-TailscaleState
if (-not $VerifyOnly -and $state.BackendState -eq 'Stopped') {
  # No network flags: reconnect with the saved account and existing preferences.
  & $tailscale up --timeout=20s
  if ($LASTEXITCODE -ne 0) { throw 'Could not reconnect Tailscale with its saved settings.' }
  $state = Get-TailscaleState
}
if (-not $VerifyOnly -and $state.BackendState -in @('NoState', 'Starting')) {
  # The Windows service alone can remain in NoState without its user-session client.
  # Reuse the saved account; do not reset network preferences or request new credentials.
  if (-not (Get-Process -Name tailscale-ipn -ErrorAction SilentlyContinue)) {
    $client = Join-Path (Split-Path -Parent $tailscale) 'tailscale-ipn.exe'
    if (-not (Test-Path -LiteralPath $client)) { throw 'The existing Tailscale user-session client was not found.' }
    Start-Process -FilePath $client -WindowStyle Hidden | Out-Null
  }
  $deadline = (Get-Date).AddSeconds(40)
  while ($state.BackendState -in @('NoState', 'Starting') -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $state = Get-TailscaleState
  }
}
if ($state.BackendState -ne 'Running') { throw "Tailscale is $($state.BackendState); the DevSpace public endpoint is unavailable." }
if (-not $state.Self.DNSName -or $state.Self.DNSName.TrimEnd('.') -ne $publicUri.Host) {
  throw 'The active Tailscale identity does not match DevSpace publicBaseUrl; no forwarding was changed.'
}
if (-not $VerifyOnly) {
  # This is a background server: keep the saved identity loaded independently of the GUI session.
  & $tailscale set --unattended=true
  if ($LASTEXITCODE -ne 0) { throw 'Could not enable Tailscale unattended mode for the silent server startup.' }
  Write-Output 'Tailscale unattended mode enabled for background operation.'
}

$serveJson = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the existing Tailscale forwarding.' }
$serve = $serveJson | ConvertFrom-Json
if (@($serve.PSObject.Properties).Count -eq 0 -and -not $VerifyOnly) {
  & $tailscale funnel --bg --yes "http://127.0.0.1:$port"
  if ($LASTEXITCODE -ne 0) { throw 'Could not restore the configured DevSpace Funnel.' }
  $serve = (& $tailscale serve status --json) | ConvertFrom-Json
}
$authority = "$($publicUri.Host):443"
$binding = if ($serve.Web) { $serve.Web.PSObject.Properties[$authority] } else { $null }
$proxy = if ($binding) { $binding.Value.Handlers.'/'.Proxy } else { $null }
$allowFunnel = if ($serve.AllowFunnel) { $serve.AllowFunnel.PSObject.Properties[$authority] } else { $null }
if (-not $proxy -or -not $allowFunnel -or $allowFunnel.Value -ne $true) {
  throw 'The configured DevSpace public Funnel is absent or conflicts with existing forwarding; it was not overwritten.'
}
$proxyUri = [Uri]$proxy
if ($proxyUri.Scheme -ne 'http' -or -not $proxyUri.IsLoopback -or $proxyUri.Port -ne $port -or $proxyUri.AbsolutePath -ne '/') {
  throw 'Existing Tailscale forwarding targets another service; it was not overwritten.'
}
$healthUri = [Uri]::new($publicUri, '/healthz')
$health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 8
if ($health.ok -ne $true -or $health.name -ne 'devspace') { throw 'The configured endpoint did not identify a healthy DevSpace server.' }
# MagicDNS can resolve this hostname to the machine's private Tailscale IP.
# Validate the public ingress separately, retaining hostname/SNI and TLS checks.
$dnsName = [Uri]::EscapeDataString($publicUri.Host)
$dnsErrors = [Collections.Generic.List[string]]::new()
$records = @()
foreach ($recordType in @('A', 'AAAA')) {
  # Independent providers are fallbacks, not additional health dependencies.
  foreach ($resolver in @('https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query')) {
    try {
      $dns = Invoke-RestMethod -Uri "${resolver}?name=$dnsName&type=$recordType&edns_client_subnet=0.0.0.0/0" `
        -Headers @{ Accept = 'application/dns-json' } -TimeoutSec 4
      if ($dns.Status -ne 0) { throw "DNS status $($dns.Status)" }
      $records += @($dns.Answer | Where-Object { $_.type -eq $(if ($recordType -eq 'A') { 1 } else { 28 }) } | Select-Object -First 2)
      break
    } catch { $dnsErrors.Add("$resolver/$recordType`: $($_.Exception.Message)") }
  }
}
$publicAddresses = @($records | Where-Object {
  $address = $null
  if (-not [Net.IPAddress]::TryParse([string]$_.data, [ref]$address)) { return $false }
  $octets = $address.GetAddressBytes()
  if ($octets.Length -eq 16) { return ($octets[0] -band 224) -eq 32 }
  return $octets.Length -eq 4 -and $octets[0] -notin @(0, 10, 127) -and $octets[0] -lt 224 -and
    -not ($octets[0] -eq 169 -and $octets[1] -eq 254) -and
    -not ($octets[0] -eq 192 -and $octets[1] -eq 168) -and
    -not ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127) -and
    -not ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31)
} | Select-Object -ExpandProperty data -Unique)
if (-not $publicAddresses.Count) { throw "No public ingress address was resolved for DevSpace. $($dnsErrors -join '; ')" }
$curl = (Get-Command curl.exe -ErrorAction Stop).Source
$publicVerified = $false
$probeErrors = [Collections.Generic.List[string]]::new()
# Addresses are fallbacks; stop after the first verified DevSpace response.
foreach ($address in $publicAddresses) {
  $resolveAddress = if ($address.Contains(':')) { "[$address]" } else { $address }
  $body = (& $curl --silent --show-error --fail --stderr - --noproxy '*' --connect-timeout 4 --max-time 6 `
    --max-filesize 65536 --write-out '\nDEVSPACE_PROBE http=%{http_code} tcp=%{time_connect} tls=%{time_appconnect}' `
    --resolve "$($publicUri.Host):443:$resolveAddress" $healthUri.AbsoluteUri) -join "`n"
  $probeExit = $LASTEXITCODE
  $parts = $body -split '\r?\nDEVSPACE_PROBE ', 2
  $timing = if ($parts.Length -eq 2) { $parts[1] } else { 'no HTTP timing' }
  if ($probeExit -ne 0) {
    $detail = $parts[0].Substring(0, [Math]::Min(220, $parts[0].Length))
    $probeErrors.Add("${address}: curl=$probeExit $timing $detail")
    continue
  }
  try { $remoteHealth = $parts[0] | ConvertFrom-Json } catch {
    $probeErrors.Add("${address}: invalid health JSON; $timing")
    continue
  }
  if ($remoteHealth.ok -eq $true -and $remoteHealth.name -eq 'devspace') { $publicVerified = $true; break }
  $probeErrors.Add("${address}: response did not identify DevSpace; $timing")
}
if (-not $publicVerified) {
  throw "DevSpace responds through local DNS, but its public Funnel ingress could not be verified. $($probeErrors -join '; ')"
}
Write-Output "DevSpace public endpoint verified: $($publicUri.Host) -> 127.0.0.1:$port."
