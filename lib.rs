use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{aead::{Aead, KeyInit}, Key, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, fs::OpenOptions, io::{Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, process::Command, sync::{Arc, Mutex, OnceLock}, thread, time::Duration};
use tauri::Manager;
use zeroize::Zeroize;
use keepass_ng::{DatabaseConfig, db::{group_add_child, rc_refcell_node, with_node, Database, DatabaseKey, Entry, Group, Node, NodeIterator}};

#[cfg(windows)]
use winreg::{enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}, RegKey};

#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
};

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE};

#[derive(Debug, Serialize, Deserialize)]
struct VaultEnvelope {
    format_version: u8,
    kdf: String,
    cipher: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize)]
struct InstalledApp {
    name: String,
    path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct KdbxEntry {
    title: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    #[serde(rename = "totpSecret")]
    totp_secret: Option<String>,
    group: String,
}

#[derive(Debug, Deserialize)]
struct ExportEntry {
    title: String,
    username: String,
    password: String,
    url: String,
    notes: Option<String>,
    #[serde(rename = "totpSecret")]
    totp_secret: Option<String>,
    #[serde(rename = "totpDigits")]
    totp_digits: Option<u8>,
    #[serde(rename = "totpPeriod")]
    totp_period: Option<u32>,
    #[serde(rename = "totpAlgorithm")]
    totp_algorithm: Option<String>,
    category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct BridgeInfo {
    port: u16,
    token: String,
}

struct BridgeState {
    info: BridgeInfo,
    data: String,
    active: bool,
}

static BRIDGE_STATE: OnceLock<Arc<Mutex<BridgeState>>> = OnceLock::new();

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("Impossible de dériver la clé : {error}"))?;
    Ok(key)
}

fn encrypt_vault(password: &str, plaintext: &[u8]) -> Result<VaultEnvelope, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let mut raw_key = derive_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&raw_key));
    let encrypted = cipher.encrypt(XNonce::from_slice(&nonce), plaintext);
    raw_key.zeroize();
    let ciphertext = encrypted.map_err(|_| "Le chiffrement du coffre a échoué".to_string())?;

    Ok(VaultEnvelope {
        format_version: 1,
        kdf: "Argon2id".into(),
        cipher: "XChaCha20-Poly1305".into(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

fn decrypt_vault(password: &str, envelope: &VaultEnvelope) -> Result<String, String> {
    if envelope.format_version != 1 {
        return Err("Version de coffre non prise en charge".into());
    }
    if envelope.kdf != "Argon2id" || envelope.cipher != "XChaCha20-Poly1305" {
        return Err("Paramètres cryptographiques du coffre non pris en charge".into());
    }
    let salt = B64.decode(&envelope.salt).map_err(|_| "Le sel du coffre est invalide")?;
    let nonce = B64.decode(&envelope.nonce).map_err(|_| "Le nonce du coffre est invalide")?;
    let ciphertext = B64.decode(&envelope.ciphertext).map_err(|_| "Le contenu du coffre est invalide")?;
    if salt.len() != 16 {
        return Err("La taille du sel est invalide".into());
    }
    if nonce.len() != 24 {
        return Err("La taille du nonce est invalide".into());
    }

    let mut raw_key = derive_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&raw_key));
    let decrypted = cipher.decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref());
    raw_key.zeroize();
    let plaintext = decrypted.map_err(|_| "Mot de passe maître incorrect ou coffre corrompu".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Le contenu déchiffré est invalide".into())
}

fn write_vault_atomically(path: &Path, serialized: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let filename = path.file_name().and_then(|value| value.to_str()).ok_or("Le chemin du coffre est invalide")?;
    let temporary = parent.join(format!(".{filename}.tmp-{}", OsRng.next_u64()));
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Impossible de préparer la sauvegarde : {error}"))?;
        file.write_all(serialized).map_err(|error| format!("Impossible d’écrire le coffre temporaire : {error}"))?;
        file.sync_all().map_err(|error| format!("Impossible de finaliser l’écriture du coffre : {error}"))?;
        drop(file);
        if path.is_file() {
            fs::remove_file(path).map_err(|error| format!("Impossible de remplacer l’ancien coffre : {error}"))?;
        }
        fs::rename(&temporary, path).map_err(|error| format!("Impossible de finaliser la sauvegarde : {error}"))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[tauri::command]
fn save_vault(path: String, password: String, data: String) -> Result<(), String> {
    if password.trim().len() < 8 {
        return Err("Le mot de passe maître doit contenir au moins 8 caractères".into());
    }
    let envelope = encrypt_vault(&password, data.as_bytes())?;
    let serialized = serde_json::to_vec_pretty(&envelope).map_err(|error| error.to_string())?;
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if path.is_file() {
        let backup = path.with_extension("vault.bak");
        fs::copy(&path, backup).map_err(|error| format!("Impossible de créer la sauvegarde : {error}"))?;
    }
    write_vault_atomically(&path, &serialized)
}

#[tauri::command]
fn open_vault(path: String, password: String) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("Impossible de lire le coffre : {error}"))?;
    let envelope: VaultEnvelope = serde_json::from_slice(&bytes).map_err(|error| format!("Format de coffre invalide : {error}"))?;
    decrypt_vault(&password, &envelope)
}

#[tauri::command]
fn change_master_password(path: String, current_password: String, new_password: String) -> Result<(), String> {
    if new_password.trim().len() < 8 {
        return Err("Le nouveau mot de passe maître doit contenir au moins 8 caractères".into());
    }
    let data = open_vault(path.clone(), current_password)?;
    save_vault(path, new_password, data)
}

#[tauri::command]
fn create_recovery_backup(source: String, current_password: String, destination: String, recovery_password: String) -> Result<(), String> {
    if recovery_password.trim().len() < 16 {
        return Err("Le code de récupération doit contenir au moins 16 caractères".into());
    }
    let data = open_vault(source, current_password)?;
    save_vault(destination, recovery_password, data)
}

#[tauri::command]
fn default_vault_path(app: tauri::AppHandle) -> Result<String, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de déterminer le dossier local : {error}"))?;
    Ok(directory.join("vaultly.vault").to_string_lossy().into_owned())
}

#[tauri::command]
fn vault_exists(path: String) -> bool {
    PathBuf::from(path).is_file()
}

#[tauri::command]
fn copy_vault(source: String, destination: String) -> Result<(), String> {
    let source_path = PathBuf::from(source);
    let destination_path = PathBuf::from(destination);
    if !source_path.is_file() {
        return Err("Le coffre source est introuvable".into());
    }
    let contents = fs::read(&source_path).map_err(|error| format!("Impossible de lire le coffre source : {error}"))?;
    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_vault_atomically(&destination_path, &contents)
}

#[tauri::command]
fn sync_vault_to_folder(source: String, folder: String) -> Result<String, String> {
    let destination = PathBuf::from(folder).join("vaultly-sync.vault");
    copy_vault(source, destination.to_string_lossy().into_owned())?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn restore_vault_from_folder(folder: String, destination: String, password: String) -> Result<String, String> {
    let source = PathBuf::from(folder).join("vaultly-sync.vault");
    if !source.is_file() {
        return Err("Aucune copie Vaultly synchronisée n’a été trouvée dans ce dossier".into());
    }
    let data = open_vault(source.to_string_lossy().into_owned(), password.clone())?;
    save_vault(destination, password, data.clone())?;
    Ok(data)
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
    let metadata = fs::metadata(&path).map_err(|error| format!("Impossible d’inspecter la pièce jointe : {error}"))?;
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err("La pièce jointe dépasse la limite de 50 Mo".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("Impossible de lire la pièce jointe : {error}"))?;
    Ok(B64.encode(bytes))
}

#[tauri::command]
fn write_file_base64(path: String, data: String) -> Result<(), String> {
    const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;
    if data.len() > (MAX_ATTACHMENT_BYTES + 2) * 4 / 3 {
        return Err("La pièce jointe dépasse la limite de 50 Mo".into());
    }
    let bytes = B64.decode(data).map_err(|_| "Les données de la pièce jointe sont invalides".to_string())?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("La pièce jointe dépasse la limite de 50 Mo".into());
    }
    fs::write(&path, bytes).map_err(|error| format!("Impossible d’enregistrer la pièce jointe : {error}"))
}

fn bridge_response(stream: &mut TcpStream, status: &str, body: &str) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nPragma: no-cache\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: X-Vaultly-Token, Content-Type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body
    );
    stream.write_all(response.as_bytes()).map_err(|error| error.to_string())
}

fn handle_bridge_connection(mut stream: TcpStream, state: &Arc<Mutex<BridgeState>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = [0u8; 8192];
    let Ok(size) = stream.read(&mut buffer) else { return };
    if size == 0 { return; }
    let request = String::from_utf8_lossy(&buffer[..size]);
    let mut request_lines = request.lines();
    let Some(request_line) = request_lines.next() else { return };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method == "OPTIONS" {
        let _ = bridge_response(&mut stream, "204 No Content", "{}");
        return;
    }
    if method != "GET" {
        let _ = bridge_response(&mut stream, "405 Method Not Allowed", "{\"error\":\"Méthode non autorisée\"}");
        return;
    }
    let supplied_token = request_lines
        .find_map(|line| line.strip_prefix("X-Vaultly-Token:").or_else(|| line.strip_prefix("x-vaultly-token:")))
        .map(str::trim)
        .unwrap_or_default();
    let (expected_token, data, active) = match state.lock() {
        Ok(value) => (value.info.token.clone(), value.data.clone(), value.active),
        Err(_) => return,
    };
    if !active || supplied_token != expected_token {
        let _ = bridge_response(&mut stream, "401 Unauthorized", "{\"error\":\"Non autorisé\"}");
        return;
    }
    let parsed: serde_json::Value = serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!([]));
    if target == "/entries" {
        let metadata = parsed.as_array().map(|items| items.iter().map(|item| serde_json::json!({
            "id": item.get("id").and_then(serde_json::Value::as_i64),
            "title": item.get("title").and_then(serde_json::Value::as_str).unwrap_or(""),
            "provider": item.get("provider").and_then(serde_json::Value::as_str).unwrap_or(""),
            "url": item.get("url").and_then(serde_json::Value::as_str).unwrap_or(""),
        })).collect::<Vec<_>>()).unwrap_or_default();
        let body = serde_json::to_string(&metadata).unwrap_or_else(|_| "[]".into());
        let _ = bridge_response(&mut stream, "200 OK", &body);
        return;
    }
    if let Some(id) = target.strip_prefix("/credentials?id=").and_then(|value| value.parse::<i64>().ok()) {
        let match_entry = parsed.as_array().and_then(|items| items.iter().find(|item| item.get("id").and_then(serde_json::Value::as_i64) == Some(id)));
        let Some(item) = match_entry else {
            let _ = bridge_response(&mut stream, "404 Not Found", "{\"error\":\"Entrée introuvable\"}");
            return;
        };
        let credentials = serde_json::json!({
            "username": item.get("username").and_then(serde_json::Value::as_str).unwrap_or(""),
            "password": item.get("password").and_then(serde_json::Value::as_str).unwrap_or(""),
            "totpSecret": item.get("totpSecret").and_then(serde_json::Value::as_str),
            "totpDigits": item.get("totpDigits").and_then(serde_json::Value::as_u64).unwrap_or(6),
            "totpPeriod": item.get("totpPeriod").and_then(serde_json::Value::as_u64).unwrap_or(30),
            "totpAlgorithm": item.get("totpAlgorithm").and_then(serde_json::Value::as_str).unwrap_or("SHA1"),
        });
        let body = serde_json::to_string(&credentials).unwrap_or_else(|_| "{}".into());
        let _ = bridge_response(&mut stream, "200 OK", &body);
        return;
    }
    let _ = bridge_response(&mut stream, "404 Not Found", "{\"error\":\"Route inconnue\"}");
}

#[tauri::command]
fn start_autofill_bridge(data: String) -> Result<BridgeInfo, String> {
    if let Some(state) = BRIDGE_STATE.get() {
        if let Ok(mut value) = state.lock() {
            value.data = data;
            value.active = true;
            return Ok(value.info.clone());
        }
        return Err("Le pont d’autoremplissage est indisponible".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Impossible de démarrer le pont local : {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let mut token_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let state = Arc::new(Mutex::new(BridgeState { info: BridgeInfo { port, token: B64.encode(token_bytes) }, data, active: true }));
    let info = state.lock().map_err(|_| "Le pont local est indisponible".to_string())?.info.clone();
    BRIDGE_STATE.set(state.clone()).map_err(|_| "Le pont local est déjà démarré".to_string())?;
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_bridge_connection(stream, &state);
        }
    });
    Ok(info)
}

#[tauri::command]
fn stop_autofill_bridge() -> Result<(), String> {
    if let Some(state) = BRIDGE_STATE.get() {
        let mut value = state.lock().map_err(|_| "Le pont local est indisponible".to_string())?;
        value.data = "[]".into();
        value.active = false;
    }
    Ok(())
}

#[tauri::command]
fn import_kdbx(path: String, password: String) -> Result<String, String> {
    let mut file = fs::File::open(&path)
        .map_err(|error| format!("Impossible d’ouvrir le fichier KeePass : {error}"))?;
    let database = Database::open(&mut file, DatabaseKey::new().with_password(&password))
        .map_err(|error| format!("Impossible de déchiffrer le coffre KeePass : {error}"))?;
    let mut entries = Vec::new();

    for node in NodeIterator::new(&database.root) {
        with_node::<Entry, _, _>(&node, |entry| {
            let group = database.node_get_parents(&node).first()
                .and_then(|uuid| database.search_node_by_uuid(*uuid))
                .and_then(|parent| with_node::<Group, _, _>(&parent, |value| value.get_title().unwrap_or("Import KeePass").to_string()))
                .unwrap_or_else(|| "Import KeePass".into());
            entries.push(KdbxEntry {
                title: entry.get_title().unwrap_or("Sans titre").to_string(),
                username: entry.get_username().unwrap_or_default().to_string(),
                password: entry.get_password().unwrap_or_default().to_string(),
                url: entry.get_url().unwrap_or_default().to_string(),
                notes: entry.get_notes().unwrap_or_default().to_string(),
                totp_secret: entry.get_raw_otp_value().map(str::to_string),
                group,
            });
        });
    }

    serde_json::to_string(&entries)
        .map_err(|error| format!("Impossible de préparer les entrées importées : {error}"))
}

fn export_totp_value(item: &ExportEntry) -> Option<String> {
    let secret = item.totp_secret.as_deref()?.trim();
    if secret.is_empty() {
        return None;
    }
    if secret.starts_with("otpauth://") {
        return Some(secret.to_string());
    }
    let digits = match item.totp_digits.unwrap_or(6) {
        7 => 7,
        8 => 8,
        _ => 6,
    };
    let period = item.totp_period.unwrap_or(30).clamp(1, 300);
    let algorithm = match item.totp_algorithm.as_deref() {
        Some("SHA256") => "SHA256",
        Some("SHA512") => "SHA512",
        _ => "SHA1",
    };
    Some(format!("otpauth://totp/Vaultly?secret={secret}&algorithm={algorithm}&digits={digits}&period={period}"))
}

#[tauri::command]
fn export_kdbx(path: String, password: String, data: String) -> Result<(), String> {
    if password.trim().len() < 8 {
        return Err("Le mot de passe KeePass doit contenir au moins 8 caractères".into());
    }
    let entries: Vec<ExportEntry> = serde_json::from_str(&data)
        .map_err(|error| format!("Les données à exporter sont invalides : {error}"))?;
    let database = Database::new(DatabaseConfig::default());
    let mut groups: HashMap<String, keepass_ng::db::NodePtr> = HashMap::new();
    for item in entries {
        let mut entry = Entry::default();
        entry.set_title(Some(&item.title));
        entry.set_username(Some(&item.username));
        entry.set_password(Some(&item.password));
        entry.set_url(Some(&item.url));
        entry.set_notes(item.notes.as_deref());
        let totp_value = export_totp_value(&item);
        entry.set_raw_otp_value(totp_value.as_deref());
        let group_name = item.category.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or("Vaultly").to_string();
        let group = if let Some(existing) = groups.get(&group_name) {
            existing.clone()
        } else {
            let created = rc_refcell_node(Group::new(&group_name));
            group_add_child(&database.root, created.clone(), 0)
                .map_err(|error| format!("Impossible de préparer le groupe KeePass : {error}"))?;
            groups.insert(group_name, created.clone());
            created
        };
        group_add_child(&group, rc_refcell_node(entry), 0)
            .map_err(|error| format!("Impossible de préparer l’entrée KeePass : {error}"))?;
    }
    let mut file = fs::File::create(&path)
        .map_err(|error| format!("Impossible de créer le fichier KeePass : {error}"))?;
    database.save(&mut file, DatabaseKey::new().with_password(&password))
        .map_err(|error| format!("Impossible d’exporter le coffre KeePass : {error}"))
}

#[cfg(windows)]
fn clean_executable_path(value: &str) -> Option<String> {
    let candidate = value
        .trim()
        .trim_matches('"')
        .split(',')
        .next()
        .unwrap_or_default()
        .trim_matches('"')
        .trim();
    let path = PathBuf::from(candidate);
    if path.is_file() && path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[cfg(windows)]
fn scan_uninstall_key(hive: winreg::HKEY, path: &str, apps: &mut Vec<InstalledApp>) {
    let root = RegKey::predef(hive);
    let Ok(uninstall) = root.open_subkey(path) else { return };
    for key_name in uninstall.enum_keys().flatten() {
        let Ok(key) = uninstall.open_subkey(&key_name) else { continue };
        let Ok(name) = key.get_value::<String, _>("DisplayName") else { continue };
        let executable = key
            .get_value::<String, _>("DisplayIcon")
            .ok()
            .and_then(|value| clean_executable_path(&value))
            .or_else(|| key.get_value::<String, _>("InstallLocation").ok().and_then(|value| {
                let directory = PathBuf::from(value);
                if !directory.is_dir() { return None; }
                let direct_candidate = directory.join(format!("{name}.exe"));
                clean_executable_path(&direct_candidate.to_string_lossy())
            }));
        if let Some(path) = executable {
            apps.push(InstalledApp { name, path });
        }
    }
}

#[cfg(windows)]
fn scan_app_paths(hive: winreg::HKEY, apps: &mut Vec<InstalledApp>) {
    let root = RegKey::predef(hive);
    let Ok(app_paths) = root.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths") else { return };
    for key_name in app_paths.enum_keys().flatten() {
        let Ok(key) = app_paths.open_subkey(&key_name) else { continue };
        let Ok(raw_path) = key.get_value::<String, _>("") else { continue };
        let Some(path) = clean_executable_path(&raw_path) else { continue };
        let name = PathBuf::from(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&key_name)
            .to_string();
        apps.push(InstalledApp { name, path });
    }
}

#[tauri::command]
fn scan_installed_apps() -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    #[cfg(windows)]
    {
        scan_uninstall_key(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", &mut apps);
        scan_uninstall_key(HKEY_LOCAL_MACHINE, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", &mut apps);
        scan_uninstall_key(HKEY_LOCAL_MACHINE, "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", &mut apps);
        scan_app_paths(HKEY_CURRENT_USER, &mut apps);
        scan_app_paths(HKEY_LOCAL_MACHINE, &mut apps);
    }
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps.dedup_by(|left, right| left.path.eq_ignore_ascii_case(&right.path));
    apps
}

#[tauri::command]
fn launch_application(path: String) -> Result<(), String> {
    let executable = PathBuf::from(&path);
    if !executable.is_file() {
        return Err("Le chemin de l’application n’existe plus".into());
    }
    Command::new(executable)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Impossible de lancer l’application : {error}"))
}

#[cfg(windows)]
fn send_key(vk: u16) -> Result<(), String> {
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), ..Default::default() } },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), dwFlags: KEYEVENTF_KEYUP, ..Default::default() } },
    };
    let inputs = [down, up];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err("Windows n’a pas accepté la saisie automatique".into());
    }
    Ok(())
}

#[cfg(windows)]
fn send_text(value: &str) -> Result<(), String> {
    for code_unit in value.encode_utf16() {
        let down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: code_unit, dwFlags: KEYEVENTF_UNICODE, ..Default::default() } },
        };
        let up = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: code_unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, ..Default::default() } },
        };
        let inputs = [down, up];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err("Windows n’a pas accepté la saisie automatique".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn focus_process_window(hwnd: windows::Win32::Foundation::HWND, process_id: windows::Win32::Foundation::LPARAM) -> windows::core::BOOL {
    let mut window_process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut window_process_id));
    if window_process_id == process_id.0 as u32 && IsWindowVisible(hwnd).as_bool() {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
        return windows::core::BOOL(0);
    }
    windows::core::BOOL(1)
}

#[cfg(windows)]
fn bring_process_to_front(process_id: u32) {
    unsafe {
        let _ = EnumWindows(Some(focus_process_window), windows::Win32::Foundation::LPARAM(process_id as isize));
    }
}

#[tauri::command]
fn launch_and_autofill(path: String, username: String, password: String, adapter: Option<String>, totp: Option<String>) -> Result<(), String> {
    let executable = PathBuf::from(&path);
    if !executable.is_file() {
        return Err("Le chemin de l’application n’existe plus".into());
    }
    let child = Command::new(executable)
        .spawn()
        .map_err(|error| format!("Impossible de lancer l’application : {error}"))?;

    #[cfg(windows)]
    {
        let startup_wait = match adapter.as_deref() {
            Some("battle_net") | Some("epic_games") => Duration::from_millis(4500),
            Some("steam") | Some("microsoft") | Some("google") => Duration::from_millis(3500),
            Some("discord") => Duration::from_millis(3000),
            _ => Duration::from_secs(3),
        };
        std::thread::sleep(startup_wait);
        bring_process_to_front(child.id());
        std::thread::sleep(std::time::Duration::from_millis(250));
        send_text(&username)?;
        send_key(0x09)?;
        std::thread::sleep(std::time::Duration::from_millis(120));
        send_text(&password)?;
        send_key(0x0D)?;
        if adapter.is_some() {
            if let Some(code) = totp {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                send_text(&code)?;
                send_key(0x0D)?;
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        let _ = (username, password, adapter, totp);
        Err("La saisie automatique des applications est disponible sous Windows".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_vault,
            open_vault,
            change_master_password,
            create_recovery_backup,
            default_vault_path,
            vault_exists,
            copy_vault,
            sync_vault_to_folder,
            restore_vault_from_folder,
            read_file_base64,
            write_file_base64,
            start_autofill_bridge,
            stop_autofill_bridge,
            import_kdbx,
            export_kdbx,
            scan_installed_apps,
            launch_application,
            launch_and_autofill
        ])
        .run(tauri::generate_context!())
        .expect("Erreur lors du démarrage de Vaultly");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_round_trip_uses_authenticated_encryption() {
        let envelope = encrypt_vault("mot-de-passe-test", br#"[{"title":"test"}]"#).expect("chiffrement");
        assert_eq!(decrypt_vault("mot-de-passe-test", &envelope).expect("déchiffrement"), r#"[{"title":"test"}]"#);
        assert!(decrypt_vault("mauvais-mot-de-passe", &envelope).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let mut envelope = encrypt_vault("mot-de-passe-test", b"secret").expect("chiffrement");
        envelope.ciphertext.push('A');
        assert!(decrypt_vault("mot-de-passe-test", &envelope).is_err());
    }

    #[test]
    fn unsupported_vault_metadata_is_rejected() {
        let mut envelope = encrypt_vault("mot-de-passe-test", b"secret").expect("chiffrement");
        envelope.cipher = "AES-GCM".into();
        assert!(decrypt_vault("mot-de-passe-test", &envelope).is_err());
    }

    #[test]
    fn persistence_backup_and_recovery_round_trip() {
        let suffix = format!("{}-{}", std::process::id(), rand::random::<u64>());
        let root = std::env::temp_dir().join(format!("vaultly-test-{suffix}"));
        fs::create_dir_all(&root).expect("dossier temporaire");
        let source = root.join("principal.vault");
        let recovery = root.join("recovery.vault");
        let data = r#"[{"title":"Compte local","password":"secret"}]"#;

        save_vault(source.to_string_lossy().into_owned(), "mot-de-passe-test".into(), data.into()).expect("sauvegarde");
        assert_eq!(open_vault(source.to_string_lossy().into_owned(), "mot-de-passe-test".into()).expect("ouverture"), data);
        save_vault(source.to_string_lossy().into_owned(), "mot-de-passe-test".into(), r#"[]"#.into()).expect("seconde sauvegarde");
        assert!(source.with_extension("vault.bak").is_file());
        assert_eq!(open_vault(source.with_extension("vault.bak").to_string_lossy().into_owned(), "mot-de-passe-test".into()).expect("ouverture sauvegarde"), data);

        create_recovery_backup(source.to_string_lossy().into_owned(), "mot-de-passe-test".into(), recovery.to_string_lossy().into_owned(), "code-de-recuperation-securise".into()).expect("récupération");
        assert_eq!(open_vault(recovery.to_string_lossy().into_owned(), "code-de-recuperation-securise".into()).expect("ouverture récupération"), r#"[]"#);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keepass_export_import_preserves_totp_uri_and_entry_fields() {
        let suffix = format!("{}-{}", std::process::id(), rand::random::<u64>());
        let root = std::env::temp_dir().join(format!("vaultly-keepass-test-{suffix}"));
        fs::create_dir_all(&root).expect("dossier temporaire");
        let path = root.join("export.kdbx");
        let source = r#"[{"title":"Compte Battle.net","username":"joueur@example.com","password":"mot-de-passe","url":"https://account.battle.net/","notes":"Compte principal","totpSecret":"JBSWY3DPEHPK3PXP","totpDigits":8,"totpPeriod":45,"totpAlgorithm":"SHA512","category":"Jeux"}]"#;

        export_kdbx(path.to_string_lossy().into_owned(), "mot-de-passe-kdbx".into(), source.into()).expect("export KeePass");
        let imported = import_kdbx(path.to_string_lossy().into_owned(), "mot-de-passe-kdbx".into()).expect("import KeePass");
        let entries: Vec<KdbxEntry> = serde_json::from_str(&imported).expect("JSON importé");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Compte Battle.net");
        assert_eq!(entries[0].username, "joueur@example.com");
        assert_eq!(entries[0].password, "mot-de-passe");
        assert_eq!(entries[0].url, "https://account.battle.net/");
        assert_eq!(entries[0].notes, "Compte principal");
        assert_eq!(entries[0].group, "Jeux");
        assert_eq!(entries[0].totp_secret.as_deref(), Some("otpauth://totp/Vaultly?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512&digits=8&period=45"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn secure_file_round_trip_and_size_limit_are_enforced() {
        let suffix = format!("{}-{}", std::process::id(), rand::random::<u64>());
        let root = std::env::temp_dir().join(format!("vaultly-attachment-test-{suffix}"));
        fs::create_dir_all(&root).expect("dossier temporaire");
        let source = root.join("source.bin");
        let destination = root.join("restored.bin");
        let bytes = vec![0x00, 0x01, 0x7f, 0xff, 0x42];
        fs::write(&source, &bytes).expect("fichier source");

        let encoded = read_file_base64(source.to_string_lossy().into_owned()).expect("lecture chiffrable");
        write_file_base64(destination.to_string_lossy().into_owned(), encoded).expect("restauration");
        assert_eq!(fs::read(&destination).expect("fichier restauré"), bytes);

        let oversized = "A".repeat((50 * 1024 * 1024 + 2) * 4 / 3 + 1);
        assert!(write_file_base64(destination.to_string_lossy().into_owned(), oversized).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn encrypted_sync_never_exposes_plaintext_and_restores() {
        let suffix = format!("{}-{}", std::process::id(), rand::random::<u64>());
        let root = std::env::temp_dir().join(format!("vaultly-sync-test-{suffix}"));
        fs::create_dir_all(&root).expect("dossier temporaire");
        let source = root.join("source.vault");
        let restore = root.join("restore.vault");
        let data = r#"[{"title":"Compte privé","password":"secret"}]"#;

        save_vault(source.to_string_lossy().into_owned(), "mot-de-passe-test".into(), data.into()).expect("sauvegarde");
        let synced = sync_vault_to_folder(source.to_string_lossy().into_owned(), root.to_string_lossy().into_owned()).expect("synchronisation");
        let synced_bytes = fs::read(&synced).expect("copie synchronisée");
        assert!(!String::from_utf8_lossy(&synced_bytes).contains("Compte privé"));
        assert_eq!(restore_vault_from_folder(root.to_string_lossy().into_owned(), restore.to_string_lossy().into_owned(), "mot-de-passe-test".into()).expect("restauration"), data);
        assert_eq!(open_vault(restore.to_string_lossy().into_owned(), "mot-de-passe-test".into()).expect("ouverture restaurée"), data);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn autofill_bridge_is_authenticated_and_lockable() {
        let info = start_autofill_bridge(r#"[{"id":7,"title":"Battle.net","provider":"Battle.net","url":"https://account.battle.net/","username":"user@example.com","password":"secret"}]"#.into()).expect("pont local");
        let request = |target: &str, token: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", info.port)).expect("connexion pont");
            let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Vaultly-Token: {token}\r\nConnection: close\r\n\r\n");
            stream.write_all(request.as_bytes()).expect("requête pont");
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("réponse pont");
            response
        };

        let metadata = request("/entries", &info.token);
        assert!(metadata.starts_with("HTTP/1.1 200 OK"));
        assert!(metadata.contains("Battle.net"));
        assert!(!metadata.contains("secret"));
        assert!(metadata.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
        assert!(request("/credentials?id=7", "mauvais-jeton").starts_with("HTTP/1.1 401 Unauthorized"));

        stop_autofill_bridge().expect("verrouillage pont");
        assert!(request("/credentials?id=7", &info.token).starts_with("HTTP/1.1 401 Unauthorized"));
    }
}
