# TrackLab + Cookie Stash (check in branch)

- keep in mind that this is a test project for cookies valt.

- `site/index.html`: a demo page about browser tracking (cookie jar, a fake ad network, fingerprinting).
  It keeps a "where you left off" state in cookies: section, note, visit count, tag.
- `extension/`: a Chrome/Edge/Brave (Manifest V3) extension with two independent modules.

## Run it

1. Serve the site (cookies don't work on `file://`):

       cd site
       python3 -m http.server 8080

2. `chrome://extensions`, Developer mode on, Load unpacked, pick the `extension` folder.
3. Open http://localhost:8080, click the extension icon, and create a vault passphrase on the Vault tab.
4. Scroll somewhere, type a note, close the tab, open the site again. You land where you left off.

Loading an older copy? Remove it and load the new folder; the storage format changed.

## Module 1: Cookie Vault (session isolation)

- Sites are on an allowlist. `http://localhost:8080` is built in. On any other page, use the **This site** tab to
  add it (Chrome asks for permission for that one site only).
- While a listed site is open, its cookies are copied into the vault. The vault is AES-256-GCM encrypted with a key
  derived from your passphrase (PBKDF2, 250,000 rounds). The passphrase is never stored; the derived key lives only in
  memory and is dropped when the browser closes or you press Lock.
- When you leave (last tab of that site closes, or the tab navigates elsewhere) the cookies are removed from the browser.
  When you come back to an empty jar they are put back before the page loads.
- **Locked vault means hands off.** If the vault is locked, nothing is removed and nothing is restored, so a locked
  vault can never lose a session. Unlocking tidies up whatever was left.
- Removing a site from the list puts its cookies back in the browser first.
- Forgetting the passphrase makes the vault unrecoverable. "Delete vault" starts over.

Scoping: the demo site only touches cookies named `tl_*` (every local app on `localhost` shares one cookie jar).
Other localhost apps can't be added. On `github.io`, a site is scoped to its repo folder (`/tracklab/`).

## Module 2: Ad guard (advertising trackers only)

- Modes: **Off**, **Alert** (badge plus one notification per ad company per browser session), **Block** (the cookie is
  deleted right after it is set).
- It flags only advertising: known ad-network domains (DoubleClick, Criteo, Taboola, The Trade Desk...) and known ad-pixel
  cookies (`_fbp`, `_gcl_au`, `_uetvid`, `_ttp`...). Analytics (`_ga`), logins, session and consent cookies are ignored.
- **Trusted domains** are never alerted on or blocked. Use the toggle on the This site tab, or "Trust this domain" on a detection.
- By default it watches `localhost` and sites in your vault. **Watch all sites** asks Chrome for broad cookie access; it is
  optional and you can decline.
- Test it: the demo page has a button that plants `_fbp`, and the fake ad network's `tl_trk` counts as an ad cookie.

## Honest limits

- The ad list is small and hand-picked, not a full blocklist like EasyList or Disconnect. It will miss trackers it doesn't know.
- Block mode deletes a cookie after the browser accepted it. The request that set it already went out; what you stop is the
  ID sticking around for next time.
- Switching to another tab is not "leaving". Closing or navigating away is.
- Real sites can reject restored cookies (expired server-side, tied to a device or IP), and being logged out while away is
  the point of the vault, not a bug.
- The extension reads tab URLs (`tabs`, `webNavigation`) only to compare them with your site list.
- Chromium browsers only as written. Firefox needs a `background.scripts` entry instead of a service worker.

## Try it on GitHub Pages

1. Create a public repo (say `tracklab`), upload `site/index.html` to its root, then Settings, Pages, deploy from `main`.
2. Open `https://YOUR-USERNAME.github.io/tracklab/`, click the extension icon, This site tab, tick
   "Keep this site's cookies in the encrypted vault". Approve the permission for that one site.
3. Run the same test: note, close the tab, reopen.
