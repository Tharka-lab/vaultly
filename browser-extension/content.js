(async () => {
  const language = (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
  const text = {
    fr: { fill: (count) => `🔐 Vaultly (${count})`, title: "Remplir avec une entrée Vaultly", choose: "Choisis un numéro :", done: "✓ Vaultly rempli", unavailable: "Vaultly indisponible", missing: "Entrée introuvable", form: "Formulaire de connexion introuvable", invalidTotp: "Secret TOTP invalide" },
    en: { fill: (count) => `🔐 Vaultly (${count})`, title: "Fill with a Vaultly entry", choose: "Choose a number:", done: "✓ Vaultly filled", unavailable: "Vaultly unavailable", missing: "Entry not found", form: "Login form not found", invalidTotp: "Invalid TOTP secret" },
  }[language];
  const config = await chrome.storage.local.get(["port", "token"]);
  if (!config.port || !config.token) return;

  const base = `http://127.0.0.1:${config.port}`;
  const headers = { "X-Vaultly-Token": config.token };
  let entries;
  try {
    const response = await fetch(`${base}/entries`, { headers, cache: "no-store" });
    if (!response.ok) return;
    entries = await response.json();
  } catch { return; }

  const currentHost = location.hostname.toLowerCase();
  const matching = entries.filter((entry) => {
    try { return entry.url && new URL(entry.url).hostname.toLowerCase() === currentHost; }
    catch { return entry.provider && currentHost.includes(String(entry.provider).toLowerCase()); }
  });
  if (!matching.length) return;

  function findVisibleInputs() {
    return Array.from(document.querySelectorAll("input")).filter((element) => {
      const style = getComputedStyle(element);
      return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
  }

  function findLoginFields() {
    const inputs = findVisibleInputs();
    const username = inputs.find((input) => input.autocomplete === "username" || input.type === "email" || /user|email/i.test(`${input.name} ${input.id}`))
      || inputs.find((input) => input.type === "text");
    const password = inputs.find((input) => input.autocomplete === "current-password" || input.type === "password");
    return { username, password };
  }

  function fill(element, value) {
    const setter = Object.getOwnPropertyDescriptor(element.ownerDocument.defaultView.HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function makeButton() {
    if (document.querySelector('[data-vaultly-button="true"]')) return;
    const fields = findLoginFields();
    if (!fields.username || !fields.password) return;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.vaultlyButton = "true";
    button.textContent = text.fill(matching.length);
    button.title = text.title;
    button.setAttribute("aria-label", text.title);
    Object.assign(button.style, { position: "fixed", zIndex: "2147483647", right: "18px", bottom: "18px", padding: "10px 13px", border: "1px solid #7564e8", borderRadius: "9px", color: "white", background: "#211d42", boxShadow: "0 8px 25px #0006", font: "600 12px Segoe UI, sans-serif", cursor: "pointer" });

    button.addEventListener("click", async () => {
      const choice = matching.length === 1 ? matching[0] : (matching[Number(prompt(matching.map((entry, index) => `${index + 1}. ${entry.title}`).join("\n") + `\n\n${text.choose}`) || "1") - 1] || matching[0]);
      try {
        const response = await fetch(`${base}/credentials?id=${encodeURIComponent(choice.id)}`, { headers, cache: "no-store" });
        if (!response.ok) throw new Error(text.unavailable);
        const credentials = await response.json();
        if (!credentials) throw new Error(text.missing);
        const currentFields = findLoginFields();
        if (!currentFields.username || !currentFields.password) throw new Error(text.form);
        fill(currentFields.username, credentials.username || "");
        fill(currentFields.password, credentials.password || "");
        const totpInput = findVisibleInputs().find((input) => input.autocomplete === "one-time-code" || /otp|2fa|token/i.test(`${input.name} ${input.id}`));
        if (totpInput && credentials.totpSecret) {
          fill(totpInput, await calculateTotp(credentials.totpSecret, credentials.totpDigits, credentials.totpPeriod, credentials.totpAlgorithm));
        }
        button.textContent = text.done;
        setTimeout(() => { if (button.isConnected) button.textContent = text.fill(matching.length); }, 1800);
      } catch (error) { button.textContent = `⚠ ${error.message}`; }
    });
    document.documentElement.appendChild(button);
  }

  makeButton();
  const observer = new MutationObserver(() => makeButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });

  function decodeBase32(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const normalized = String(value).replace(/[=\s-]/g, "").toUpperCase();
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const character of normalized) {
      const index = alphabet.indexOf(character);
      if (index < 0) return new Uint8Array();
      buffer = (buffer << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }

  async function calculateTotp(secret, digits = 6, period = 30, algorithm = "SHA1") {
    const keyData = decodeBase32(secret);
    if (!keyData.length) throw new Error(text.invalidTotp);
    const hash = algorithm === "SHA256" ? "SHA-256" : algorithm === "SHA512" ? "SHA-512" : "SHA-1";
    const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash }, false, ["sign"]);
    const counter = Math.floor(Date.now() / ((Number(period) || 30) * 1000));
    const counterBytes = new ArrayBuffer(8);
    new DataView(counterBytes).setUint32(4, counter);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
    const length = [6, 7, 8].includes(Number(digits)) ? Number(digits) : 6;
    return String(binary % (10 ** length)).padStart(length, "0");
  }
})();
