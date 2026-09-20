// TrackLab Cookie Stash — background service worker (Manifest V3)
//
// What it does, in order:
//  1. While the TrackLab site is open, it keeps a copy of the site's cookies in extension storage.
//  2. When you leave (last site tab closes, or the tab navigates elsewhere), it deletes those cookies from the browser.
//  3. When you come back and the site's cookie jar is empty, it puts the stashed cookies back before the page loads.
//
// Safety rails:
//  - Only the exact origin below is ever touched.
//  - Only cookies whose name starts with "tl_" are touched. Other apps on localhost (any port)
//    share the same cookie jar, so the prefix keeps them out of this.

const SITE_ORIGIN = "http://localhost:8080"; // if you change the port, also change it in the webNavigation filter below
const PREFIX = "tl_";

const isSite = (url) => {
  try { return new URL(url).origin === SITE_ORIGIN; } catch { return false; }
};

// One task at a time, so snapshot / wipe / restore can never interleave.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn).catch((e) => console.error("[stash]", e));
  queue = p;
  return p;
}

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}

async function getTabs() {
  const { siteTabs = [] } = await chrome.storage.session.get("siteTabs");
  return new Set(siteTabs);
}
const setTabs = (set) => chrome.storage.session.set({ siteTabs: [...set] });

async function getSiteCookies() {
  const all = await chrome.cookies.getAll({ url: SITE_ORIGIN });
  return all.filter((c) => c.name.startsWith(PREFIX));
}

// Save the current jar. An empty jar never overwrites the stash.
async function snapshot() {
  if (!(await isEnabled())) return;
  const cookies = await getSiteCookies();
  if (!cookies.length) return;
  await chrome.storage.local.set({
    stash: {
      savedAt: Date.now(),
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        path: c.path,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
        httpOnly: c.httpOnly,
      })),
    },
  });
}

async function wipe() {
  const cookies = await getSiteCookies();
  await Promise.all(
    cookies.map((c) => chrome.cookies.remove({ url: SITE_ORIGIN + c.path, name: c.name }))
  );
  return cookies.length;
}

async function restore() {
  const { stash } = await chrome.storage.local.get("stash");
  if (!stash) return 0;
  const now = Date.now() / 1000;
  let restored = 0;
  for (const c of stash.cookies) {
    if (c.expirationDate && c.expirationDate < now) continue;
    const details = {
      url: SITE_ORIGIN + c.path,
      name: c.name,
      value: c.value,
      path: c.path,
      httpOnly: c.httpOnly,
    };
    if (c.expirationDate) details.expirationDate = c.expirationDate;
    if (c.sameSite === "lax" || c.sameSite === "strict") details.sameSite = c.sameSite;
    try {
      await chrome.cookies.set(details);
      restored++;
    } catch (e) {
      console.warn("[stash] could not restore", c.name, e);
    }
  }
  return restored;
}

async function leave() {
  if (!(await isEnabled())) return;
  await snapshot(); // final copy while the jar is still full
  await wipe();
}

// ── Keep the stash fresh while the site is open ─────────────────────────────
let snapTimer;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!cookie.name.startsWith(PREFIX)) return;
  if (cookie.domain !== "localhost" && cookie.domain !== ".localhost") return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => enqueue(snapshot), 400);
});

// ── Track which tabs are on the site, so we know when you've really left ────
async function noteTab(tabId, url) {
  const tabs = await getTabs();
  const on = isSite(url);
  const was = tabs.has(tabId);
  if (on && !was) {
    tabs.add(tabId);
    await setTabs(tabs);
  } else if (!on && was) {
    tabs.delete(tabId);
    await setTabs(tabs);
    if (tabs.size === 0) await leave();
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) enqueue(() => noteTab(tabId, info.url));
});

chrome.tabs.onRemoved.addListener((tabId) =>
  enqueue(async () => {
    const tabs = await getTabs();
    if (!tabs.has(tabId)) return;
    tabs.delete(tabId);
    await setTabs(tabs);
    if (tabs.size === 0) await leave();
  })
);

// ── Hand the cookies back as early as we can when you return ────────────────
chrome.webNavigation.onBeforeNavigate.addListener(
  (d) => {
    if (d.frameId !== 0 || !isSite(d.url)) return;
    enqueue(async () => {
      const tabs = await getTabs();
      tabs.add(d.tabId);
      await setTabs(tabs);
      // Only restore into an empty jar. If cookies are already there, they're newer than the stash.
      if ((await isEnabled()) && (await getSiteCookies()).length === 0) await restore();
    });
  },
  { url: [{ hostEquals: "localhost", schemes: ["http"], ports: [8080] }] }
);

// ── Startup housekeeping ────────────────────────────────────────────────────
async function rescan() {
  const all = await chrome.tabs.query({});
  const ids = all.filter((t) => t.url && isSite(t.url)).map((t) => t.id);
  await setTabs(new Set(ids));
  return ids.length;
}

chrome.runtime.onInstalled.addListener(() =>
  enqueue(async () => {
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled === undefined) await chrome.storage.local.set({ enabled: true });
    await rescan();
    await snapshot();
  })
);

// Browser was closed while on the site: tab-close events never fired, so clean up now.
chrome.runtime.onStartup.addListener(() =>
  enqueue(async () => {
    if ((await rescan()) === 0) await leave();
  })
);

// ── Popup API ───────────────────────────────────────────────────────────────
async function handle(msg) {
  switch (msg.type) {
    case "status": {
      const { stash } = await chrome.storage.local.get("stash");
      const jar = await getSiteCookies();
      return {
        enabled: await isEnabled(),
        siteTabs: (await getTabs()).size,
        jar: jar.map((c) => ({ name: c.name, value: c.value })),
        stash: stash ? stash.cookies.map((c) => ({ name: c.name, value: c.value })) : [],
        savedAt: stash ? stash.savedAt : null,
      };
    }
    case "toggle":
      await chrome.storage.local.set({ enabled: msg.enabled });
      if (msg.enabled) await snapshot();
      return {};
    case "restore":
      return { restored: await restore() };
    case "wipe":
      await snapshot();
      return { removed: await wipe() };
    case "clearStash":
      await chrome.storage.local.remove("stash");
      return {};
    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  enqueue(() => handle(msg)).then(respond);
  return true;
});
