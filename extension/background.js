// TrackLab Cookie Stash — background service worker (Manifest V3)
//
// Two modules that share one popup:
//
//  1. Cookie Vault (session isolation). For each site on the allowlist, cookies are kept in an
//     AES-GCM encrypted vault. When you leave the site they are removed from the browser; when you
//     come back to an empty jar they are put back. If the vault is locked, NOTHING is wiped or
//     restored, so a locked vault can never lose a session.
//
//  2. Tracker Guard. Watches for advertising-tracker cookies (see trackers.js), alerts you or
//     removes them. Advertising only: analytics, logins and site-function cookies are ignored.
//     Domains on the trusted list are never alerted on or blocked.

importScripts("config.js", "trackers.js", "vault.js");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_SITE = { origin: CONFIG.origin, path: CONFIG.path, prefix: "tl_" };

// ── Plumbing ────────────────────────────────────────────────────────────────
// One task at a time so snapshot / wipe / restore / detection writes never interleave.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn).catch((e) => console.error("[stash]", e));
  queue = p;
  return p;
}

let sitesCache = null;
let guardCache = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.sites) sitesCache = null;
  if (ch.guardMode || ch.allow) guardCache = null;
});

async function sitesList() {
  if (!sitesCache) sitesCache = (await chrome.storage.local.get("sites")).sites || [];
  return sitesCache;
}
async function guardCfg() {
  if (!guardCache) {
    const { guardMode = "alert", allow = [] } = await chrome.storage.local.get(["guardMode", "allow"]);
    guardCache = { mode: guardMode, allow };
  }
  return guardCache;
}
async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}
async function getTabs() {
  return (await chrome.storage.session.get("siteTabs")).siteTabs || {};
}
const setTabs = (t) => chrome.storage.session.set({ siteTabs: t });

const siteKey = (s) => s.origin + s.path;
function matchSite(sites, url) {
  try {
    const u = new URL(url);
    return sites.find((s) => u.origin === s.origin && u.pathname.startsWith(s.path)) || null;
  } catch { return null; }
}
function pathFor(u) {
  // GitHub Pages serves every repo of a user from one origin, so scope to the repo's folder.
  if (u.hostname.endsWith(".github.io")) {
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2 || (seg.length === 1 && u.pathname.endsWith("/"))) return `/${seg[0]}/`;
  }
  return "/";
}

// ── Vault ───────────────────────────────────────────────────────────────────
async function vaultMeta() {
  return (await chrome.storage.local.get("vault")).vault || null;
}
async function getKey() {
  const { vaultKey } = await chrome.storage.session.get("vaultKey");
  return vaultKey ? Vault.importKey(vaultKey) : null;
}
async function readMap(key) {
  const v = await vaultMeta();
  return v && v.data ? Vault.open(key, v.data) : {};
}
async function writeMap(key, map) {
  const v = await vaultMeta();
  v.data = await Vault.seal(key, map);
  await chrome.storage.local.set({ vault: v });
}

// ── Cookie plumbing for allowlisted sites ───────────────────────────────────
async function siteCookies(site) {
  const all = await chrome.cookies.getAll({ url: site.origin + site.path });
  return all.filter((c) => c.name.startsWith(site.prefix || ""));
}

function cookieBelongsToSite(cookie, site) {
  const host = cookie.domain.replace(/^\./, "");
  const sh = new URL(site.origin).hostname;
  return (sh === host || sh.endsWith("." + host)) && cookie.name.startsWith(site.prefix || "");
}

const pick = (c) => ({
  name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path,
  secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate,
});

// Returns true when it is safe to remove the site's cookies afterwards.
async function snapshot(site) {
  if (!(await isEnabled())) return false;
  const key = await getKey();
  if (!key) return false; // locked: keep the cookies where they are
  const cookies = await siteCookies(site);
  if (!cookies.length) return true; // nothing to lose
  const map = await readMap(key);
  map[siteKey(site)] = { savedAt: Date.now(), cookies: cookies.map(pick) };
  await writeMap(key, map);
  return true;
}

async function wipe(site) {
  const cookies = await siteCookies(site);
  await Promise.all(cookies.map((c) => chrome.cookies.remove({ url: site.origin + c.path, name: c.name })));
  return cookies.length;
}

async function restore(site) {
  const key = await getKey();
  if (!key) return 0;
  const entry = (await readMap(key))[siteKey(site)];
  if (!entry) return 0;
  const https = site.origin.startsWith("https:");
  const now = Date.now() / 1000;
  let n = 0;
  for (const c of entry.cookies) {
    if (c.expirationDate && c.expirationDate < now) continue;
    const d = { url: site.origin + c.path, name: c.name, value: c.value, path: c.path, httpOnly: c.httpOnly };
    if (!c.hostOnly) d.domain = c.domain;
    if (c.expirationDate) d.expirationDate = c.expirationDate;
    if (c.secure && https) d.secure = true;
    if (c.sameSite === "lax" || c.sameSite === "strict") d.sameSite = c.sameSite;
    else if (c.sameSite === "no_restriction" && c.secure && https) d.sameSite = "no_restriction";
    try { await chrome.cookies.set(d); n++; } catch (e) { console.warn("[stash] restore failed", c.name, e); }
  }
  return n;
}

async function leave(site) {
  if (await snapshot(site)) await wipe(site);
}

// Bring the browser in line with the allowlist: sites with an open tab hold their cookies,
// sites without one are emptied (after saving).
async function reconcile() {
  if (!(await isEnabled()) || !(await getKey())) return;
  const open = new Set(Object.values(await getTabs()));
  for (const s of await sitesList()) {
    const jar = await siteCookies(s);
    if (open.has(siteKey(s))) {
      if (jar.length === 0) await restore(s);
      else await snapshot(s);
    } else {
      await leave(s);
    }
  }
}

async function rescan() {
  const sites = await sitesList();
  const tabs = {};
  for (const t of await chrome.tabs.query({})) {
    const s = t.url && matchSite(sites, t.url);
    if (s) tabs[t.id] = siteKey(s);
  }
  await setTabs(tabs);
}

// ── Knowing when you've really left ─────────────────────────────────────────
async function setTabSite(tabId, newKey) {
  const tabs = await getTabs();
  const was = tabs[tabId] || null;
  if (was === newKey) return;
  if (newKey) tabs[tabId] = newKey; else delete tabs[tabId];
  await setTabs(tabs);
  if (was && !Object.values(tabs).includes(was)) {
    const s = (await sitesList()).find((x) => siteKey(x) === was);
    if (s) await leave(s);
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  enqueue(async () => {
    const s = matchSite(await sitesList(), info.url);
    await setTabSite(tabId, s ? siteKey(s) : null);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => enqueue(() => setTabSite(tabId, null)));

// Hand cookies back as early as we can when you return.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  enqueue(async () => {
    const s = matchSite(await sitesList(), d.url);
    if (!s) return;
    await setTabSite(d.tabId, siteKey(s));
    if (!(await isEnabled())) return;
    if (!(await getKey())) { await refreshBadge(); return; }
    if ((await siteCookies(s)).length === 0) await restore(s); // only into an empty jar
  });
});

// ── Cookie events: keep the vault fresh, and run the guard ──────────────────
let snapTimer;
function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => enqueue(snapshotOpen), 400);
}
async function snapshotOpen() {
  if (!(await getKey()) || !(await isEnabled())) return;
  const open = new Set(Object.values(await getTabs()));
  for (const s of await sitesList()) if (open.has(siteKey(s))) await snapshot(s);
}

chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  enqueue(async () => {
    if ((await sitesList()).some((s) => cookieBelongsToSite(cookie, s))) scheduleSnapshot();
    if (!removed) await guardCookie(cookie);
  });
});

// ── Tracker Guard ───────────────────────────────────────────────────────────
const cookieHost = (c) => c.domain.replace(/^\./, "");
const isTrusted = (g, host) => g.allow.some((d) => hostMatches(host, d));

async function removeCookie(c) {
  const url = (c.secure ? "https://" : "http://") + cookieHost(c) + c.path;
  await chrome.cookies.remove({
    url, name: c.name, storeId: c.storeId,
    ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
  });
}

async function refreshBadge() {
  const { detections = [] } = await chrome.storage.local.get("detections");
  if (detections.length) {
    chrome.action.setBadgeText({ text: detections.length > 99 ? "99+" : String(detections.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#c2255c" });
  } else if ((await vaultMeta()) && !(await getKey())) {
    chrome.action.setBadgeText({ text: "🔒" });
    chrome.action.setBadgeBackgroundColor({ color: "#14213d" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function notifyOnce(e) {
  const { notified = [] } = await chrome.storage.session.get("notified");
  if (notified.includes(e.vendor)) return;
  notified.push(e.vendor);
  await chrome.storage.session.set({ notified });
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title: "Ad tracker cookie: " + e.vendor,
    message: `${e.name} was set by ${e.domain}. Open the extension to trust it or turn on blocking.`,
  });
}

async function recordDetection(cookie, hit, mode, quiet) {
  const host = cookieHost(cookie);
  const key = `${host}|${cookie.name}`;
  const { detections = [] } = await chrome.storage.local.get("detections");
  const i = detections.findIndex((d) => d.key === key);
  const prev = i >= 0 ? detections.splice(i, 1)[0] : null;
  const entry = {
    key, vendor: hit.vendor, why: hit.why, domain: host, name: cookie.name,
    action: mode === "block" ? "blocked" : "seen", count: (prev ? prev.count : 0) + 1, t: Date.now(),
  };
  detections.unshift(entry);
  detections.length = Math.min(detections.length, 100);
  await chrome.storage.local.set({ detections });
  await refreshBadge();
  if (!prev && !quiet && mode !== "block") await notifyOnce(entry);
}

async function guardCookie(cookie) {
  const g = await guardCfg();
  if (g.mode === "off") return;
  const hit = classifyCookie(cookie);
  if (!hit || isTrusted(g, cookieHost(cookie))) return;
  await recordDetection(cookie, hit, g.mode);
  if (g.mode === "block") await removeCookie(cookie);
}

// Audit every cookie the extension is allowed to see.
async function scan() {
  const g = await guardCfg();
  let found = 0;
  for (const c of await chrome.cookies.getAll({})) {
    const hit = classifyCookie(c);
    if (!hit || isTrusted(g, cookieHost(c))) continue;
    found++;
    await recordDetection(c, hit, g.mode === "block" ? "block" : "alert", true);
    if (g.mode === "block") await removeCookie(c);
  }
  return found;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() =>
  enqueue(async () => {
    const cur = await chrome.storage.local.get(["sites", "enabled", "guardMode"]);
    const seed = {};
    if (!cur.sites) seed.sites = [DEFAULT_SITE];
    if (cur.enabled === undefined) seed.enabled = true;
    if (cur.guardMode === undefined) seed.guardMode = "alert";
    await chrome.storage.local.set(seed);
    await rescan();
    await refreshBadge();
  })
);

// Browser was closed while on a site: tab-close events never fired, so tidy up now.
chrome.runtime.onStartup.addListener(() =>
  enqueue(async () => {
    await rescan();
    await reconcile();
    await refreshBadge();
  })
);

// ── Popup API ───────────────────────────────────────────────────────────────
const MIN_PASS = 8;

async function handle(msg) {
  try {
    switch (msg.type) {
      case "status": {
        const meta = await vaultMeta();
        const key = await getKey();
        const map = key ? await readMap(key) : null;
        const tabs = Object.values(await getTabs());
        const sites = [];
        for (const s of await sitesList()) {
          const k = siteKey(s);
          const st = map && map[k];
          sites.push({
            key: k, origin: s.origin, path: s.path, prefix: s.prefix,
            jar: (await siteCookies(s)).length,
            stash: st ? st.cookies.length : null,
            savedAt: st ? st.savedAt : null,
            tabs: tabs.filter((t) => t === k).length,
          });
        }
        const g = await guardCfg();
        const { detections = [] } = await chrome.storage.local.get("detections");
        return {
          vault: { exists: !!meta, unlocked: !!key },
          enabled: await isEnabled(),
          sites,
          guard: { mode: g.mode, allow: g.allow, allSites: await chrome.permissions.contains({ origins: ["<all_urls>"] }) },
          detections,
        };
      }

      case "vaultSetup": {
        if (await vaultMeta()) return { error: "A vault already exists." };
        if (!msg.pass || msg.pass.length < MIN_PASS) return { error: `Use at least ${MIN_PASS} characters.` };
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await Vault.deriveKey(msg.pass, salt);
        await chrome.storage.local.set({
          vault: { v: 1, iter: Vault.ITER, salt: Vault.b64(salt), check: await Vault.seal(key, { ok: 1 }), data: await Vault.seal(key, {}) },
        });
        await chrome.storage.session.set({ vaultKey: await Vault.exportKey(key) });
        await reconcile();
        await refreshBadge();
        return {};
      }

      case "vaultUnlock": {
        const v = await vaultMeta();
        if (!v) return { error: "No vault yet." };
        const key = await Vault.deriveKey(msg.pass || "", Vault.unb64(v.salt), v.iter);
        try { await Vault.open(key, v.check); } catch { return { error: "Wrong passphrase." }; }
        await chrome.storage.session.set({ vaultKey: await Vault.exportKey(key) });
        await reconcile();
        await refreshBadge();
        return {};
      }

      case "vaultLock":
        await chrome.storage.session.remove("vaultKey");
        await refreshBadge();
        return {};

      case "vaultReset":
        await chrome.storage.local.remove("vault");
        await chrome.storage.session.remove("vaultKey");
        await refreshBadge();
        return {};

      case "toggle":
        await chrome.storage.local.set({ enabled: msg.enabled });
        if (msg.enabled) await reconcile();
        return {};

      case "siteAdd": {
        const u = new URL(msg.url);
        if (!/^https?:$/.test(u.protocol)) return { error: "Only http and https pages can be added." };
        if (LOCAL_HOSTS.has(u.hostname)) return { error: "localhost is shared by every local app, so only the built-in demo site is allowed." };
        const path = pathFor(u);
        const sites = [...(await sitesList())];
        if (!sites.some((s) => s.origin === u.origin && s.path === path)) {
          sites.push({ origin: u.origin, path, prefix: "" });
          await chrome.storage.local.set({ sites });
          sitesCache = null;
        }
        await rescan();
        await reconcile();
        return {};
      }

      case "siteRemove": {
        const site = (await sitesList()).find((s) => siteKey(s) === msg.key);
        if (!site) return {};
        // Give the session back before we stop managing it.
        if ((await getKey()) && (await siteCookies(site)).length === 0) await restore(site);
        const key = await getKey();
        if (key) {
          const map = await readMap(key);
          delete map[msg.key];
          await writeMap(key, map);
        }
        await chrome.storage.local.set({ sites: (await sitesList()).filter((s) => siteKey(s) !== msg.key) });
        sitesCache = null;
        await rescan();
        return {};
      }

      case "siteRestore": {
        const site = (await sitesList()).find((s) => siteKey(s) === msg.key);
        if (!site) return {};
        if (!(await getKey())) return { error: "Unlock the vault first." };
        return { restored: await restore(site) };
      }

      case "siteWipe": {
        const site = (await sitesList()).find((s) => siteKey(s) === msg.key);
        if (!site) return {};
        if (!(await snapshot(site))) return { error: "Unlock the vault first, otherwise nothing would be saved." };
        return { removed: await wipe(site) };
      }

      case "guardMode": {
        if (!["off", "alert", "block"].includes(msg.mode)) return { error: "Bad mode." };
        await chrome.storage.local.set({ guardMode: msg.mode });
        guardCache = null;
        if (msg.mode !== "off") await scan();
        return {};
      }

      case "guardAllow": {
        const g = await guardCfg();
        const allow = new Set(g.allow);
        if (msg.allowed) allow.add(msg.domain); else allow.delete(msg.domain);
        await chrome.storage.local.set({ allow: [...allow] });
        guardCache = null;
        if (msg.allowed) {
          const { detections = [] } = await chrome.storage.local.get("detections");
          await chrome.storage.local.set({ detections: detections.filter((d) => !hostMatches(d.domain, msg.domain)) });
          await refreshBadge();
        }
        return {};
      }

      case "scan":
        return { found: await scan() };

      case "clearDetections":
        await chrome.storage.local.set({ detections: [] });
        await chrome.storage.session.remove("notified");
        await refreshBadge();
        return {};

      default:
        return {};
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  enqueue(() => handle(msg)).then(respond);
  return true;
});
