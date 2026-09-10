import fs from 'node:fs'
import path from 'node:path'

const baseUrl = process.env.TAURI_UPDATER_BASE_URL?.trim().replace(/\/$/, '')
if (!baseUrl || !baseUrl.startsWith('https://')) {
  throw new Error('TAURI_UPDATER_BASE_URL doit être une URL HTTPS vers le dossier de publication.')
}

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const directory = path.join('src-tauri', 'target', 'release', 'bundle', 'nsis')
const artifacts = fs.readdirSync(directory).filter((name) => name.endsWith('.nsis.zip'))
if (artifacts.length !== 1) {
  throw new Error(`Un seul bundle .nsis.zip est attendu dans ${directory} (trouvé : ${artifacts.length}).`)
}

const artifact = artifacts[0]
const signaturePath = path.join(directory, `${artifact}.sig`)
if (!fs.existsSync(signaturePath)) {
  throw new Error(`Signature manquante : ${signaturePath}. Construis la release avec TAURI_SIGNING_PRIVATE_KEY.`)
}

const manifest = {
  version: packageJson.version,
  notes: `Vaultly ${packageJson.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      url: `${baseUrl}/${artifact}`,
      signature: fs.readFileSync(signaturePath, 'utf8').trim(),
    },
  },
}

fs.writeFileSync('release/latest.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Manifeste updater généré dans release/latest.json pour ${artifact}`)
