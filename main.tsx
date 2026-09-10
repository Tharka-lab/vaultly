import { createContext, StrictMode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import {
  ChevronDown,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Fingerprint,
  Folder,
  Gamepad2,
  Globe2,
  KeyRound,
  History as HistoryIcon,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react'
import './styles.css'

type Entry = {
  id: number
  title: string
  provider: string
  username: string
  password: string
  url: string
  category: string
  icon: string
  color: string
  applicationPath?: string
  autofillAdapter?: string
  totpSecret?: string
  totpDigits?: number
  totpPeriod?: number
  totpAlgorithm?: 'SHA1' | 'SHA256' | 'SHA512'
  notes?: string
  history?: PasswordHistoryItem[]
  attachments?: SecureAttachment[]
  updatedAt?: string
  favorite?: boolean
  strength: 'Fort' | 'Moyen'
}

type PasswordHistoryItem = { password: string; changedAt: string }
type SecureAttachment = { name: string; data: string; size: number }
type BridgeInfo = { port: number; token: string }
type SecretPromptRequest = { title: string; resolve: (value: string | null) => void }

function formatBytes(size: number, language: Language) {
  if (size < 1024) return `${size} ${language === 'fr' ? 'o' : 'B'}`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} ${language === 'fr' ? 'Ko' : 'KB'}`
  return `${(size / (1024 * 1024)).toFixed(1)} ${language === 'fr' ? 'Mo' : 'MB'}`
}

function parseVaultDate(value?: string) {
  if (!value) return undefined
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatVaultDate(value: string | undefined, language: Language) {
  const date = parseVaultDate(value)
  return date ? new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium' }).format(date) : '—'
}

function formatLastModified(value: string | undefined, language: Language) {
  const date = parseVaultDate(value)
  if (!date) return language === 'fr' ? 'Date inconnue' : 'Unknown date'
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000))
  return new Intl.RelativeTimeFormat(language === 'fr' ? 'fr-FR' : 'en-US', { numeric: 'auto' }).format(-days, 'day')
}

function loadRecentVaults() {
  try {
    const value = JSON.parse(localStorage.getItem('vaultly.recentVaults') ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : []
  } catch {
    return []
  }
}

function loadAutoLockMinutes() {
  const value = Number(localStorage.getItem('vaultly.autoLockMinutes') ?? 5)
  return [1, 5, 15, 30].includes(value) ? value : 5
}

function vaultDisplayName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function interpolate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template)
}

type TotpSettings = { secret: string; digits: number; period: number; algorithm: 'SHA1' | 'SHA256' | 'SHA512' }

function normalizeTotpSecret(value: string) {
  const normalized = value.replace(/[=\s-]/g, '').toUpperCase()
  return /^[A-Z2-7]+$/.test(normalized) ? normalized : undefined
}

function parseTotpSettings(value?: string): TotpSettings | undefined {
  if (!value?.trim()) return undefined
  const rawSecret = normalizeTotpSecret(value.trim())
  if (!rawSecret) return undefined
  const fallback: TotpSettings = { secret: rawSecret, digits: 6, period: 30, algorithm: 'SHA1' }
  if (!value.trim().startsWith('otpauth://')) return fallback
  try {
    const url = new URL(value.trim())
    const secret = url.searchParams.get('secret')?.trim()
    if (!secret) return undefined
    const normalizedSecret = normalizeTotpSecret(secret)
    if (!normalizedSecret) return undefined
    const digitsValue = Number(url.searchParams.get('digits') ?? 6)
    const periodValue = Number(url.searchParams.get('period') ?? 30)
    const algorithmValue = (url.searchParams.get('algorithm') ?? 'SHA1').replace(/-/g, '').toUpperCase()
    const algorithm = algorithmValue === 'SHA256' || algorithmValue === 'SHA512' ? algorithmValue : 'SHA1'
    return { secret: normalizedSecret, digits: [6, 7, 8].includes(digitsValue) ? digitsValue : 6, period: periodValue > 0 && periodValue <= 300 ? Math.round(periodValue) : 30, algorithm }
  } catch { return undefined }
}

const applications = [
  { name: 'Battle.net', icon: '◈', color: '#1d6bff', url: 'https://account.battle.net/' },
  { name: 'Steam', icon: '●', color: '#26384a', url: 'https://store.steampowered.com/login/' },
  { name: 'Epic Games', icon: 'E', color: '#1d232c', url: 'https://www.epicgames.com/id/login' },
  { name: 'Microsoft', icon: '⊞', color: '#20a4f3', url: 'https://account.microsoft.com/' },
  { name: 'Discord', icon: '☯', color: '#5865f2', url: 'https://discord.com/login' },
  { name: 'Google', icon: 'G', color: '#ffffff', url: 'https://accounts.google.com/' },
]

function getAutofillAdapter(provider: string) {
  const normalized = provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return ['battle_net', 'steam', 'epic_games', 'microsoft', 'discord', 'google'].includes(normalized) ? normalized : undefined
}

const initialEntries: Entry[] = [
  { id: 1, title: 'Call of Duty', provider: 'Battle.net', username: 'alex.martin@email.com', password: 'V4ult!ly-2026-Example', url: 'https://account.battle.net/', category: 'Jeux', icon: '◈', color: '#1d6bff', favorite: true, strength: 'Fort', notes: 'Compte principal utilisé pour Call of Duty et Warzone.', updatedAt: '2026-08-18' },
  { id: 2, title: 'Steam', provider: 'Steam', username: 'alexmartin', password: 'Steam-demo-Password-2026', url: 'https://store.steampowered.com/login/', category: 'Jeux', icon: '●', color: '#26384a', favorite: true, strength: 'Fort', notes: 'Jeux et achats Steam.', updatedAt: '2026-08-12' },
  { id: 3, title: 'Compte Microsoft', provider: 'Microsoft', username: 'alex.martin@email.com', password: 'Microsoft-demo-Password', url: 'https://account.microsoft.com/', category: 'Personnel', icon: '⊞', color: '#20a4f3', strength: 'Moyen', notes: '', updatedAt: '2026-07-25' },
  { id: 4, title: 'Discord', provider: 'Discord', username: 'alexmartin#4281', password: 'Discord-demo-Password-2026', url: 'https://discord.com/login', category: 'Réseaux sociaux', icon: '☯', color: '#5865f2', strength: 'Fort', notes: 'Serveurs et discussions.', updatedAt: '2026-08-20' },
]

const defaultCategories = ['Jeux', 'Personnel', 'Réseaux sociaux']
const ALL_CATEGORY = '__vaultly_all__'
const FAVORITES_CATEGORY = '__vaultly_favorites__'

type VaultStatus = 'loading' | 'create' | 'unlock' | 'unlocked'

type Language = 'fr' | 'en'
type I18nValue = { language: Language; setLanguage: (language: Language) => void; t: (key: string) => string }
const I18nContext = createContext<I18nValue>({ language: 'fr', setLanguage: () => undefined, t: (key) => key })
const translations: Record<Language, Record<string, string>> = {
  fr: {
    vault: 'Mon coffre', all: 'Tous les identifiants', favorites: 'Favoris', categories: 'Catégories', addCategory: 'Ajouter une catégorie', security: 'Centre de sécurité', settings: 'Paramètres', newEntry: 'Nouvel identifiant', lockedLocally: 'Coffre verrouillé localement', search: 'Rechercher un identifiant...', filter: 'Filtrer', connectionInfo: 'INFORMATIONS DE CONNEXION', notes: 'NOTES', copyPassword: 'Copier le mot de passe', modify: 'Modifier', open: 'Ouvrir', openFill: 'Ouvrir et remplir', history: 'Historique', secureFile: 'Fichier sécurisé', password: 'Mot de passe', username: 'Identifiant', link: 'Lien de connexion', service: 'Application / service', cancel: 'Annuler', addToVault: 'Ajouter au coffre', changeVault: 'Changer de coffre', newVault: 'Nouveau coffre', import: 'Importer', export: 'Exporter', recovery: 'Récupération hors ligne', sync: 'Synchronisation chiffrée', autofill: 'Autoremplissage web', language: 'Langue de l’interface', french: 'Français', english: 'English', save: 'Enregistrer', close: 'Fermer', createVault: 'Créer ton coffre', unlockVault: 'Déverrouiller le coffre', openVault: 'Ouverture du coffre', checkingStorage: 'Vérification du stockage local chiffré…', masterPassword: 'Mot de passe maître', confirmPassword: 'Confirmer le mot de passe', createLocalVault: 'Créer le coffre local', unlock: 'Déverrouiller', processing: 'Traitement…', createVaultDescription: 'Ton coffre sera enregistré localement et chiffré avant d’être écrit sur le disque.', unlockVaultDescription: 'Saisis ton mot de passe maître pour accéder à tes identifiants.', minimum8: 'Minimum 8 caractères', repeatMasterPassword: 'Répète le mot de passe maître', createVaultTooltip: 'Créer et chiffrer le coffre local', unlockTooltip: 'Déverrouiller avec le mot de passe maître', offlineOnly: 'Aucune synchronisation ni compte en ligne', newCredential: 'Nouvelle entrée', editCredential: 'Modifier l’identifiant', addCredential: 'Ajouter un identifiant', associateDescription: 'Associe ce compte à un lien web ou à une application Windows.', credentialName: 'Nom de l’identifiant', webLink: 'Lien web', windowsApp: 'Application Windows', appOrService: 'Application ou service', custom: 'Personnalisé', serviceName: 'Nom du service', loginLink: 'Lien de connexion', detectedApps: 'Applications détectées sur ce PC', refresh: 'Actualiser', selectApp: 'Sélectionner une application…', appName: 'Nom de l’application', category: 'Catégorie', generate: 'Générer', generateLater: 'Générer plus tard', generateSecure: 'Générer un mot de passe sécurisé', generateRandom: 'Créer un mot de passe aléatoire', length: 'Longueur', usefulNotes: 'Notes utiles pour ce compte…', saveChanges: 'Enregistrer les modifications', totp: 'Code TOTP / 2FA (optionnel)', historyTitle: 'Historique', historyDescription: 'Les dix dernières versions sont conservées localement et chiffrées.', historyPrivacy: 'Les mots de passe historiques ne sont jamais exportés par défaut dans l’interface.', previousVersion: 'Version précédente', modifiedOn: 'Modifié le', securityTitle: 'État de ton coffre', updateCheck: 'Vérifier les mises à jour'
  },
  en: {
    vault: 'My vault', all: 'All credentials', favorites: 'Favorites', categories: 'Categories', addCategory: 'Add a category', security: 'Security center', settings: 'Settings', newEntry: 'New credential', lockedLocally: 'Vault locked locally', search: 'Search credentials...', filter: 'Filter', connectionInfo: 'LOGIN INFORMATION', notes: 'NOTES', copyPassword: 'Copy password', modify: 'Edit', open: 'Open', openFill: 'Open and fill', history: 'History', secureFile: 'Secure file', password: 'Password', username: 'Username', link: 'Login link', service: 'Application / service', cancel: 'Cancel', addToVault: 'Add to vault', changeVault: 'Switch vault', newVault: 'New vault', import: 'Import', export: 'Export', recovery: 'Offline recovery', sync: 'Encrypted sync', autofill: 'Web autofill', language: 'Interface language', french: 'Français', english: 'English', save: 'Save', close: 'Close', createVault: 'Create your vault', unlockVault: 'Unlock the vault', openVault: 'Opening vault', checkingStorage: 'Checking encrypted local storage…', masterPassword: 'Master password', confirmPassword: 'Confirm password', createLocalVault: 'Create local vault', unlock: 'Unlock', processing: 'Processing…', createVaultDescription: 'Your vault will be stored locally and encrypted before it is written to disk.', unlockVaultDescription: 'Enter your master password to access your credentials.', minimum8: 'At least 8 characters', repeatMasterPassword: 'Repeat the master password', createVaultTooltip: 'Create and encrypt the local vault', unlockTooltip: 'Unlock with the master password', offlineOnly: 'No synchronization or online account', newCredential: 'New entry', editCredential: 'Edit credential', addCredential: 'Add a credential', associateDescription: 'Associate this account with a web link or a Windows application.', credentialName: 'Credential name', webLink: 'Web link', windowsApp: 'Windows application', appOrService: 'Application or service', custom: 'Custom', serviceName: 'Service name', loginLink: 'Login link', detectedApps: 'Applications detected on this PC', refresh: 'Refresh', selectApp: 'Select an application…', appName: 'Application name', category: 'Category', generate: 'Generate', generateLater: 'Generate later', generateSecure: 'Generate a secure password', generateRandom: 'Create a random password', length: 'Length', usefulNotes: 'Useful notes for this account…', saveChanges: 'Save changes', totp: 'TOTP / 2FA code (optional)', historyTitle: 'History', historyDescription: 'The last ten versions are kept locally and encrypted.', historyPrivacy: 'Previous passwords are never exported by default by the interface.', previousVersion: 'Previous version', modifiedOn: 'Modified on', securityTitle: 'Vault status', updateCheck: 'Check for updates'
  },
}

const extraTranslations: Record<Language, Record<string, string>> = {
  fr: {
    securityDescription: 'Analyse locale, sans envoyer tes mots de passe.', securityGood: 'Bonne protection', securityNeedsWork: 'Quelques améliorations nécessaires', securityScoreDescription: 'Le score est calculé uniquement à partir des entrées déchiffrées en mémoire.', breachPrivacyConfirm: 'Vaultly va envoyer uniquement les 5 premiers caractères des empreintes SHA-1, jamais les mots de passe complets. Continuer ?', weakPasswords: 'mot(s) de passe faible(s)', reusedPasswords: 'réutilisation(s)', analyzedEntries: 'entrée(s) analysée(s)', verifyBreaches: 'Vérifier les compromissions', checking: 'Vérification…', compromisedNow: 'À changer immédiatement', noCompromise: 'Aucun mot de passe trouvé dans la base consultée.', checkUnavailable: 'Vérification indisponible : aucun mot de passe n’a été transmis.', strengthen: 'À renforcer', reuseDetected: 'Réutilisations détectées', noObviousIssue: 'Aucun problème évident détecté.', checkTooltip: 'Vérifier les mots de passe avec une empreinte partielle', preferencesTitle: 'Préférences du coffre', localPreferences: 'Les réglages restent locaux à cette installation.', autoLockSection: 'VERROUILLAGE AUTOMATIQUE', autoLockLabel: 'Verrouiller après inactivité', autoLockDescription: 'Le mot de passe maître est retiré de la mémoire.', masterSection: 'MOT DE PASSE MAÎTRE', newPassword: 'Nouveau mot de passe', confirmation: 'Confirmation', changeMaster: 'Modifier le mot de passe maître', changing: 'Modification…', masterMismatch: 'Le nouveau mot de passe doit contenir 8 caractères minimum et les deux champs doivent correspondre.', masterChanged: 'Mot de passe maître modifié et coffre sauvegardé.', localVaults: 'COFFRES LOCAUX', localVault: 'Coffre local', previewMode: 'mode aperçu', encryptedSyncDescription: 'Copie uniquement le fichier Vaultly déjà chiffré vers un dossier local ou synchronisé par ton service de stockage.', recoveryDescription: 'Crée une copie chiffrée indépendante protégée par un code de récupération à conserver hors de l’ordinateur.', webAutofillDescription: 'Le pont local reste actif uniquement quand le coffre est déverrouillé. Installe l’extension Vaultly puis colle cette configuration dans ses options.', localBridge: 'Pont local', temporaryToken: 'jeton temporaire renouvelé au prochain démarrage.', importsExports: 'IMPORTS ET EXPORTS', importVaultKeePass: 'Importer un coffre / KeePass', exportVaultBackup: 'Exporter une sauvegarde Vaultly', exportKeePass: 'Exporter en KeePass (.kdbx)', automaticBackup: 'Une sauvegarde `.bak` est créée automatiquement à chaque enregistrement.', interfaceLocal: 'Les préférences d’interface restent locales.', settingsClose: 'Fermer', extensionConfig: 'Configuration de l’extension'
  },
  en: {
    securityDescription: 'Local analysis, without sending your passwords.', securityGood: 'Good protection', securityNeedsWork: 'Some improvements are needed', securityScoreDescription: 'The score is calculated only from credentials decrypted in memory.', breachPrivacyConfirm: 'Vaultly will send only the first 5 characters of SHA-1 hashes, never complete passwords. Continue?', weakPasswords: 'weak password(s)', reusedPasswords: 'password reuse(s)', analyzedEntries: 'entry/entries analyzed', verifyBreaches: 'Check for breaches', checking: 'Checking…', compromisedNow: 'Change immediately', noCompromise: 'No password was found in the consulted database.', checkUnavailable: 'Check unavailable: no password was transmitted.', strengthen: 'Strengthen', reuseDetected: 'Reuse detected', noObviousIssue: 'No obvious issue detected.', checkTooltip: 'Check passwords using a partial hash', preferencesTitle: 'Vault preferences', localPreferences: 'Settings remain local to this installation.', autoLockSection: 'AUTO-LOCK', autoLockLabel: 'Lock after inactivity', autoLockDescription: 'The master password is removed from memory.', masterSection: 'MASTER PASSWORD', newPassword: 'New password', confirmation: 'Confirmation', changeMaster: 'Change master password', changing: 'Changing…', masterMismatch: 'The new password must be at least 8 characters and both fields must match.', masterChanged: 'Master password changed and vault saved.', localVaults: 'LOCAL VAULTS', localVault: 'Local vault', previewMode: 'preview mode', encryptedSyncDescription: 'Copies only the already-encrypted Vaultly file to a local folder or a folder synchronized by your storage service.', recoveryDescription: 'Creates an independent encrypted copy protected by a recovery code to keep away from this computer.', webAutofillDescription: 'The local bridge is active only while the vault is unlocked. Install the Vaultly extension and paste this configuration into its options.', localBridge: 'Local bridge', temporaryToken: 'temporary token renewed on next startup.', importsExports: 'IMPORTS AND EXPORTS', importVaultKeePass: 'Import Vaultly / KeePass vault', exportVaultBackup: 'Export Vaultly backup', exportKeePass: 'Export as KeePass (.kdbx)', automaticBackup: 'A `.bak` backup is created automatically on every save.', interfaceLocal: 'Interface preferences remain local.', settingsClose: 'Close', extensionConfig: 'Extension configuration'
  }
}

const uiTranslations: Record<Language, Record<string, string>> = {
  fr: {
    credentialCount: 'identifiant(s)', quickSearch: 'pour rechercher rapidement', restoreSync: 'Récupérer depuis la synchronisation', restoreSyncTooltip: 'Restaurer la copie chiffrée du dossier dans ce coffre', syncRestored: 'Copie synchronisée restaurée', removeFile: 'Supprimer le fichier sécurisé', removeFileConfirm: 'Supprimer ce fichier du coffre chiffré ?', fileRemoved: 'Fichier sécurisé supprimé', totpDigits: 'Chiffres', totpPeriod: 'Période (secondes)', totpAlgorithm: 'Algorithme', invalidTotp: 'Le secret ou l’URI TOTP est invalide. Vérifie la valeur avant de continuer.', previewDesktop: 'Mode aperçu : lance l’application desktop pour activer le coffre local chiffré.', vaultPasswordPrompt: 'Mot de passe du coffre à ouvrir', vaultSwitched: 'Coffre changé avec succès', newVaultPasswordPrompt: 'Mot de passe du nouveau coffre (8 caractères minimum)', confirmNewVaultPassword: 'Confirme le mot de passe du nouveau coffre', passwordMismatch: 'Les mots de passe ne correspondent pas', newVaultCreated: 'Nouveau coffre local créé', desktopOnly: 'Cette action est disponible uniquement dans l’application desktop', recoveryOnly: 'Récupération disponible uniquement quand le coffre est déverrouillé', autofillConfirm: 'Vaultly va ouvrir {provider}, attendre quelques secondes puis saisir les identifiants. Continuer ?', autofillDone: 'Identifiants saisis dans {provider}', bridgeSessionNote: 'Le jeton reste valide pendant cette session, mais le pont est inactif lorsque le coffre est verrouillé.', masterMinError: 'Utilise au moins 8 caractères pour le mot de passe maître.', masterConfirmError: 'Les deux mots de passe ne correspondent pas.',
    strongPassword: 'Mot de passe fort', mediumPassword: 'Mot de passe moyen', strongShort: 'Fort', mediumShort: 'Moyen', lastModified: 'Dernière modification il y a 12 jours', appServiceLabel: 'Application / service', loginLinkLabel: 'Lien de connexion', identifierLabel: 'Identifiant', hidePassword: 'Masquer le mot de passe', showPassword: 'Afficher le mot de passe', copyIdentifier: 'Copier l’identifiant', copyTotp: 'Copier le code TOTP', openLoginLink: 'Ouvrir le lien de connexion', openApplication: 'Ouvrir', copiedPassword: 'Mot de passe copié dans le presse-papiers', secureFiles: 'FICHIERS SÉCURISÉS', restoreFile: 'Restaurer le fichier sur le disque', noNotes: 'Aucune note pour cette entrée.', createdOn: 'Créé le 18 août 2026', encryptedLocally: 'Chiffré localement', emptyVaultTitle: 'Ton coffre est prêt', emptyVaultDescription: 'Ajoute ton premier identifiant pour commencer.', restoreVersion: 'Restaurer cette version', restoreVersionConfirm: 'Remplacer le mot de passe actuel par cette version historique ?', versionRestored: 'Version historique restaurée et nouvelle version sauvegardée.', selectCredential: 'Sélectionner', updateUnavailable: 'Mise à jour indisponible', alreadyUpdated: 'Vaultly est déjà à jour', deleteCredentialConfirm: 'Supprimer', credentialDeleted: 'Identifiant supprimé', credentialUpdated: 'Identifiant modifié', credentialAdded: 'Identifiant ajouté au coffre', windowsHelloUnavailable: 'Windows Hello sera disponible dans une prochaine version', noNotifications: 'Aucune nouvelle notification', associateWeb: 'Associer l’entrée à un site web', associateDesktop: 'Associer l’entrée à un programme installé', prefill: 'Préremplir', customService: 'Saisir un service et un lien personnalisé', scanning: 'Analyse…', switchVaultTooltip: 'Changer de coffre local', categoriesHeading: 'CATÉGORIES', chooseCategory: 'Choisis une catégorie dans la liste', createCategory: 'Créer une nouvelle catégorie', accountActions: 'Actions du compte local', localAccount: 'Compte local', accountMessage: 'Compte local Vaultly', filterTooltip: 'Filtrer par catégorie ou favoris', showFilter: 'Afficher', sortTooltip: 'Changer le mode de tri', alphabetical: 'Ordre alphabétique', recent: 'Dernière modification', noSearchResults: 'Aucun identifiant ne correspond à cette recherche.', quickTip: 'Astuce : utilise', favoriteAdd: 'Ajouter aux favoris', favoriteRemove: 'Retirer des favoris', favoriteTooltip: 'Ajouter ou retirer des favoris', deleteEntry: 'Supprimer cette entrée'
  },
  en: {
    credentialCount: 'credential(s)', quickSearch: 'to search quickly', restoreSync: 'Restore from sync', restoreSyncTooltip: 'Restore the encrypted copy from the folder into this vault', syncRestored: 'Synchronized copy restored', removeFile: 'Delete secure file', removeFileConfirm: 'Delete this file from the encrypted vault?', fileRemoved: 'Secure file deleted', totpDigits: 'Digits', totpPeriod: 'Period (seconds)', totpAlgorithm: 'Algorithm', invalidTotp: 'The TOTP secret or URI is invalid. Check the value before continuing.', previewDesktop: 'Preview mode: launch the desktop application to enable the encrypted local vault.', vaultPasswordPrompt: 'Password for the vault to open', vaultSwitched: 'Vault switched successfully', newVaultPasswordPrompt: 'Password for the new vault (at least 8 characters)', confirmNewVaultPassword: 'Confirm the new vault password', passwordMismatch: 'The passwords do not match', newVaultCreated: 'New local vault created', desktopOnly: 'This action is available only in the desktop application', recoveryOnly: 'Recovery is available only while the vault is unlocked', autofillConfirm: 'Vaultly will open {provider}, wait a few seconds, then enter the credentials. Continue?', autofillDone: 'Credentials entered in {provider}', bridgeSessionNote: 'The token remains valid during this session, but the bridge is inactive while the vault is locked.', masterMinError: 'Use at least 8 characters for the master password.', masterConfirmError: 'The two passwords do not match.',
    strongPassword: 'Strong password', mediumPassword: 'Medium password', strongShort: 'Strong', mediumShort: 'Medium', lastModified: 'Last modified 12 days ago', appServiceLabel: 'Application / service', loginLinkLabel: 'Login link', identifierLabel: 'Username', hidePassword: 'Hide password', showPassword: 'Show password', copyIdentifier: 'Copy username', copyTotp: 'Copy TOTP code', openLoginLink: 'Open login link', openApplication: 'Open', copiedPassword: 'Password copied to clipboard', secureFiles: 'SECURE FILES', restoreFile: 'Restore file to disk', noNotes: 'No note for this entry.', createdOn: 'Created on August 18, 2026', encryptedLocally: 'Encrypted locally', emptyVaultTitle: 'Your vault is ready', emptyVaultDescription: 'Add your first credential to get started.', restoreVersion: 'Restore this version', restoreVersionConfirm: 'Replace the current password with this historical version?', versionRestored: 'Historical version restored and new version saved.', selectCredential: 'Select', updateUnavailable: 'Update unavailable', alreadyUpdated: 'Vaultly is already up to date', deleteCredentialConfirm: 'Delete', credentialDeleted: 'Credential deleted', credentialUpdated: 'Credential updated', credentialAdded: 'Credential added to vault', windowsHelloUnavailable: 'Windows Hello will be available in a future version', noNotifications: 'No new notifications', associateWeb: 'Associate the entry with a website', associateDesktop: 'Associate the entry with an installed application', prefill: 'Prefill', customService: 'Enter a custom service and link', scanning: 'Scanning…', switchVaultTooltip: 'Switch local vault', categoriesHeading: 'CATEGORIES', chooseCategory: 'Choose a category from the list', createCategory: 'Create a new category', accountActions: 'Local account actions', localAccount: 'Local account', accountMessage: 'Local Vaultly account', filterTooltip: 'Filter by category or favorites', showFilter: 'Show', sortTooltip: 'Change sort order', alphabetical: 'Alphabetical order', recent: 'Last modified', noSearchResults: 'No credential matches this search.', quickTip: 'Tip: use', favoriteAdd: 'Add to favorites', favoriteRemove: 'Remove from favorites', favoriteTooltip: 'Add or remove from favorites', deleteEntry: 'Delete this entry'
  }
}

const operationalTranslations: Record<Language, Record<string, string>> = {
  fr: {
    openVaultError: 'Impossible d’ouvrir ce coffre : {error}', createVaultError: 'Création impossible : {error}', saveError: 'Sauvegarde impossible : {error}', autoLocked: 'Coffre verrouillé automatiquement après une période d’inactivité.', launchError: 'Impossible de lancer l’application : {error}', autofillError: 'Saisie automatique impossible : {error}', vaultExported: 'Coffre exporté avec succès', exportError: 'Export impossible : {error}', syncDone: 'Coffre chiffré synchronisé vers {destination}', syncError: 'Synchronisation impossible : {error}', restoreError: 'Restauration impossible : {error}', updatePrompt: 'Une mise à jour Vaultly {version} est disponible.{notes}\n\nLa mise à jour est signée et sera installée après téléchargement. Continuer ?', recoveryAlert: 'Code de récupération Vaultly :\n\n{code}\n\nNote-le dans un gestionnaire ou un support sûr. Il sera nécessaire pour ouvrir le fichier de récupération.', recoveryCreated: 'Sauvegarde de récupération créée', recoveryError: 'Sauvegarde de récupération impossible : {error}', keepassPasswordPrompt: 'Choisis un mot de passe pour le fichier KeePass exporté (8 caractères minimum)', keepassExported: 'Coffre KeePass exporté avec succès', keepassExportError: 'Export KeePass impossible : {error}', importPasswordPrompt: 'Mot de passe du coffre à importer', importedKeepassCount: '{count} identifiant(s) KeePass importé(s)', vaultImported: 'Coffre importé et sauvegardé localement', importError: 'Import impossible : {error}', fileEncrypted: 'Fichier « {name} » chiffré dans l’entrée', fileAddError: 'Ajout du fichier impossible : {error}', fileRestored: 'Fichier « {name} » restauré', fileRestoreError: 'Restauration impossible : {error}', favoriteRemoved: 'Retiré des favoris', favoriteAdded: 'Ajouté aux favoris', newCategoryPrompt: 'Nom de la nouvelle catégorie', categoryCreated: 'Catégorie « {name} » créée', deleteEntryConfirm: 'Supprimer « {title} » du coffre ?', entryDeleted: 'Identifiant supprimé', entryUpdated: 'Identifiant modifié', entryAdded: 'Identifiant ajouté au coffre', scanUnavailable: 'Scan indisponible : {error}', connectorLabel: 'Profil de saisie', genericConnector: 'Générique (Tab + Entrée)', battleNetConnector: 'Battle.net', steamConnector: 'Steam', epicConnector: 'Epic Games', discordConnector: 'Discord', microsoftConnector: 'Microsoft', googleConnector: 'Google', recoveryRestore: 'Restaurer une sauvegarde', recoveryCodePrompt: 'Saisis le code de récupération du fichier', recoveryRestoreError: 'Restauration de récupération impossible : {error}', recoveryRestored: 'Sauvegarde de récupération restaurée dans le coffre courant', secretPromptDescription: 'La saisie est protégée et n’est pas affichée à l’écran.', continueAction: 'Continuer', exampleCredential: 'Ex. Compte Call of Duty', exampleService: 'Ex. Battle.net', exampleEmail: 'email@exemple.fr'
  },
  en: {
    openVaultError: 'Unable to open this vault: {error}', createVaultError: 'Creation failed: {error}', saveError: 'Save failed: {error}', autoLocked: 'Vault automatically locked after a period of inactivity.', launchError: 'Unable to launch the application: {error}', autofillError: 'Automatic entry failed: {error}', vaultExported: 'Vault exported successfully', exportError: 'Export failed: {error}', syncDone: 'Encrypted vault synchronized to {destination}', syncError: 'Synchronization failed: {error}', restoreError: 'Restore failed: {error}', updatePrompt: 'A Vaultly update ({version}) is available.{notes}\n\nThe update is signed and will be installed after download. Continue?', recoveryAlert: 'Vaultly recovery code:\n\n{code}\n\nWrite it down in a password manager or another safe place. It will be required to open the recovery file.', recoveryCreated: 'Recovery backup created', recoveryError: 'Recovery backup failed: {error}', keepassPasswordPrompt: 'Choose a password for the exported KeePass file (at least 8 characters)', keepassExported: 'KeePass vault exported successfully', keepassExportError: 'KeePass export failed: {error}', importPasswordPrompt: 'Password for the vault to import', importedKeepassCount: '{count} KeePass credential(s) imported', vaultImported: 'Vault imported and saved locally', importError: 'Import failed: {error}', fileEncrypted: 'File “{name}” encrypted in the entry', fileAddError: 'Unable to add the file: {error}', fileRestored: 'File “{name}” restored', fileRestoreError: 'Restore failed: {error}', favoriteRemoved: 'Removed from favorites', favoriteAdded: 'Added to favorites', newCategoryPrompt: 'Name of the new category', categoryCreated: 'Category “{name}” created', deleteEntryConfirm: 'Delete “{title}” from the vault?', entryDeleted: 'Credential deleted', entryUpdated: 'Credential updated', entryAdded: 'Credential added to the vault', scanUnavailable: 'Scan unavailable: {error}', connectorLabel: 'Input profile', genericConnector: 'Generic (Tab + Enter)', battleNetConnector: 'Battle.net', steamConnector: 'Steam', epicConnector: 'Epic Games', discordConnector: 'Discord', microsoftConnector: 'Microsoft', googleConnector: 'Google', recoveryRestore: 'Restore a backup', recoveryCodePrompt: 'Enter the recovery code for the file', recoveryRestoreError: 'Unable to restore the recovery backup: {error}', recoveryRestored: 'Recovery backup restored to the current vault', secretPromptDescription: 'Your input is protected and is not shown on screen.', continueAction: 'Continue', exampleCredential: 'E.g. Call of Duty account', exampleService: 'E.g. Battle.net', exampleEmail: 'email@example.com'
  }
}

const vaultTranslations: Record<Language, Record<string, string>> = {
  fr: { recentVaults: 'Coffres récemment utilisés', openRecentVault: 'Ouvrir ce coffre' },
  en: { recentVaults: 'Recently used vaults', openRecentVault: 'Open this vault' },
}

function useI18n() { return useContext(I18nContext) }

function Root() {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('vaultly.language') === 'en' ? 'en' : 'fr')
  useEffect(() => { localStorage.setItem('vaultly.language', language); document.documentElement.lang = language }, [language])
  const value = useMemo<I18nValue>(() => ({ language, setLanguage, t: (key) => translations[language][key] ?? extraTranslations[language][key] ?? uiTranslations[language][key] ?? operationalTranslations[language][key] ?? vaultTranslations[language][key] ?? translations.fr[key] ?? extraTranslations.fr[key] ?? uiTranslations.fr[key] ?? operationalTranslations.fr[key] ?? vaultTranslations.fr[key] ?? key }), [language])
  return <I18nContext.Provider value={value}><App /></I18nContext.Provider>
}

function App() {
  const { language, t } = useI18n()
  const [entries, setEntries] = useState(initialEntries)
  const [selectedId, setSelectedId] = useState(1)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY)
  const [showModal, setShowModal] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [copied, setCopied] = useState(false)
  const [categories, setCategories] = useState(defaultCategories)
  const [filterOpen, setFilterOpen] = useState(false)
  const [sortAlphabetical, setSortAlphabetical] = useState(false)
  const [toast, setToast] = useState('')
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null)
  const [showSecurityPanel, setShowSecurityPanel] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [autoLockMinutes, setAutoLockMinutes] = useState(loadAutoLockMinutes)
  const searchRef = useRef<HTMLInputElement>(null)
  const activityRef = useRef(Date.now())
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>('loading')
  const [vaultPath, setVaultPath] = useState('')
  const [masterPassword, setMasterPassword] = useState('')
  const [vaultError, setVaultError] = useState('')
  const [bridgeInfo, setBridgeInfo] = useState<BridgeInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [secretPrompt, setSecretPrompt] = useState<SecretPromptRequest | null>(null)
  const [recentVaults, setRecentVaults] = useState<string[]>(loadRecentVaults)

  useEffect(() => {
    void initializeVault()
  }, [])

  useEffect(() => {
    if (vaultStatus !== 'unlocked') return
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart']
    const updateActivity = () => { activityRef.current = Date.now() }
    events.forEach((event) => window.addEventListener(event, updateActivity))
    const timer = window.setInterval(() => {
      if (Date.now() - activityRef.current > autoLockMinutes * 60_000) lockVault()
    }, 15_000)
    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity))
      window.clearInterval(timer)
    }
  }, [vaultStatus, autoLockMinutes])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => { localStorage.setItem('vaultly.autoLockMinutes', String(autoLockMinutes)) }, [autoLockMinutes])

  useEffect(() => { localStorage.setItem('vaultly.recentVaults', JSON.stringify(recentVaults)) }, [recentVaults])

  useEffect(() => {
    if (!vaultPath) return
    setRecentVaults((current) => [vaultPath, ...current.filter((path) => path !== vaultPath)].slice(0, 8))
  }, [vaultPath])

  useEffect(() => {
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (secretPrompt) { resolveSecretPrompt(null); return }
      if (showModal) { setShowModal(false); setEditingEntry(null); return }
      if (showHistory) { setShowHistory(false); return }
      if (showSecurityPanel) { setShowSecurityPanel(false); return }
      if (showSettings) setShowSettings(false)
    }
    window.addEventListener('keydown', closeWithEscape)
    return () => window.removeEventListener('keydown', closeWithEscape)
  }, [secretPrompt, showModal, showHistory, showSecurityPanel, showSettings])

  function promptSecret(title: string) {
    return new Promise<string | null>((resolve) => setSecretPrompt({ title, resolve }))
  }

  function resolveSecretPrompt(value: string | null) {
    const request = secretPrompt
    setSecretPrompt(null)
    request?.resolve(value)
  }

  async function initializeVault() {
    try {
      const path = await invoke<string>('default_vault_path')
      const exists = await invoke<boolean>('vault_exists', { path })
      setVaultPath(path)
      setVaultStatus(exists ? 'unlock' : 'create')
    } catch {
      setVaultError(t('previewDesktop'))
      setVaultStatus('create')
    }
  }

  async function createVault(password: string) {
    try {
      const firstEntries = vaultPath ? [] : initialEntries
      if (vaultPath) {
        await invoke('save_vault', { path: vaultPath, password, data: JSON.stringify(firstEntries) })
      }
      await updateAutofillBridge(firstEntries)
      setEntries(firstEntries)
      setCategories(defaultCategories)
      setSelectedId(firstEntries[0]?.id ?? 0)
      setMasterPassword(password)
      setVaultError('')
      setVaultStatus('unlocked')
    } catch (error) {
      setVaultError(String(error))
    }
  }

  async function unlockVault(password: string) {
    try {
      const raw = await invoke<string>('open_vault', { path: vaultPath, password })
      const storedEntries = JSON.parse(raw) as Entry[]
      if (!Array.isArray(storedEntries)) throw new Error('Le coffre ne contient pas une liste valide.')
      await updateAutofillBridge(storedEntries)
      setEntries(storedEntries)
      setCategories(Array.from(new Set([...defaultCategories, ...storedEntries.map((entry) => entry.category).filter(Boolean)])))
      setSelectedId(storedEntries[0]?.id ?? 0)
      setMasterPassword(password)
      setVaultError('')
      setVaultStatus('unlocked')
    } catch (error) {
      setVaultError(String(error))
    }
  }

  async function updateAutofillBridge(nextEntries: Entry[]) {
    try {
      const info = await invoke<BridgeInfo>('start_autofill_bridge', { data: JSON.stringify(nextEntries) })
      setBridgeInfo(info)
    } catch {
      setBridgeInfo(null)
    }
  }

  async function openVaultAtPath(source: string) {
    if (source === vaultPath) return
    const password = await promptSecret(t('vaultPasswordPrompt'))
    if (!password) return
    const raw = await invoke<string>('open_vault', { path: source, password })
    const nextEntries = JSON.parse(raw) as Entry[]
    if (!Array.isArray(nextEntries)) throw new Error('Le coffre sélectionné est invalide.')
    setEntries(nextEntries)
    setCategories(Array.from(new Set([...defaultCategories, ...nextEntries.map((entry) => entry.category).filter(Boolean)])))
    setSelectedId(nextEntries[0]?.id ?? 0)
    setVaultPath(source)
    setMasterPassword(password)
    setActiveCategory(ALL_CATEGORY)
    await updateAutofillBridge(nextEntries)
    notify(t('vaultSwitched'))
  }

  async function switchVault() {
    try {
      const source = await open({ multiple: false, directory: false, filters: [{ name: 'Coffre Vaultly', extensions: ['vault'] }] })
      if (typeof source !== 'string') return
      await openVaultAtPath(source)
    } catch (error) {
      notify(interpolate(t('openVaultError'), { error: String(error) }))
    }
  }

  async function openRecentVault(source: string) {
    try {
      await openVaultAtPath(source)
    } catch (error) {
      notify(interpolate(t('openVaultError'), { error: String(error) }))
    }
  }

  async function createNewVault() {
    try {
      const destination = await save({ defaultPath: 'Nouveau-coffre.vault', filters: [{ name: 'Coffre Vaultly', extensions: ['vault'] }] })
      if (typeof destination !== 'string') return
      const password = await promptSecret(t('newVaultPasswordPrompt'))
      if (!password) return
      const confirmation = await promptSecret(t('confirmNewVaultPassword'))
      if (password !== confirmation) return notify(t('passwordMismatch'))
      await invoke('save_vault', { path: destination, password, data: JSON.stringify([]) })
      setEntries([])
      setCategories(defaultCategories)
      setSelectedId(0)
      setVaultPath(destination)
      setMasterPassword(password)
      setActiveCategory(ALL_CATEGORY)
      await updateAutofillBridge([])
      notify(t('newVaultCreated'))
    } catch (error) {
      notify(interpolate(t('createVaultError'), { error: String(error) }))
    }
  }

  async function persistEntries(nextEntries: Entry[]) {
    if (!vaultPath || !masterPassword) return
    try {
      await invoke('save_vault', { path: vaultPath, password: masterPassword, data: JSON.stringify(nextEntries) })
      void updateAutofillBridge(nextEntries)
    } catch (error) {
      setVaultError(interpolate(t('saveError'), { error: String(error) }))
    }
  }

  function lockVault() {
    void invoke('stop_autofill_bridge').catch(() => undefined)
    void navigator.clipboard?.writeText('')
    setBridgeInfo(null)
    setEntries([])
    setSelectedId(0)
    setMasterPassword('')
    setShowPassword(false)
    setVaultError(t('autoLocked'))
    setVaultStatus('unlock')
  }

  async function openAssociatedApplication(path: string) {
    try {
      await invoke('launch_application', { path })
    } catch (error) {
      setVaultError(interpolate(t('launchError'), { error: String(error) }))
    }
  }

  async function autofillAssociatedApplication(entry: Entry) {
    if (!entry.applicationPath) return
    if (!window.confirm(interpolate(t('autofillConfirm'), { provider: entry.provider }))) return
    try {
      const totp = entry.totpSecret && entry.autofillAdapter ? await calculateTotp(entry.totpSecret, entry.totpDigits, entry.totpPeriod, entry.totpAlgorithm) : undefined
      await invoke('launch_and_autofill', { path: entry.applicationPath, username: entry.username, password: entry.password, adapter: entry.autofillAdapter, totp })
      notify(interpolate(t('autofillDone'), { provider: entry.provider }))
    } catch (error) {
      notify(interpolate(t('autofillError'), { error: String(error) }))
    }
  }

  async function exportVault() {
    if (!vaultPath) return notify(t('desktopOnly'))
    try {
      const destination = await save({ defaultPath: 'Vaultly-backup.vault', filters: [{ name: 'Coffre Vaultly', extensions: ['vault'] }] })
      if (typeof destination === 'string') {
        await invoke('copy_vault', { source: vaultPath, destination })
        notify(t('vaultExported'))
      }
    } catch (error) {
      notify(interpolate(t('exportError'), { error: String(error) }))
    }
  }

  function copyBridgeConfig() {
    if (!bridgeInfo) return notify(t('desktopOnly'))
    copyValue(JSON.stringify({ port: bridgeInfo.port, token: bridgeInfo.token }), t('extensionConfig'))
  }

  async function syncVault() {
    if (!vaultPath) return notify(t('desktopOnly'))
    try {
      const folder = await open({ multiple: false, directory: true })
      if (typeof folder !== 'string') return
      const destination = await invoke<string>('sync_vault_to_folder', { source: vaultPath, folder })
      notify(interpolate(t('syncDone'), { destination }))
    } catch (error) {
      notify(interpolate(t('syncError'), { error: String(error) }))
    }
  }

  async function restoreSyncedVault() {
    if (!vaultPath || !masterPassword) return notify(t('recoveryOnly'))
    try {
      const folder = await open({ multiple: false, directory: true })
      if (typeof folder !== 'string') return
      const raw = await invoke<string>('restore_vault_from_folder', { folder, destination: vaultPath, password: masterPassword })
      const restoredEntries = JSON.parse(raw) as Entry[]
      if (!Array.isArray(restoredEntries)) throw new Error('La copie synchronisée est invalide.')
      setEntries(restoredEntries)
      setCategories(Array.from(new Set([...defaultCategories, ...restoredEntries.map((entry) => entry.category).filter(Boolean)])))
      setSelectedId(restoredEntries[0]?.id ?? 0)
      setActiveCategory(ALL_CATEGORY)
      await updateAutofillBridge(restoredEntries)
      notify(t('syncRestored'))
    } catch (error) {
      notify(interpolate(t('restoreError'), { error: String(error) }))
    }
  }

  async function checkForUpdates() {
    if (updateBusy) return
    setUpdateBusy(true)
    try {
      const update = await check()
      if (!update) {
        notify(t('alreadyUpdated'))
        return
      }
      const notes = update.body ? `\n\n${update.body}` : ''
      if (!window.confirm(interpolate(t('updatePrompt'), { version: update.version, notes }))) return
      await update.downloadAndInstall()
      await relaunch()
    } catch (error) {
      notify(`${t('updateUnavailable')} : ${String(error)}`)
    } finally {
      setUpdateBusy(false)
    }
  }

  async function exportRecoveryBackup() {
    if (!vaultPath || !masterPassword) return notify(t('recoveryOnly'))
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const values = new Uint32Array(24)
    crypto.getRandomValues(values)
    const recoveryPassword = Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
    window.alert(interpolate(t('recoveryAlert'), { code: recoveryPassword }))
    try {
      const destination = await save({ defaultPath: 'Vaultly-recovery.vault', filters: [{ name: 'Sauvegarde de récupération', extensions: ['vault'] }] })
      if (typeof destination !== 'string') return
      await invoke('create_recovery_backup', { source: vaultPath, currentPassword: masterPassword, destination, recoveryPassword })
      notify(t('recoveryCreated'))
    } catch (error) {
      notify(interpolate(t('recoveryError'), { error: String(error) }))
    }
  }

  async function restoreRecoveryBackup() {
    if (!vaultPath || !masterPassword) return notify(t('recoveryOnly'))
    try {
      const source = await open({ multiple: false, directory: false, filters: [{ name: 'Sauvegarde de récupération', extensions: ['vault'] }] })
      if (typeof source !== 'string') return
      const recoveryPassword = await promptSecret(t('recoveryCodePrompt'))
      if (!recoveryPassword) return
      const raw = await invoke<string>('open_vault', { path: source, password: recoveryPassword })
      const restoredEntries = JSON.parse(raw) as Entry[]
      if (!Array.isArray(restoredEntries)) throw new Error('Format de récupération invalide')
      await invoke('save_vault', { path: vaultPath, password: masterPassword, data: JSON.stringify(restoredEntries) })
      setEntries(restoredEntries)
      setCategories(Array.from(new Set([...defaultCategories, ...restoredEntries.map((entry) => entry.category).filter(Boolean)])))
      setSelectedId(restoredEntries[0]?.id ?? 0)
      setActiveCategory(ALL_CATEGORY)
      await updateAutofillBridge(restoredEntries)
      notify(t('recoveryRestored'))
    } catch (error) {
      notify(interpolate(t('recoveryRestoreError'), { error: String(error) }))
    }
  }

  async function exportKeePass() {
    if (!vaultPath) return notify(t('desktopOnly'))
    const exportPassword = await promptSecret(t('keepassPasswordPrompt'))
    if (!exportPassword) return
    try {
      const destination = await save({ defaultPath: 'Vaultly-export.kdbx', filters: [{ name: 'Coffre KeePass', extensions: ['kdbx'] }] })
      if (typeof destination !== 'string') return
      await invoke('export_kdbx', { path: destination, password: exportPassword, data: JSON.stringify(entries) })
      notify(t('keepassExported'))
    } catch (error) {
      notify(interpolate(t('keepassExportError'), { error: String(error) }))
    }
  }

  async function importVault() {
    if (!vaultPath) return notify(t('desktopOnly'))
    try {
      const source = await open({ multiple: false, directory: false, filters: [{ name: 'Coffres Vaultly ou KeePass', extensions: ['vault', 'kdbx', 'kdb'] }] })
      if (typeof source !== 'string') return
      const importedPassword = await promptSecret(t('importPasswordPrompt'))
      if (!importedPassword) return
      const isKeePass = /\.(kdbx?|KDBX?)$/.test(source)
      if (isKeePass) {
        const raw = await invoke<string>('import_kdbx', { path: source, password: importedPassword })
        const imported = JSON.parse(raw) as Array<{ title: string; username: string; password: string; url: string; notes?: string; totpSecret?: string; group?: string }>
        if (!Array.isArray(imported)) throw new Error('Format KeePass invalide')
        const importedCategories = Array.from(new Set(imported.map((item) => item.group?.trim()).filter((value): value is string => Boolean(value))))
        setCategories((current) => Array.from(new Set([...current, ...importedCategories])))
        const importedEntries: Entry[] = imported.map((item, index) => {
          const totp = parseTotpSettings(item.totpSecret)
          return {
            id: Date.now() + index,
            title: item.title || 'Identifiant KeePass',
            provider: 'KeePass',
            username: item.username || 'Non renseigné',
            password: item.password || '',
            url: item.url || 'https://',
            category: item.group?.trim() || (categories.includes('Personnel') ? 'Personnel' : categories[0] ?? 'Personnel'),
            icon: '✦',
            color: '#7c5cff',
            notes: item.notes || 'Importé depuis un coffre KeePass.',
            totpSecret: totp?.secret,
            totpDigits: totp?.digits,
            totpPeriod: totp?.period,
            totpAlgorithm: totp?.algorithm,
            updatedAt: new Date().toISOString().slice(0, 10),
            strength: (item.password?.length ?? 0) >= 12 ? 'Fort' : 'Moyen',
          }
        })
        const nextEntries = [...entries, ...importedEntries]
        setEntries(nextEntries)
        setSelectedId(importedEntries[0]?.id ?? selectedId)
        await invoke('save_vault', { path: vaultPath, password: masterPassword, data: JSON.stringify(nextEntries) })
        notify(interpolate(t('importedKeepassCount'), { count: String(importedEntries.length) }))
        return
      }

      const raw = await invoke<string>('open_vault', { path: source, password: importedPassword })
      const importedEntries = JSON.parse(raw) as Entry[]
      if (!Array.isArray(importedEntries)) throw new Error('Format de coffre invalide')
      setEntries(importedEntries)
      setCategories(Array.from(new Set([...defaultCategories, ...importedEntries.map((entry) => entry.category).filter(Boolean)])))
      setSelectedId(importedEntries[0]?.id ?? 0)
      await invoke('save_vault', { path: vaultPath, password: masterPassword, data: JSON.stringify(importedEntries) })
      notify(t('vaultImported'))
    } catch (error) {
      notify(interpolate(t('importError'), { error: String(error) }))
    }
  }

  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }

  function copyValue(value: string, label: string) {
    navigator.clipboard?.writeText(value)
    notify(language === 'fr' ? `${label} copié dans le presse-papiers` : `${label} copied to the clipboard`)
    window.setTimeout(() => navigator.clipboard?.writeText(''), 20_000)
  }

  async function addSecureAttachment(entry: Entry) {
    try {
      const source = await open({ multiple: false, directory: false })
      if (typeof source !== 'string') return
      const raw = await invoke<string>('read_file_base64', { path: source })
      const name = source.split(/[\\/]/).pop() || 'fichier'
      const attachment: SecureAttachment = { name, data: raw, size: Math.floor(raw.length * 0.75) }
      const nextEntries = entries.map((current) => current.id === entry.id ? { ...current, attachments: [...(current.attachments ?? []), attachment] } : current)
      setEntries(nextEntries)
      await persistEntries(nextEntries)
      notify(interpolate(t('fileEncrypted'), { name }))
    } catch (error) {
      notify(interpolate(t('fileAddError'), { error: String(error) }))
    }
  }

  async function downloadSecureAttachment(attachment: SecureAttachment) {
    try {
      const destination = await save({ defaultPath: attachment.name })
      if (typeof destination !== 'string') return
      await invoke('write_file_base64', { path: destination, data: attachment.data })
      notify(interpolate(t('fileRestored'), { name: attachment.name }))
    } catch (error) {
      notify(interpolate(t('fileRestoreError'), { error: String(error) }))
    }
  }

  function removeSecureAttachment(entry: Entry, attachment: SecureAttachment) {
    if (!window.confirm(t('removeFileConfirm'))) return
    const nextEntries = entries.map((current) => current.id === entry.id
      ? { ...current, attachments: (current.attachments ?? []).filter((item) => item !== attachment) }
      : current)
    setEntries(nextEntries)
    void persistEntries(nextEntries)
    notify(t('fileRemoved'))
  }

  function toggleFavorite() {
    if (!selected) return
    const nextEntries = entries.map((entry) => entry.id === selected.id ? { ...entry, favorite: !entry.favorite } : entry)
    setEntries(nextEntries)
    void persistEntries(nextEntries)
    notify(selected.favorite ? t('favoriteRemoved') : t('favoriteAdded'))
  }

  function addCategory() {
    const name = window.prompt(t('newCategoryPrompt'))?.trim()
    if (!name || categories.includes(name)) return
    setCategories((current) => [...current, name])
    setActiveCategory(name)
    notify(interpolate(t('categoryCreated'), { name }))
  }

  function editSelected() {
    if (!selected) return
    setEditingEntry(selected)
    setShowModal(true)
  }

  function deleteSelected() {
    if (!selected) return
    if (!window.confirm(interpolate(t('deleteEntryConfirm'), { title: selected.title }))) return
    const nextEntries = entries.filter((entry) => entry.id !== selected.id)
    setEntries(nextEntries)
    setSelectedId(nextEntries[0]?.id ?? 0)
    void persistEntries(nextEntries)
    notify(t('entryDeleted'))
  }

  function saveEntry(entry: Entry) {
    const nextEntries = editingEntry
      ? entries.map((current) => current.id === entry.id ? {
        ...entry,
        updatedAt: new Date().toISOString().slice(0, 10),
        history: current.password !== entry.password
          ? [...(current.history ?? []), { password: current.password, changedAt: new Date().toISOString().slice(0, 10) }].slice(-10)
          : current.history,
      } : current)
      : [{ ...entry, updatedAt: new Date().toISOString().slice(0, 10) }, ...entries]
    setEntries(nextEntries)
    setSelectedId(entry.id)
    setEditingEntry(null)
    setShowModal(false)
    setActiveCategory(ALL_CATEGORY)
    void persistEntries(nextEntries)
    notify(editingEntry ? t('entryUpdated') : t('entryAdded'))
  }

  function restoreHistoryVersion(password: string) {
    if (!selected || !window.confirm(t('restoreVersionConfirm'))) return
    const today = new Date().toISOString().slice(0, 10)
    const nextEntries = entries.map((current) => current.id === selected.id ? {
      ...current,
      password,
      updatedAt: today,
      history: [...(current.history ?? []), { password: current.password, changedAt: today }].slice(-10),
      strength: password.length >= 12 ? 'Fort' as const : 'Moyen' as const,
    } : current)
    setEntries(nextEntries)
    setShowHistory(false)
    void persistEntries(nextEntries)
    notify(t('versionRestored'))
  }

  const filteredEntries = useMemo(() => entries.filter((entry) => {
    const matchesSearch = `${entry.title} ${entry.provider} ${entry.username}`.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = activeCategory === ALL_CATEGORY || (activeCategory === FAVORITES_CATEGORY ? entry.favorite : entry.category === activeCategory)
    return matchesSearch && matchesCategory
  }).sort((left, right) => sortAlphabetical ? left.title.localeCompare(right.title, 'fr') : right.id - left.id), [entries, search, activeCategory, sortAlphabetical])

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0]

  function copyPassword() {
    copyValue(selected?.password ?? '', t('password'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  if (vaultStatus !== 'unlocked') {
    return <MasterPasswordGate status={vaultStatus} error={vaultError} onCreate={createVault} onUnlock={unlockVault} />
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><LockKeyhole size={19} /></div><span>vaultly</span></div>
        <button className="vault-switcher" aria-label={t('switchVaultTooltip')} data-tooltip={t('switchVaultTooltip')} onClick={() => void switchVault()}><span className="vault-dot" /> {vaultPath ? vaultPath.split(/[\\/]/).pop()?.replace(/\.vault$/i, '') : t('vault')} <ChevronDown size={15} /></button>
        <nav className="nav-section">
          <p className="eyebrow">{t('vault').toUpperCase()}</p>
          <NavItem icon={<KeyRound size={17} />} label={t('all')} active={activeCategory === ALL_CATEGORY} onClick={() => setActiveCategory(ALL_CATEGORY)} count={entries.length} />
          <NavItem icon={<Star size={17} />} label={t('favorites')} active={activeCategory === FAVORITES_CATEGORY} onClick={() => setActiveCategory(FAVORITES_CATEGORY)} count={entries.filter((entry) => entry.favorite).length} />
          <NavItem icon={<Folder size={17} />} label={t('categories')} onClick={() => { setActiveCategory(categories[0] ?? ALL_CATEGORY); notify(t('chooseCategory')) }} />
        </nav>
        <nav className="nav-section categories">
          <p className="eyebrow">{t('categoriesHeading')}</p>
          {categories.map((category) => <NavItem key={category} icon={<span className="category-dot" />} label={category} active={activeCategory === category} onClick={() => setActiveCategory(category)} />)}
          <button className="add-category" aria-label={t('createCategory')} data-tooltip={t('createCategory')} onClick={addCategory}><Plus size={15} /> {t('addCategory')}</button>
        </nav>
        <div className="sidebar-bottom"><NavItem icon={<ShieldCheck size={17} />} label={t('security')} badge="92" onClick={() => setShowSecurityPanel(true)} /><NavItem icon={<Settings2 size={17} />} label={t('settings')} onClick={() => setShowSettings(true)} /></div>
        <div className="profile"><div className="avatar">AM</div><div><strong>Alex Martin</strong><span>{t('localAccount')}</span></div><button className="profile-menu" aria-label={t('accountActions')} data-tooltip={t('accountActions')} onClick={() => notify(t('accountMessage'))}><MoreHorizontal size={18} className="muted" /></button></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div><p className="breadcrumb">{t('vault')} <span>/</span> {activeCategory === ALL_CATEGORY ? t('all') : activeCategory === FAVORITES_CATEGORY ? t('favorites') : activeCategory}</p><h1>{activeCategory === ALL_CATEGORY ? t('all') : activeCategory === FAVORITES_CATEGORY ? t('favorites') : activeCategory}</h1></div><div className="top-actions"><div className="secure-pill"><span className="secure-dot" /> {t('lockedLocally')}</div><button className="icon-button" data-tooltip={t('windowsHelloUnavailable')} aria-label={t('windowsHelloUnavailable')} onClick={() => notify(t('windowsHelloUnavailable'))}><Fingerprint size={19} /></button><button className="icon-button" data-tooltip={t('updateCheck')} aria-label={t('updateCheck')} onClick={() => void checkForUpdates()} disabled={updateBusy}><Download size={17} /></button><button className="icon-button" data-tooltip={t('noNotifications')} aria-label={t('noNotifications')} onClick={() => notify(t('noNotifications'))}><BellIcon /></button><button className="new-button" data-tooltip={t('newEntry')} onClick={() => setShowModal(true)}><Plus size={18} /> {t('newEntry')}</button></div></header>
        <section className="content-grid">
          <div className="list-panel">
            <div className="list-toolbar"><div className="search-box"><Search size={18} /><input ref={searchRef} placeholder={t('search')} value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="filter-wrap"><button className="filter-button" aria-label={t('filterTooltip')} data-tooltip={t('filterTooltip')} onClick={() => setFilterOpen((value) => !value)}><Tag size={16} /> {t('filter')}</button>{filterOpen && <div className="filter-menu">{[{ value: ALL_CATEGORY, label: t('all') }, { value: FAVORITES_CATEGORY, label: t('favorites') }, ...categories.map((category) => ({ value: category, label: category }))].map((filter) => <button key={filter.value} aria-label={`${t('showFilter')} ${filter.label.toLowerCase()}`} data-tooltip={`${t('showFilter')} ${filter.label.toLowerCase()}`} onClick={() => { setActiveCategory(filter.value); setFilterOpen(false) }}>{filter.label}</button>)}</div>}</div></div>
            <div className="list-summary"><span>{filteredEntries.length} {t('credentialCount')}</span><button className="sort-label" aria-label={t('sortTooltip')} data-tooltip={t('sortTooltip')} onClick={() => setSortAlphabetical((value) => !value)}>{sortAlphabetical ? t('alphabetical') : t('recent')} <ChevronDown size={14} /></button></div>
            <div className="entry-list">{filteredEntries.map((entry) => <EntryRow key={entry.id} entry={entry} selected={entry.id === selectedId} onClick={() => { setSelectedId(entry.id); setShowPassword(false) }} />)}{filteredEntries.length === 0 && <div className="empty-state">{t('noSearchResults')}</div>}</div>
            <div className="list-footer"><Sparkles size={16} /><span>{t('quickTip')} <kbd>Ctrl</kbd> + <kbd>K</kbd> {t('quickSearch')}.</span></div>
          </div>

          {selected && <section className="detail-panel">
            <div className="detail-header"><div className="detail-app-icon" style={{ background: selected.color }}>{selected.icon}</div><div><div className="detail-title-row"><h2>{selected.title}</h2><button className="star-button" aria-label={selected.favorite ? t('favoriteRemove') : t('favoriteAdd')} data-tooltip={t('favoriteTooltip')} onClick={toggleFavorite}><Star size={18} fill={selected.favorite ? 'currentColor' : 'none'} /></button></div><p>{selected.provider} <span className="separator">•</span> {selected.category}</p></div><button className="more-button" aria-label={t('deleteEntry')} data-tooltip={t('deleteEntry')} onClick={deleteSelected}><MoreHorizontal size={20} /></button></div>
            <div className="strength-card"><div className="strength-icon"><ShieldCheck size={19} /></div><div className="strength-copy"><strong>{selected.strength === 'Fort' ? t('strongPassword') : t('mediumPassword')}</strong><span>{formatLastModified(selected.updatedAt, language)}</span></div><div className="strength-meter"><span className="meter-fill" /><span className="meter-fill" /><span className="meter-fill" /><span className="meter-empty" /></div><span className="strength-label">{selected.strength === 'Fort' ? t('strongShort') : t('mediumShort')}</span></div>
            <div className="details-section"><p className="section-label">{t('connectionInfo')}</p><Field icon={<Globe2 size={17} />} label={t('appServiceLabel')} value={selected.provider} /><Field icon={<ExternalLink size={17} />} label={t('loginLinkLabel')} value={selected.url} link /><Field icon={<UserRound size={17} />} label={t('identifierLabel')} value={selected.username} copyable /><div className="password-field"><div className="field-icon"><KeyRound size={17} /></div><div className="field-content"><span>{t('password')}</span><strong>{showPassword ? selected.password : '••••••••••••••••••••'}</strong></div><button className="field-action" aria-label={showPassword ? t('hidePassword') : t('showPassword')} data-tooltip={showPassword ? t('hidePassword') : t('showPassword')} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="field-action" aria-label={t('copyPassword')} data-tooltip={t('copyPassword')} onClick={copyPassword}><Copy size={16} /></button></div>{selected.totpSecret && <TotpField secret={selected.totpSecret} digits={selected.totpDigits} period={selected.totpPeriod} algorithm={selected.totpAlgorithm} />}</div>
            <div className="quick-actions"><button data-tooltip={t('copyPassword')} onClick={copyPassword}><Copy size={16} /> {t('copyPassword')}</button>{selected.applicationPath && <><button data-tooltip={`${t('openApplication')} ${selected.provider}`} onClick={() => void openAssociatedApplication(selected.applicationPath!)}><Play size={16} /> {t('openApplication')} {selected.provider}</button><button data-tooltip={t('openFill')} onClick={() => void autofillAssociatedApplication(selected)}><WandSparkles size={16} /> {t('openFill')}</button></>}<button data-tooltip={t('modify')} onClick={editSelected}><WandSparkles size={16} /> {t('modify')}</button>{(selected.history?.length ?? 0) > 0 && <button data-tooltip={t('history')} onClick={() => setShowHistory(true)}><HistoryIcon size={16} /> {t('history')}</button>}<button data-tooltip={t('secureFile')} onClick={() => void addSecureAttachment(selected)}><Paperclip size={16} /> {t('secureFile')}</button></div>
            {copied && <div className="copied-toast">{t('copiedPassword')}</div>}
            <div className="notes-section"><p className="section-label">{t('notes')}</p><div className="notes-box">{selected.notes || t('noNotes')}</div></div>
            {(selected.attachments?.length ?? 0) > 0 && <div className="attachments-section"><p className="section-label">{t('secureFiles')}</p><div className="attachment-list">{selected.attachments?.map((attachment) => <div className="attachment-row" key={`${attachment.name}-${attachment.size}`}><Paperclip size={15} /><span>{attachment.name}<small>{formatBytes(attachment.size, language)}</small></span><button data-tooltip={t('restoreFile')} aria-label={t('restoreFile')} onClick={() => void downloadSecureAttachment(attachment)}><Download size={15} /></button><button data-tooltip={t('removeFile')} aria-label={t('removeFile')} onClick={() => removeSecureAttachment(selected, attachment)}><Trash2 size={15} /></button></div>)}</div></div>}
            <div className="detail-meta"><span><Monitor size={15} /> {selected.updatedAt ? `${t('modifiedOn')} ${formatVaultDate(selected.updatedAt, language)}` : t('createdOn')}</span><span><LockKeyhole size={15} /> {t('encryptedLocally')}</span></div>
          </section>}
          {!selected && <section className="detail-panel empty-detail"><div className="empty-detail-content"><div className="detail-app-icon" style={{ background: '#29234d' }}><Plus size={25} /></div><h2>{t('emptyVaultTitle')}</h2><p>{t('emptyVaultDescription')}</p><button className="new-button" data-tooltip={t('newEntry')} onClick={() => setShowModal(true)}><Plus size={17} /> {t('newEntry')}</button></div></section>}
        </section>
      </main>
      {showModal && <NewEntryModal initialEntry={editingEntry} categories={categories} onClose={() => { setShowModal(false); setEditingEntry(null) }} onSave={saveEntry} />}
      {showSecurityPanel && <SecurityPanel entries={entries} onClose={() => setShowSecurityPanel(false)} />}
      {showHistory && selected && <HistoryPanel entry={selected} onClose={() => setShowHistory(false)} onRestore={restoreHistoryVersion} />}
      {showSettings && <SettingsModal autoLockMinutes={autoLockMinutes} onAutoLockChange={setAutoLockMinutes} currentPassword={masterPassword} vaultPath={vaultPath} bridgeInfo={bridgeInfo} onCopyBridge={copyBridgeConfig} onSyncVault={syncVault} onRestoreSync={restoreSyncedVault} onRestoreRecovery={restoreRecoveryBackup} onExportRecovery={exportRecoveryBackup} onExport={exportVault} onExportKeePass={exportKeePass} onImport={importVault} onSwitchVault={switchVault} onCreateVault={createNewVault} recentVaults={recentVaults} onOpenRecentVault={openRecentVault} onClose={() => setShowSettings(false)} onPasswordChanged={(password) => setMasterPassword(password)} />}
      {secretPrompt && <SecretPromptModal title={secretPrompt.title} onResolve={resolveSecretPrompt} />}
      {toast && <div className="app-toast" role="status" aria-live="polite">{toast}</div>}
    </div>
  )
}

function MasterPasswordGate({ status, error, onCreate, onUnlock }: { status: VaultStatus; error: string; onCreate: (password: string) => Promise<void>; onUnlock: (password: string) => Promise<void> }) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const isCreating = status === 'create'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setFormError('')
    if (password.length < 8) {
      setFormError(t('masterMinError'))
      return
    }
    if (isCreating && password !== confirmation) {
      setFormError(t('masterConfirmError'))
      return
    }
    setBusy(true)
    if (isCreating) await onCreate(password)
    else await onUnlock(password)
    setBusy(false)
  }

  if (status === 'loading') {
    return <div className="gate-shell"><div className="gate-card loading-card"><div className="gate-mark"><LockKeyhole size={28} /></div><h1>{t('openVault')}</h1><p>{t('checkingStorage')}</p></div></div>
  }

  return <div className="gate-shell"><div className="gate-card"><div className="gate-mark"><LockKeyhole size={28} /></div><p className="gate-brand">vaultly</p><h1>{isCreating ? t('createVault') : t('unlockVault')}</h1><p className="gate-description">{isCreating ? t('createVaultDescription') : t('unlockVaultDescription')}</p><form onSubmit={submit}><label>{t('masterPassword')}<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t('minimum8')} /></label>{isCreating && <label>{t('confirmPassword')}<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={t('repeatMasterPassword')} /></label>}{(formError || error) && <div className="gate-error">{formError || error}</div>}<button className="gate-submit" data-tooltip={isCreating ? t('createVaultTooltip') : t('unlockTooltip')} type="submit" disabled={busy}>{busy ? t('processing') : isCreating ? t('createLocalVault') : t('unlock')}</button></form><div className="gate-footnote"><ShieldCheck size={15} /> {t('offlineOnly')}</div></div></div>
}

function NavItem({ icon, label, active, onClick, count, badge }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void; count?: number; badge?: string }) {
  const { t } = useI18n()
  return <button className={`nav-item ${active ? 'active' : ''}`} data-tooltip={`${t('showFilter')} ${label.toLowerCase()}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{count !== undefined && <em>{count}</em>}{badge && <b>{badge}</b>}</button>
}

function EntryRow({ entry, selected, onClick }: { entry: Entry; selected: boolean; onClick: () => void }) {
  const { t } = useI18n()
  return <button className={`entry-row ${selected ? 'selected' : ''}`} data-tooltip={`${t('selectCredential')} ${entry.title}`} onClick={onClick}><div className="entry-icon" style={{ background: entry.color }}>{entry.icon}</div><div className="entry-copy"><strong>{entry.title}</strong><span>{entry.provider}</span><small>{entry.username}</small></div>{entry.favorite && <Star className="entry-star" size={15} fill="currentColor" />}<span className={`entry-status ${entry.strength === 'Fort' ? 'strong' : 'medium'}`} /></button>
}

function Field({ icon, label, value, link, copyable }: { icon: React.ReactNode; label: string; value: string; link?: boolean; copyable?: boolean }) {
  const { t } = useI18n()
  const actionLabel = link ? t('openLoginLink') : t('copyIdentifier')

  async function handleClick() {
    if (copyable) {
      navigator.clipboard?.writeText(value)
      window.setTimeout(() => navigator.clipboard?.writeText(''), 20_000)
      return
    }
    if (link && /^https?:\/\//i.test(value)) {
      try { await openUrl(value) } catch { window.open(value, '_blank', 'noopener,noreferrer') }
    }
  }

  return <div className="info-field"><div className="field-icon">{icon}</div><div className="field-content"><span>{label}</span><strong className={link ? 'link-value' : ''}>{value}</strong></div>{(link || copyable) && <button className="field-end-button" aria-label={actionLabel} data-tooltip={actionLabel} onClick={() => void handleClick()}>{link ? <ExternalLink size={16} /> : <Copy size={16} />}</button>}</div>
}

type InstalledApp = { name: string; path: string }

function NewEntryModal({ initialEntry, categories, onClose, onSave }: { initialEntry: Entry | null; categories: string[]; onClose: () => void; onSave: (entry: Entry) => void }) {
  const { t } = useI18n()
  const [title, setTitle] = useState(initialEntry?.title ?? '')
  const [provider, setProvider] = useState(initialEntry?.provider ?? '')
  const [url, setUrl] = useState(initialEntry?.url ?? '')
  const [username, setUsername] = useState(initialEntry?.username ?? '')
  const [password, setPassword] = useState(initialEntry?.password ?? '')
  const [totpSecret, setTotpSecret] = useState(initialEntry?.totpSecret ?? '')
  const [totpDigits, setTotpDigits] = useState(initialEntry?.totpDigits ?? 6)
  const [totpPeriod, setTotpPeriod] = useState(initialEntry?.totpPeriod ?? 30)
  const [totpAlgorithm, setTotpAlgorithm] = useState<'SHA1' | 'SHA256' | 'SHA512'>(initialEntry?.totpAlgorithm ?? 'SHA1')
  const [category, setCategory] = useState(initialEntry?.category ?? categories[0] ?? 'Personnel')
  const [notes, setNotes] = useState(initialEntry?.notes ?? '')
  const [custom, setCustom] = useState(false)
  const [targetType, setTargetType] = useState<'web' | 'desktop'>(initialEntry?.applicationPath ? 'desktop' : 'web')
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [applicationPath, setApplicationPath] = useState(initialEntry?.applicationPath ?? '')
  const [autofillAdapter, setAutofillAdapter] = useState(initialEntry?.autofillAdapter ?? getAutofillAdapter(initialEntry?.provider ?? '') ?? 'generic')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const [generatorLength, setGeneratorLength] = useState(20)
  const [showGenerator, setShowGenerator] = useState(false)

  useEffect(() => {
    if (targetType === 'desktop' && installedApps.length === 0) void scanApps()
  }, [targetType])

  async function scanApps() {
    setScanning(true)
    setScanError('')
    try {
      const apps = await invoke<InstalledApp[]>('scan_installed_apps')
      setInstalledApps(apps)
    } catch (error) {
      setScanError(interpolate(t('scanUnavailable'), { error: String(error) }))
    } finally {
      setScanning(false)
    }
  }

  function selectApplication(name: string) {
    const app = applications.find((item) => item.name === name)
    setProvider(name)
    setApplicationPath('')
    if (app) setUrl(app.url)
  }

  function selectInstalledApp(path: string) {
    const app = installedApps.find((item) => item.path === path)
    if (!app) return
    setProvider(app.name)
    setApplicationPath(app.path)
    setAutofillAdapter(getAutofillAdapter(app.name) ?? 'generic')
    if (!title) setTitle(`Compte ${app.name}`)
  }

  function generatePassword() {
    const characters = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*+-_='
    const values = new Uint32Array(generatorLength)
    crypto.getRandomValues(values)
    const generated = Array.from(values, (value) => characters[value % characters.length]).join('')
    setPassword(generated)
    setShowGenerator(false)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const app = applications.find((item) => item.name === provider)
    const totp = parseTotpSettings(totpSecret)
    if (totpSecret.trim() && !totp) {
      window.alert(t('invalidTotp'))
      return
    }
    onSave({ ...initialEntry, id: initialEntry?.id ?? Date.now(), title: title || provider || 'Nouvel identifiant', provider: provider || 'Service personnalisé', username: username || 'Non renseigné', password: password || 'Mot-de-passe-à-définir', url: url || 'https://', category, notes, totpSecret: totp?.secret, totpDigits: totp?.digits ?? totpDigits, totpPeriod: totp?.period ?? totpPeriod, totpAlgorithm: totp?.algorithm ?? totpAlgorithm, icon: initialEntry?.icon ?? app?.icon ?? '✦', color: initialEntry?.color ?? app?.color ?? '#7c5cff', applicationPath: targetType === 'desktop' ? applicationPath : undefined, autofillAdapter: targetType === 'desktop' ? (autofillAdapter === 'generic' ? undefined : autofillAdapter) : undefined, strength: password.length >= 12 ? 'Fort' : 'Moyen' })
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="modal" role="dialog" aria-modal="true" onSubmit={submit}><div className="modal-header"><div><p className="eyebrow">{initialEntry ? t('editCredential').toUpperCase() : t('newCredential').toUpperCase()}</p><h2>{initialEntry ? t('editCredential') : t('addCredential')}</h2><p>{t('associateDescription')}</p></div><button type="button" className="close-button" data-tooltip={t('close')} onClick={onClose}><X size={19} /></button></div><label>{t('credentialName')}<input autoFocus placeholder={t('exampleCredential')} value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="target-tabs"><button type="button" data-tooltip={t('associateWeb')} aria-label={t('associateWeb')} className={targetType === 'web' ? 'active' : ''} onClick={() => setTargetType('web')}>{t('webLink')}</button><button type="button" data-tooltip={t('associateDesktop')} aria-label={t('associateDesktop')} className={targetType === 'desktop' ? 'active' : ''} onClick={() => setTargetType('desktop')}>{t('windowsApp')}</button></div>{targetType === 'web' ? <><div className="field-label">{t('appOrService')}</div><div className="app-picker">{applications.slice(0, 5).map((app) => <button type="button" key={app.name} data-tooltip={`${t('prefill')} ${app.name}`} aria-label={`${t('prefill')} ${app.name}`} className={`app-option ${provider === app.name ? 'picked' : ''}`} onClick={() => selectApplication(app.name)}><span style={{ background: app.color }}>{app.icon}</span>{app.name}</button>)}<button type="button" data-tooltip={t('customService')} aria-label={t('customService')} className={`app-option custom-option ${custom ? 'picked' : ''}`} onClick={() => { setCustom(true); setProvider('') }}><span><Plus size={15} /></span>{t('custom')}</button></div><label>{t('serviceName')}<input placeholder={t('exampleService')} value={provider} onChange={(event) => setProvider(event.target.value)} /></label><label>{t('loginLink')}<input type="url" placeholder="https://..." value={url} onChange={(event) => setUrl(event.target.value)} /></label></> : <div className="desktop-picker"><div className="scan-header"><span>{t('detectedApps')}</span><button type="button" className="scan-button" data-tooltip={t('refresh')} aria-label={t('refresh')} onClick={() => void scanApps()}><RefreshCw size={14} className={scanning ? 'spin' : ''} /> {scanning ? t('scanning') : t('refresh')}</button></div>{scanError && <p className="scan-error">{scanError}</p>}<select value={applicationPath} onChange={(event) => selectInstalledApp(event.target.value)} required><option value="">{t('selectApp')}</option>{installedApps.map((app) => <option key={app.path} value={app.path}>{app.name}</option>)}</select>{applicationPath && <p className="selected-path">{applicationPath}</p>}<label>{t('appName')}<input placeholder={t('exampleService')} value={provider} onChange={(event) => setProvider(event.target.value)} /></label><label>{t('connectorLabel')}<select value={autofillAdapter} onChange={(event) => setAutofillAdapter(event.target.value)}><option value="generic">{t('genericConnector')}</option><option value="battle_net">{t('battleNetConnector')}</option><option value="steam">{t('steamConnector')}</option><option value="epic_games">{t('epicConnector')}</option><option value="discord">{t('discordConnector')}</option><option value="microsoft">{t('microsoftConnector')}</option><option value="google">{t('googleConnector')}</option></select></label></div>}<label>{t('category')}<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><div className="two-fields"><label>{t('username')}<input placeholder={t('exampleEmail')} value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>{t('password')}<div className="password-input-row"><input type="password" placeholder={t('generateLater')} value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" className="generate-button" aria-label={t('generateSecure')} data-tooltip={t('generateSecure')} onClick={() => setShowGenerator((value) => !value)}><SlidersHorizontal size={15} /></button></div>{showGenerator && <div className="generator-panel"><div className="generator-row"><span>{t('length')}: {generatorLength}</span><input type="range" min="12" max="40" value={generatorLength} onChange={(event) => setGeneratorLength(Number(event.target.value))} /></div><button type="button" className="generate-cta" data-tooltip={t('generateRandom')} onClick={generatePassword}>{t('generate')}</button></div>}</label></div><label>{t('totp')}<input placeholder="JBSWY3DPEHPK3PXP" value={totpSecret} onChange={(event) => setTotpSecret(event.target.value)} /></label>{totpSecret.trim() && <div className="totp-settings"><label>{t('totpDigits')}<select value={totpDigits} onChange={(event) => setTotpDigits(Number(event.target.value))}><option value={6}>6</option><option value={7}>7</option><option value={8}>8</option></select></label><label>{t('totpPeriod')}<input type="number" min={1} max={300} value={totpPeriod} onChange={(event) => setTotpPeriod(Math.min(300, Math.max(1, Number(event.target.value) || 30)))} /></label><label>{t('totpAlgorithm')}<select value={totpAlgorithm} onChange={(event) => setTotpAlgorithm(event.target.value as 'SHA1' | 'SHA256' | 'SHA512')}><option value="SHA1">SHA-1</option><option value="SHA256">SHA-256</option><option value="SHA512">SHA-512</option></select></label></div>}<label>{t('notes')}<textarea rows={3} placeholder={t('usefulNotes')} value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="modal-footer"><button type="button" className="cancel-button" data-tooltip={t('cancel')} onClick={onClose}>{t('cancel')}</button><button className="new-button" data-tooltip={initialEntry ? t('saveChanges') : t('addToVault')} type="submit"><Plus size={17} /> {initialEntry ? t('saveChanges') : t('addToVault')}</button></div></form></div>
}

function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const normalized = value.replace(/[=\s-]/g, '').toUpperCase()
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of normalized) {
    const index = alphabet.indexOf(character)
    if (index < 0) return new Uint8Array()
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

async function calculateTotp(secret: string, digits = 6, period = 30, algorithm: 'SHA1' | 'SHA256' | 'SHA512' = 'SHA1') {
  const keyData = decodeBase32(secret)
  if (keyData.length === 0) throw new Error('Secret TOTP invalide')
  const hash = algorithm === 'SHA256' ? 'SHA-256' : algorithm === 'SHA512' ? 'SHA-512' : 'SHA-1'
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash }, false, ['sign'])
  const counter = Math.floor(Date.now() / (period * 1000))
  const counterBytes = new ArrayBuffer(8)
  new DataView(counterBytes).setUint32(4, counter)
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes))
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

function TotpField({ secret, digits = 6, period = 30, algorithm = 'SHA1' }: { secret: string; digits?: number; period?: number; algorithm?: 'SHA1' | 'SHA256' | 'SHA512' }) {
  const { t } = useI18n()
  const [code, setCode] = useState('------')
  const [remaining, setRemaining] = useState(period - (Math.floor(Date.now() / 1000) % period))
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const nextCode = await calculateTotp(secret, digits, period, algorithm)
        if (active) setCode(nextCode)
      } catch {
        if (active) setCode('INVALIDE')
      }
      if (active) setRemaining(period - (Math.floor(Date.now() / 1000) % period))
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [secret, digits, period, algorithm])

  function copyCode() {
    navigator.clipboard?.writeText(code)
    window.setTimeout(() => navigator.clipboard?.writeText(''), 20_000)
  }

  return <div className="totp-field"><div className="field-icon"><ShieldCheck size={17} /></div><div className="field-content"><span>{t('totp').replace(' (optionnel)', '')}</span><strong className="totp-code">{code}</strong></div><div className="totp-countdown">{remaining}s</div><button className="field-action" aria-label={t('copyTotp')} data-tooltip={t('copyTotp')} onClick={copyCode}><Copy size={16} /></button></div>
}

function HistoryPanel({ entry, onClose, onRestore }: { entry: Entry; onClose: () => void; onRestore: (password: string) => void }) {
  const { language, t } = useI18n()
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal history-modal" role="dialog" aria-modal="true"><div className="modal-header"><div><p className="eyebrow">{t('historyTitle').toUpperCase()}</p><h2>{entry.title}</h2><p>{t('historyDescription')}</p></div><button type="button" className="close-button" data-tooltip={t('close')} onClick={onClose}><X size={19} /></button></div><div className="history-list">{(entry.history ?? []).slice().reverse().map((item, index) => <div className="history-row" key={`${item.changedAt}-${index}`}><div><strong>{t('previousVersion')}</strong><span>{t('modifiedOn')} {formatVaultDate(item.changedAt, language)}</span></div><code>{'•'.repeat(Math.min(18, item.password.length))}</code><button type="button" data-tooltip={t('restoreVersion')} aria-label={t('restoreVersion')} onClick={() => onRestore(item.password)}><RotateCcw size={15} /></button></div>)}</div><p className="settings-note"><ShieldCheck size={15} /> {t('historyPrivacy')}</p></section></div>
}

async function sha1Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function SecurityPanel({ entries, onClose }: { entries: Entry[]; onClose: () => void }) {
  const { t } = useI18n()
  const weak = entries.filter((entry) => entry.strength !== 'Fort')
  const passwords = new Map<string, number>()
  entries.forEach((entry) => passwords.set(entry.password, (passwords.get(entry.password) ?? 0) + 1))
  const reused = entries.filter((entry) => (passwords.get(entry.password) ?? 0) > 1)
  const score = Math.max(0, 100 - weak.length * 12 - reused.length * 10)
  const [breachStatus, setBreachStatus] = useState<'idle' | 'checking' | 'done' | 'error'>('idle')
  const [compromised, setCompromised] = useState<string[]>([])

  async function checkBreaches() {
    if (!window.confirm(t('breachPrivacyConfirm'))) return
    setBreachStatus('checking')
    setCompromised([])
    try {
      const unique = Array.from(new Set(entries.map((entry) => entry.password).filter(Boolean)))
      const found: string[] = []
      for (const password of unique) {
        const hash = await sha1Hex(password)
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 8_000)
        let response: Response
        try {
          response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, signal: controller.signal })
        } finally {
          window.clearTimeout(timeout)
        }
        if (!response.ok) throw new Error(`Service indisponible (${response.status})`)
        const suffix = hash.slice(5)
        const lines = (await response.text()).split(/\r?\n/)
        if (lines.some((line) => line.toUpperCase().startsWith(`${suffix}:`))) {
          entries.filter((entry) => entry.password === password).forEach((entry) => found.push(entry.title))
        }
      }
      setCompromised(found)
      setBreachStatus('done')
    } catch {
      setBreachStatus('error')
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal security-modal" role="dialog" aria-modal="true"><div className="modal-header"><div><p className="eyebrow">{t('security').toUpperCase()}</p><h2>{t('securityTitle')}</h2><p>{t('securityDescription')}</p></div><button type="button" className="close-button" data-tooltip={t('close')} onClick={onClose}><X size={19} /></button></div><div className="security-score"><div className="score-ring"><strong>{score}</strong><span>/ 100</span></div><div><strong>{score >= 80 ? t('securityGood') : t('securityNeedsWork')}</strong><p>{t('securityScoreDescription')}</p></div></div><div className="security-stats"><div><strong>{weak.length}</strong><span>{t('weakPasswords')}</span></div><div><strong>{reused.length}</strong><span>{t('reusedPasswords')}</span></div><div><strong>{entries.length}</strong><span>{t('analyzedEntries')}</span></div></div><div className="security-actions"><button type="button" data-tooltip={t('checkTooltip')} onClick={() => void checkBreaches()} disabled={breachStatus === 'checking'}><ShieldCheck size={15} /> {breachStatus === 'checking' ? t('checking') : t('verifyBreaches')}</button></div>{breachStatus === 'done' && <div className="security-list">{compromised.length > 0 ? <p className="security-danger">{t('compromisedNow')} : {compromised.join(', ')}</p> : <p className="security-ok"><ShieldCheck size={16} /> {t('noCompromise')}</p>}</div>}{breachStatus === 'error' && <div className="security-list"><p>{t('checkUnavailable')}</p></div>}<div className="security-list">{weak.length > 0 && <p>{t('strengthen')} : {weak.map((entry) => entry.title).join(', ')}</p>}{reused.length > 0 && <p>{t('reuseDetected')} : {reused.map((entry) => entry.title).join(', ')}</p>}{weak.length === 0 && reused.length === 0 && <p className="security-ok"><ShieldCheck size={16} /> {t('noObviousIssue')}</p>}</div></section></div>
}

function SecretPromptModal({ title, onResolve }: { title: string; onResolve: (value: string | null) => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!value) return
    onResolve(value)
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onResolve(null) }}><form className="modal secret-prompt-modal" role="dialog" aria-modal="true" onSubmit={submit}><div className="modal-header"><div><p className="eyebrow">{t('masterPassword').toUpperCase()}</p><h2>{title}</h2><p>{t('secretPromptDescription')}</p></div><button type="button" className="close-button" data-tooltip={t('cancel')} aria-label={t('cancel')} onClick={() => onResolve(null)}><X size={19} /></button></div><label>{t('masterPassword')}<input autoFocus type="password" value={value} onChange={(event) => setValue(event.target.value)} /></label><div className="modal-footer"><button type="button" className="cancel-button" data-tooltip={t('cancel')} onClick={() => onResolve(null)}>{t('cancel')}</button><button type="submit" className="new-button" data-tooltip={t('continueAction')} disabled={!value}><KeyRound size={17} /> {t('continueAction')}</button></div></form></div>
}

function SettingsModal({ autoLockMinutes, onAutoLockChange, currentPassword, vaultPath, bridgeInfo, onCopyBridge, onSyncVault, onRestoreSync, onRestoreRecovery, onExportRecovery, onExport, onExportKeePass, onImport, onSwitchVault, onCreateVault, recentVaults, onOpenRecentVault, onClose, onPasswordChanged }: { autoLockMinutes: number; onAutoLockChange: (value: number) => void; currentPassword: string; vaultPath: string; bridgeInfo: BridgeInfo | null; onCopyBridge: () => void; onSyncVault: () => Promise<void>; onRestoreSync: () => Promise<void>; onRestoreRecovery: () => Promise<void>; onExportRecovery: () => Promise<void>; onExport: () => Promise<void>; onExportKeePass: () => Promise<void>; onImport: () => Promise<void>; onSwitchVault: () => Promise<void>; onCreateVault: () => Promise<void>; recentVaults: string[]; onOpenRecentVault: (path: string) => Promise<void>; onClose: () => void; onPasswordChanged: (password: string) => void }) {
  const { language, setLanguage, t } = useI18n()
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    if (newPassword.length < 8 || newPassword !== confirmation) {
      setMessage(t('masterMismatch'))
      return
    }
    setBusy(true)
    try {
      await invoke('change_master_password', { path: vaultPath, currentPassword, newPassword })
      onPasswordChanged(newPassword)
      setNewPassword('')
      setConfirmation('')
      setMessage(t('masterChanged'))
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal settings-modal" role="dialog" aria-modal="true"><div className="modal-header"><div><p className="eyebrow">{t('settings').toUpperCase()}</p><h2>{t('preferencesTitle')}</h2><p>{t('localPreferences')}</p></div><button type="button" className="close-button" data-tooltip={t('settingsClose')} onClick={onClose}><X size={19} /></button></div><div className="settings-section"><p className="section-label">{t('autoLockSection')}</p><div className="setting-row"><div><strong>{t('autoLockLabel')}</strong><span>{t('autoLockDescription')}</span></div><select value={autoLockMinutes} onChange={(event) => onAutoLockChange(Number(event.target.value))}><option value={1}>1 {language === 'fr' ? 'minute' : 'minute'}</option><option value={5}>5 {language === 'fr' ? 'minutes' : 'minutes'}</option><option value={15}>15 {language === 'fr' ? 'minutes' : 'minutes'}</option><option value={30}>30 {language === 'fr' ? 'minutes' : 'minutes'}</option></select></div></div><div className="settings-section"><p className="section-label">{t('masterSection')}</p><form onSubmit={changePassword}><label>{t('newPassword')}<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t('minimum8')} /></label><label>{t('confirmation')}<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={t('repeatMasterPassword')} /></label><button type="submit" className="new-button" data-tooltip={t('changeMaster')} disabled={busy}>{busy ? t('changing') : t('changeMaster')}</button></form>{message && <p className="settings-message">{message}</p>}</div><div className="settings-section"><p className="section-label">{t('language').toUpperCase()}</p><div className="setting-row"><div><strong>{t('language')}</strong><span>{t('interfaceLocal')}</span></div><select aria-label={t('language')} value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="fr">{t('french')}</option><option value="en">{t('english')}</option></select></div></div><div className="settings-section"><p className="section-label">{t('localVaults')}</p><p className="vault-path">{t('localVault')} : <code>{vaultPath || t('previewMode')}</code></p><div className="settings-actions"><button type="button" data-tooltip={t('changeVault')} onClick={() => void onSwitchVault()}><Folder size={15} /> {t('changeVault')}</button><button type="button" data-tooltip={t('newVault')} onClick={() => void onCreateVault()}><Plus size={15} /> {t('newVault')}</button></div>{recentVaults.length > 0 && <div className="recent-vaults"><p className="settings-note">{t('recentVaults')}</p>{recentVaults.map((path) => <button type="button" key={path} data-tooltip={t('openRecentVault')} onClick={() => void onOpenRecentVault(path)}><Folder size={15} /> {vaultDisplayName(path)}</button>)}</div>}</div><div className="settings-section"><p className="section-label">{t('sync').toUpperCase()}</p><p>{t('encryptedSyncDescription')}</p><div className="settings-actions"><button type="button" data-tooltip={t('sync')} onClick={() => void onSyncVault()}><Copy size={15} /> {t('sync')}</button><button type="button" data-tooltip={t('restoreSyncTooltip')} onClick={() => void onRestoreSync()}><Folder size={15} /> {t('restoreSync')}</button></div></div><div className="settings-section"><p className="section-label">{t('recovery').toUpperCase()}</p><p>{t('recoveryDescription')}</p><div className="settings-actions"><button type="button" data-tooltip={t('recovery')} onClick={() => void onExportRecovery()}><ShieldCheck size={15} /> {t('recovery')}</button><button type="button" data-tooltip={t('recoveryRestore')} onClick={() => void onRestoreRecovery()}><RotateCcw size={15} /> {t('recoveryRestore')}</button></div></div><div className="settings-section"><p className="section-label">{t('autofill').toUpperCase()}</p><p>{t('webAutofillDescription')}</p><div className="settings-actions"><button type="button" data-tooltip={t('save')} onClick={onCopyBridge}><Copy size={15} /> {t('save')}</button></div>{bridgeInfo && <p className="settings-note">{t('localBridge')} : <code>127.0.0.1:{bridgeInfo.port}</code> · {t('temporaryToken')}</p>}</div><div className="settings-section"><p className="section-label">{t('importsExports')}</p><div className="settings-actions"><button type="button" data-tooltip={t('importVaultKeePass')} onClick={() => void onImport()}><Folder size={15} /> {t('importVaultKeePass')}</button><button type="button" data-tooltip={t('exportVaultBackup')} onClick={() => void onExport()}><Copy size={15} /> {t('exportVaultBackup')}</button><button type="button" data-tooltip={t('exportKeePass')} onClick={() => void onExportKeePass()}><KeyRound size={15} /> {t('exportKeePass')}</button></div><p className="settings-note"><ShieldCheck size={15} /> {t('automaticBackup')}</p></div></section></div>
}

function BellIcon() { return <span className="bell-icon">●</span> }

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
