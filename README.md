# TrackLab + Cookie Stash

Two parts:

- `site/index.html` is a demo page about browser tracking (cookie jar, ad-network profile, fingerprinting).
  It keeps a "where you left off" state in cookies: section, note, visit count, tag.
- `extension/` is a Chrome/Edge/Brave (Manifest V3) extension that only touches that page's cookies.

## Run it

1. Serve the site from port 8080 (cookies don't work on `file://`):

       cd site
       python3 -m http.server 8080

2. Open `chrome://extensions`, switch on Developer mode, click Load unpacked, pick the `extension` folder.
3. Open http://localhost:8080, scroll somewhere, type a note, close the tab, open the site again.

## What the extension does

- While the site is open, it keeps a copy of the site's cookies in extension storage.
- When the last site tab closes, or a site tab navigates to another origin, it removes the cookies from the browser. The copy stays in the stash.
- When you open the site and the jar is empty, it puts the stash back before the page loads.
- If the browser was closed while you were on the site, leftover cookies are cleaned up on next startup.
- The popup shows the jar and the stash side by side, with an Auto switch and manual buttons for testing.

## Guard rails

- Only the exact origin `http://localhost:8080` is used. If you change the port, edit `SITE_ORIGIN` and the `ports` value in the `webNavigation` filter in `background.js`.
- Only cookies whose names start with `tl_` are touched. Cookies aren't scoped by port, so every app on `localhost` shares one jar; the prefix keeps yours out of this.
- An empty jar never overwrites the stash, and the stash is only restored into an empty jar.
- The `tabs` permission is used only to compare a tab's origin against the site's. Nothing else about your tabs is read or stored.

## Known limits

- Switching to another tab is not "leaving". Closing or navigating away is.
- The stash is plain text in extension storage. Fine for these demo cookies; do not point it at real login sessions until the vault note below is done.
- Chromium browsers only as written. Firefox needs a `background.scripts` entry instead of a service worker.

## Sticky notes (parked, not built)

> Just in case something happens, add a native, encrypted version of Session Isolation (or a local "Cookie Vault"),
> and a Whitelist (Allowlist) feature: add whitelist logic to the background script, give the user a toggle button
> in the popup UI, and connect the UI to storage in `popup.js`, for testing.

Already in place toward that: the Auto switch in the popup is wired to storage (`popup.js` to `background.js`), and the site check in `background.js` is a single `isSite()` function, which is where an allowlist would plug in.
