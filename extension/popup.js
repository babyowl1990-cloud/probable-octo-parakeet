const $ = (s) => document.querySelector(s);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const isLocal = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

let S = null;     // last status from the background worker
let page = null;  // URL object for the active tab, or null when it isn't a normal web page
let lastJSON = "";

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}
function say(text, good = false) {
  const m = $("#msg");
  m.textContent = text || "";
  m.className = "msg" + (good ? " good" : "");
}
function emptyItem(list, text) {
  list.append(el("li", { className: "empty", textContent: text }));
}

// ── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    for (const name of ["vault", "site", "guard"]) $("#tab-" + name).hidden = name !== b.dataset.tab;
    say("");
  })
);

// ── Vault tab ───────────────────────────────────────────────────────────────
function renderVault() {
  const v = S.vault;
  $("#v-new").hidden = v.exists;
  $("#v-locked").hidden = !(v.exists && !v.unlocked);
  $("#v-open").hidden = !v.unlocked;
  const pill = $("#vstate");
  pill.textContent = !v.exists ? "No vault yet" : v.unlocked ? "Unlocked" : "Locked";
  pill.className = "pill " + (v.unlocked ? "ok" : v.exists ? "lock" : "");
  $("#enabled").checked = S.enabled;

  const ul = $("#sites");
  ul.replaceChildren();
  if (!S.sites.length) return emptyItem(ul, "No sites yet. Use the This site tab.");
  for (const s of S.sites) {
    const stashed = s.stash === null ? "no saved copy" : `${s.stash} saved`;
    const saved = s.savedAt ? ", " + new Date(s.savedAt).toLocaleTimeString() : "";
    ul.append(el("li", {},
      el("div", { className: "k", textContent: s.origin + s.path }),
      el("div", { className: "small mute", textContent: `In browser: ${s.jar} · Vault: ${stashed}${saved} · Tabs open: ${s.tabs}` }),
      el("div", { className: "row", style: "margin-top:6px" },
        el("button", { className: "b", textContent: "Put back", onclick: () => act("siteRestore", { key: s.key }, "Cookies put back.") }),
        el("button", { className: "b", textContent: "Remove now", onclick: () => act("siteWipe", { key: s.key }, "Saved to the vault and removed.") })
      )
    ));
  }
}

$("#do-setup").addEventListener("click", async () => {
  if ($("#pass1").value !== $("#pass2").value) return say("The two passphrases don't match.");
  const r = await send("vaultSetup", { pass: $("#pass1").value });
  if (r.error) return say(r.error);
  $("#pass1").value = $("#pass2").value = "";
  say("Vault created and unlocked.", true);
  refresh(true);
});
$("#do-unlock").addEventListener("click", async () => {
  const r = await send("vaultUnlock", { pass: $("#pass-unlock").value });
  if (r.error) return say(r.error);
  $("#pass-unlock").value = "";
  say("Unlocked.", true);
  refresh(true);
});
$("#pass-unlock").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#do-unlock").click(); });
$("#do-lock").addEventListener("click", async () => { await send("vaultLock"); say("Locked."); refresh(true); });
$("#do-reset").addEventListener("click", async () => {
  if (!confirm("Delete the vault and everything in it? Cookies already removed from the browser cannot be recovered.")) return;
  await send("vaultReset");
  say("Vault deleted.");
  refresh(true);
});
$("#enabled").addEventListener("change", async (e) => { await send("toggle", { enabled: e.target.checked }); refresh(true); });

async function act(type, extra, okText) {
  const r = await send(type, extra);
  if (r.error) say(r.error); else say(okText, true);
  refresh(true);
}

// ── This site tab ───────────────────────────────────────────────────────────
function findSite() {
  return page && S.sites.find((s) => s.origin === page.origin && page.pathname.startsWith(s.path));
}

function renderSite() {
  const iso = $("#t-isolate"), allow = $("#t-allow");
  if (!page) {
    $("#cur").textContent = "Not a web page";
    $("#cur-note").textContent = "Open a normal http or https page to use these switches.";
    iso.disabled = allow.disabled = true;
    iso.checked = allow.checked = false;
    return;
  }
  $("#cur").textContent = page.hostname;
  iso.disabled = allow.disabled = false;
  iso.checked = !!findSite();
  allow.checked = S.guard.allow.includes(page.hostname);
  $("#cur-note").textContent = isLocal(page.hostname) && !findSite()
    ? "localhost is shared by every local app, so only the built-in demo site can use the vault."
    : "";
}

$("#t-isolate").addEventListener("change", async (e) => {
  const box = e.target;
  const site = findSite();
  if (box.checked) {
    if (isLocal(page.hostname)) { box.checked = false; return say("localhost is shared by every local app, so only the built-in demo site is allowed."); }
    const granted = await chrome.permissions.request({ origins: [page.origin + "/*"] });
    if (!granted) { box.checked = false; return say("Permission declined."); }
    const r = await send("siteAdd", { url: page.href });
    if (r.error) { box.checked = false; return say(r.error); }
    say("Added. Its cookies now live in the vault whenever you're away.", true);
  } else if (site) {
    if (!confirm("Stop managing this site? Its saved cookies are put back in the browser first.")) { box.checked = true; return; }
    await send("siteRemove", { key: site.key });
    if (!isLocal(page.hostname)) chrome.permissions.remove({ origins: [page.origin + "/*"] });
    say("No longer managed.", true);
  }
  refresh(true);
});

$("#t-allow").addEventListener("change", async (e) => {
  await send("guardAllow", { domain: page.hostname, allowed: e.target.checked });
  refresh(true);
});

// ── Ad guard tab ────────────────────────────────────────────────────────────
const MODE_NOTES = {
  off: "Not watching for ad cookies.",
  alert: "You'll get a badge and one notification per ad company per browser session.",
  block: "Ad cookies are deleted right after they're set, so the ID never sticks. The request that set it has already gone out.",
};

function renderGuard() {
  const g = S.guard;
  $("#mode").value = g.mode;
  $("#mode-note").textContent = MODE_NOTES[g.mode];
  $("#allsites-text").textContent = g.allSites ? "Watching every site you visit." : "Watching only localhost and sites you added to the vault.";
  $("#do-allsites").hidden = g.allSites;

  const dets = $("#dets");
  dets.replaceChildren();
  if (!S.detections.length) emptyItem(dets, "No ad cookies found.");
  for (const d of S.detections) {
    dets.append(el("li", {},
      el("div", { className: "row" },
        el("span", { className: "k", textContent: d.vendor }),
        el("span", { className: "tag " + d.action, textContent: d.action })
      ),
      el("div", { className: "small mute", textContent: `${d.name} on ${d.domain}${d.count > 1 ? " · seen " + d.count + "×" : ""}` }),
      el("div", { className: "row", style: "margin-top:6px" },
        el("button", { className: "b", textContent: "Trust this domain", onclick: () => act("guardAllow", { domain: d.domain, allowed: true }, d.domain + " is trusted.") })
      )
    ));
  }

  const al = $("#allow");
  al.replaceChildren();
  if (!g.allow.length) emptyItem(al, "None");
  for (const d of g.allow) {
    al.append(el("li", { className: "row", style: "justify-content:space-between" },
      el("span", { className: "k", textContent: d }),
      el("button", { className: "b", textContent: "Remove", onclick: () => act("guardAllow", { domain: d, allowed: false }, d + " is no longer trusted.") })
    ));
  }
}

$("#mode").addEventListener("change", async (e) => { await send("guardMode", { mode: e.target.value }); refresh(true); });
$("#do-allsites").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
  if (!ok) return say("Permission declined. The guard keeps watching only localhost and vault sites.");
  await send("scan");
  say("Now watching every site.", true);
  refresh(true);
});
$("#do-scan").addEventListener("click", async () => {
  const r = await send("scan");
  say(r.found ? `Found ${r.found} ad cookie${r.found === 1 ? "" : "s"}.` : "No ad cookies found.", true);
  refresh(true);
});
$("#do-clear").addEventListener("click", async () => { await send("clearDetections"); refresh(true); });

// ── Refresh loop ────────────────────────────────────────────────────────────
async function refresh(force) {
  S = await send("status");
  if (!S || S.error) return say(S && S.error ? S.error : "The extension didn't respond.");
  const json = JSON.stringify(S);
  if (!force && json === lastJSON) return;
  lastJSON = json;
  renderVault(); renderSite(); renderGuard();
}

(async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(t.url);
    page = /^https?:$/.test(u.protocol) ? u : null;
  } catch { page = null; }
  await refresh(true);
  setInterval(refresh, 2000);
})();
