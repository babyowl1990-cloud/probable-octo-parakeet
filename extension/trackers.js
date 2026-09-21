// Advertising-only tracker classification.
//
// Deliberately NOT flagged: analytics (_ga, Hotjar, Mixpanel...), session and login cookies,
// consent cookies, CDN and payment cookies. This is a small hand-picked list, not a full blocklist
// like EasyList or Disconnect, so it will miss trackers it doesn't know about.

// Ad-network domains: any cookie set by one of these (or a subdomain) is an advertising cookie.
const AD_DOMAINS = {
  "doubleclick.net": "Google Ads (DoubleClick)",
  "googlesyndication.com": "Google AdSense",
  "googleadservices.com": "Google Ads",
  "2mdn.net": "Google Campaign Manager",
  "adnxs.com": "Xandr (Microsoft Advertising)",
  "criteo.com": "Criteo",
  "criteo.net": "Criteo",
  "rubiconproject.com": "Magnite",
  "pubmatic.com": "PubMatic",
  "openx.net": "OpenX",
  "casalemedia.com": "Index Exchange",
  "adsrvr.org": "The Trade Desk",
  "taboola.com": "Taboola",
  "outbrain.com": "Outbrain",
  "amazon-adsystem.com": "Amazon Ads",
  "bidswitch.net": "BidSwitch",
  "smartadserver.com": "Smart AdServer",
  "adform.net": "Adform",
  "33across.com": "33Across",
  "sharethrough.com": "Sharethrough",
  "teads.tv": "Teads",
  "mathtag.com": "MediaMath",
  "agkn.com": "Neustar AdAdvisor",
  "demdex.net": "Adobe Audience Manager",
  "krxd.net": "Salesforce Audience Studio",
  "bluekai.com": "Oracle Advertising",
  "rlcdn.com": "LiveRamp",
  "tapad.com": "Tapad",
  "lijit.com": "Sovrn",
  "adroll.com": "AdRoll",
  "serving-sys.com": "Sizmek",
  "media.net": "Media.net",
  "yieldmo.com": "Yieldmo",
  "contextweb.com": "PulsePoint",
};

// Ad-pixel cookies that sit on the visited site's own domain, recognised by name.
const AD_NAMES = [
  [/^_fbp$|^_fbc$/, "Meta Pixel"],
  [/^_gcl_(au|aw|dc|gb|ha)$/, "Google Ads conversion linker"],
  [/^__gads$|^__gpi$|^__eoi$/, "Google AdSense"],
  [/^_uet(sid|vid)$/, "Microsoft Advertising (UET)"],
  [/^_ttp$|^_tt_enable_cookie$/, "TikTok Pixel"],
  [/^_pin_unauth$/, "Pinterest Tag"],
  [/^_rdt_uuid$/, "Reddit Pixel"],
  [/^_scid$|^_sctr$/, "Snap Pixel"],
  [/^li_fat_id$/, "LinkedIn Insight Tag"],
  [/^cto_(bundle|bidid)$/, "Criteo"],
  [/^tl_trk$/, "TrackLab demo ad network (test cookie)"],
];

// Cookie names that are advertising-only on a specific host.
const AD_HOST_NAMES = [
  ["facebook.com", /^fr$/, "Meta Ads"],
  ["linkedin.com", /^(UserMatchHistory|AnalyticsSyncHistory|lms_ads)$/, "LinkedIn Ads"],
  ["twitter.com", /^(personalization_id|muc_ads)$/, "X Ads"],
  ["x.com", /^(personalization_id|muc_ads)$/, "X Ads"],
];

const hostMatches = (host, d) => host === d || host.endsWith("." + d);

// Returns { vendor, why } for an advertising cookie, or null for anything else.
function classifyCookie(c) {
  const host = c.domain.replace(/^\./, "").toLowerCase();
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const vendor = AD_DOMAINS[labels.slice(i).join(".")];
    if (vendor) return { vendor, why: "ad network domain" };
  }
  for (const [h, re, vendor] of AD_HOST_NAMES) {
    if (hostMatches(host, h) && re.test(c.name)) return { vendor, why: "known ad cookie" };
  }
  for (const [re, vendor] of AD_NAMES) {
    if (re.test(c.name)) return { vendor, why: "known ad cookie name" };
  }
  return null;
}
