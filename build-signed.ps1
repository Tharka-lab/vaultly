param(
  [string]$PublicKey = $env:TAURI_UPDATER_PUBLIC_KEY,
  [string]$Endpoint = $env:TAURI_UPDATER_ENDPOINT,
  [string]$BaseUrl = $env:TAURI_UPDATER_BASE_URL
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
  throw 'TAURI_SIGNING_PRIVATE_KEY est requis et doit rester hors du dépôt.'
}
if ([string]::IsNullOrWhiteSpace($env:TAURI_WINDOWS_CERT_THUMBPRINT)) {
  throw 'TAURI_WINDOWS_CERT_THUMBPRINT est requis pour signer les exécutables Windows.'
}
if ([string]::IsNullOrWhiteSpace($PublicKey) -or [string]::IsNullOrWhiteSpace($Endpoint) -or [string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw 'TAURI_UPDATER_PUBLIC_KEY, TAURI_UPDATER_ENDPOINT et TAURI_UPDATER_BASE_URL sont requis.'
}
if (-not $Endpoint.StartsWith('https://') -or -not $BaseUrl.StartsWith('https://')) {
  throw 'Les URLs updater doivent utiliser HTTPS.'
}

$env:TAURI_UPDATER_PUBLIC_KEY = $PublicKey
$env:TAURI_UPDATER_ENDPOINT = $Endpoint
$env:TAURI_UPDATER_BASE_URL = $BaseUrl

npm run prepare:updater
if ($LASTEXITCODE -ne 0) { throw 'La préparation de la configuration updater a échoué.' }

npm run tauri:build -- --config src-tauri/tauri.release.conf.json
if ($LASTEXITCODE -ne 0) { throw 'La compilation signée a échoué.' }

npm run release:manifest
if ($LASTEXITCODE -ne 0) { throw 'La génération du manifeste signé a échoué.' }

npm run release:verify
if ($LASTEXITCODE -ne 0) { throw 'La vérification des artefacts signés a échoué.' }

Write-Host 'Release signée prête : bundle NSIS, signature .sig et release/latest.json.'
