// AES-GCM vault helpers. The key is derived from a passphrase with PBKDF2 and is never written to disk.
const Vault = (() => {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const ITER = 250000;

  const b64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(pass, salt, iterations = ITER) {
    const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function open(key, blob) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return JSON.parse(td.decode(pt));
  }

  return {
    ITER, b64, unb64, deriveKey, seal, open,
    exportKey: (k) => crypto.subtle.exportKey("jwk", k),
    importKey: (j) => crypto.subtle.importKey("jwk", j, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]),
  };
})();
