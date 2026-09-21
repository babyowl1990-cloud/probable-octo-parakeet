const $ = (s) => document.querySelector(s);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

function fill(ul, items, emptyText) {
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    ul.append(li);
    return;
  }
  for (const c of items) {
    const li = document.createElement("li");
    const a = document.createElement("span");
    const b = document.createElement("span");
    a.textContent = c.name;
    b.textContent = decodeURIComponent(c.value);
    b.title = b.textContent;
    li.append(a, b);
    ul.append(li);
  }
}

async function render() {
  const s = await send("status");
  $("#enabled").checked = s.enabled;
  $("#tabs").textContent = s.siteTabs;
  $("#saved").textContent = s.savedAt ? new Date(s.savedAt).toLocaleTimeString() : "–";
  fill($("#jar"), s.jar, "Empty");
  fill($("#stash"), s.stash, "Nothing stashed yet");
}

$("#enabled").addEventListener("change", async (e) => { await send("toggle", { enabled: e.target.checked }); render(); });
$("#restore").addEventListener("click", async () => { await send("restore"); render(); });
$("#wipe").addEventListener("click", async () => { await send("wipe"); render(); });
$("#clear").addEventListener("click", async () => { await send("clearStash"); render(); });

$("#site").textContent = CONFIG.origin + CONFIG.path;
render();
setInterval(render, 1500);
