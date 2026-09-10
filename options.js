const port = document.querySelector("#port");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const language = (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
const translations = {
  fr: { title: "Vaultly — Configuration", heading: "Connexion à Vaultly", instructions: "Dans Vaultly déverrouillé, ouvre Paramètres → Autoremplissage web → Copier la configuration.", port: "Port local", portPlaceholder: "ex. 24871", token: "Jeton temporaire", tokenPlaceholder: "Colle le jeton Vaultly", save: "Enregistrer et tester", active: "Connexion Vaultly active.", refused: "Configuration refusée par Vaultly.", unavailable: "Impossible de joindre Vaultly. Vérifie que le coffre est déverrouillé." },
  en: { title: "Vaultly — Setup", heading: "Connect to Vaultly", instructions: "In unlocked Vaultly, open Settings → Web autofill → Copy configuration.", port: "Local port", portPlaceholder: "e.g. 24871", token: "Temporary token", tokenPlaceholder: "Paste the Vaultly token", save: "Save and test", active: "Vaultly connection active.", refused: "Vaultly rejected the configuration.", unavailable: "Unable to reach Vaultly. Make sure the vault is unlocked." },
}[language];
document.documentElement.lang = language;
document.title = translations.title;
document.querySelector("h1").textContent = translations.heading;
document.querySelector("body > p").textContent = translations.instructions;
const labels = document.querySelectorAll("label");
if (labels[0]?.firstChild) labels[0].firstChild.textContent = translations.port;
if (labels[1]?.firstChild) labels[1].firstChild.textContent = translations.token;
port.placeholder = translations.portPlaceholder;
token.placeholder = translations.tokenPlaceholder;
document.querySelector("#save").textContent = translations.save;
chrome.storage.local.get(["port", "token"]).then((config) => { port.value = config.port || ""; token.value = config.token || ""; });
document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ port: Number(port.value), token: token.value.trim() });
  try {
    const response = await fetch(`http://127.0.0.1:${port.value}/entries`, { headers: { "X-Vaultly-Token": token.value.trim() }, cache: "no-store" });
    status.textContent = response.ok ? translations.active : translations.refused;
  } catch { status.textContent = translations.unavailable; }
});
