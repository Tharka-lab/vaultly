import fs from 'node:fs'

const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim()
const endpoint = process.env.TAURI_UPDATER_ENDPOINT?.trim()
const certificateThumbprint = process.env.TAURI_WINDOWS_CERT_THUMBPRINT?.replace(/\s+/g, '')
const timestampUrl = process.env.TAURI_WINDOWS_TIMESTAMP_URL?.trim()

if (!publicKey || !endpoint) {
  throw new Error('TAURI_UPDATER_PUBLIC_KEY et TAURI_UPDATER_ENDPOINT sont requis pour une release updater.')
}
if (!endpoint.startsWith('https://')) {
  throw new Error('TAURI_UPDATER_ENDPOINT doit utiliser HTTPS.')
}
if (certificateThumbprint && !/^[a-f0-9]{40}$/i.test(certificateThumbprint)) {
  throw new Error('TAURI_WINDOWS_CERT_THUMBPRINT doit être une empreinte SHA-1 de 40 caractères hexadécimaux.')
}
if (timestampUrl && !certificateThumbprint) {
  throw new Error('TAURI_WINDOWS_TIMESTAMP_URL nécessite TAURI_WINDOWS_CERT_THUMBPRINT lorsque la signature est réalisée par SignPath.')
}
if (timestampUrl && !/^https?:\/\//i.test(timestampUrl)) {
  throw new Error('TAURI_WINDOWS_TIMESTAMP_URL doit être une URL HTTP(S).')
}

const basePath = 'src-tauri/tauri.conf.json'
const outputPath = 'src-tauri/tauri.release.conf.json'
const config = JSON.parse(fs.readFileSync(basePath, 'utf8'))

config.bundle = {
  ...config.bundle,
  createUpdaterArtifacts: true,
  windows: {
    ...(config.bundle.windows ?? {}),
    digestAlgorithm: 'sha256',
    ...(certificateThumbprint ? { certificateThumbprint } : {}),
    ...(timestampUrl ? { timestampUrl } : {}),
  },
}
config.plugins = {
  ...(config.plugins ?? {}),
  updater: {
    pubkey: publicKey,
    endpoints: [endpoint],
    windows: { installMode: 'passive' },
  },
}

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
console.log(`Configuration updater préparée dans ${outputPath}`)
