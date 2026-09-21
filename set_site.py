#!/usr/bin/env python3
"""Point the extension at a different site.

  python3 set_site.py http://localhost:8080 /
  python3 set_site.py https://alice.github.io /tracklab/

Updates extension/config.js and host_permissions in extension/manifest.json.
Then click the reload arrow for the extension on chrome://extensions.
"""
import json, sys
from urllib.parse import urlparse

if len(sys.argv) != 3:
    sys.exit(__doc__)
origin, path = sys.argv[1].rstrip("/"), sys.argv[2]
u = urlparse(origin)
if u.scheme not in ("http", "https") or not u.hostname or u.path:
    sys.exit("origin must look like https://alice.github.io (no path)")
if not (path.startswith("/") and path.endswith("/")):
    sys.exit("path must start and end with /, e.g. /tracklab/")

open("extension/config.js", "w").write(f'''// Which site this extension serves. Change it with:  python3 set_site.py <origin> <path>
// (that also updates host_permissions in manifest.json, which must match).
const CONFIG = {{
  origin: "{origin}",
  path: "{path}",
}};
''')
m = json.load(open("extension/manifest.json"))
m["host_permissions"] = [f"{u.scheme}://{u.hostname}/*"]
json.dump(m, open("extension/manifest.json", "w"), indent=2)
open("extension/manifest.json", "a").write("\n")
print("Now serving:", origin + path)
