param(
  [string]$BundleDirectory = (Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle\nsis'),
  [string]$ManifestPath = (Join-Path $PSScriptRoot 'latest.json')
)

$ErrorActionPreference = 'Stop'

$installers = @(Get-ChildItem -LiteralPath $BundleDirectory -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) {
  throw "Un seul installeur NSIS est attendu dans $BundleDirectory (trouvé : $($installers.Count))."
}
$installer = $installers[0]

$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if ($signature.Status -ne 'Valid') {
  throw "La signature Authenticode de $($installer.Name) n'est pas valide : $($signature.Status)."
}

$zipArtifacts = @(Get-ChildItem -LiteralPath $BundleDirectory -Filter '*.nsis.zip' -File)
if ($zipArtifacts.Count -ne 1) {
  throw "Un seul bundle .nsis.zip est attendu dans $BundleDirectory (trouvé : $($zipArtifacts.Count))."
}

$archiveProbe = Join-Path ([IO.Path]::GetTempPath()) ("vaultly-verify-" + [Guid]::NewGuid().ToString('N'))
try {
  Expand-Archive -LiteralPath $zipArtifacts[0].FullName -DestinationPath $archiveProbe -Force
  $embeddedInstaller = @(Get-ChildItem -LiteralPath $archiveProbe -Filter '*-setup.exe' -File)
  if ($embeddedInstaller.Count -ne 1) {
    throw "Le bundle updater doit contenir exactement un installeur NSIS (trouvé : $($embeddedInstaller.Count))."
  }
  $embeddedSignature = Get-AuthenticodeSignature -LiteralPath $embeddedInstaller[0].FullName
  if ($embeddedSignature.Status -ne 'Valid') {
    throw "La copie de l'installeur dans le bundle updater n'est pas signée : $($embeddedSignature.Status)."
  }
} finally {
  if (Test-Path -LiteralPath $archiveProbe) {
    Remove-Item -LiteralPath $archiveProbe -Recurse -Force
  }
}

$signaturePath = "$($zipArtifacts[0].FullName).sig"
if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
  throw "Signature updater absente : $signaturePath."
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Manifeste updater absent : $ManifestPath."
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$platform = $manifest.platforms.'windows-x86_64'
if (-not $platform -or [string]::IsNullOrWhiteSpace($platform.url) -or [string]::IsNullOrWhiteSpace($platform.signature)) {
  throw 'Le manifeste updater ne contient pas de plateforme Windows signée complète.'
}
$manifestArtifact = [IO.Path]::GetFileName(([Uri]$platform.url).AbsolutePath)
if ($manifestArtifact -ne $zipArtifacts[0].Name) {
  throw "Le manifeste pointe vers $manifestArtifact au lieu de $($zipArtifacts[0].Name)."
}
$localSignature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if ($platform.signature.Trim() -ne $localSignature) {
  throw 'La signature du manifeste ne correspond pas au fichier .sig local.'
}

[PSCustomObject]@{
  Installer = $installer.FullName
  Authenticode = $signature.Status
  UpdaterBundle = $zipArtifacts[0].FullName
  UpdaterSignature = $signaturePath
  Manifest = (Resolve-Path -LiteralPath $ManifestPath).Path
} | Format-List
