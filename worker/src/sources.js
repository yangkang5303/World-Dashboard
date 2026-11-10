// Source-country attribution and junk filtering for the GDELT web feed.
//
// The feed carries only url / title / lang, so the publishing country is
// inferred, most reliable signal first:
//   1. a known outlet on a generic TLD (nytimes.com -> US),
//   2. the country-code TLD (.de -> DE, .uk -> GB),
//   3. a language spoken mainly in one country (ja -> JP).
// Articles none of these place are dropped: they cannot be shown on the map.
import { resolveCountry } from "./countries.js";

// Outlets on .com/.net/.org/... whose TLD says nothing about their home.
const OUTLETS = {
  US: [
    "nytimes.com", "washingtonpost.com", "cnn.com", "foxnews.com", "nbcnews.com", "cbsnews.com",
    "abcnews.go.com", "apnews.com", "usatoday.com", "wsj.com", "bloomberg.com", "npr.org", "politico.com",
    "thehill.com", "axios.com", "nypost.com", "latimes.com", "chicagotribune.com", "cnbc.com", "forbes.com",
    "businessinsider.com", "huffpost.com", "newsweek.com", "time.com", "theatlantic.com", "vox.com",
    "bleacherreport.com", "espn.com", "voanews.com", "rferl.org", "foxbusiness.com", "nbcmiami.com",
  ],
  GB: ["bbc.com", "theguardian.com", "reuters.com", "ft.com", "economist.com", "independent.co.uk"],
  QA: ["aljazeera.com", "aljazeera.net"],
  FR: ["france24.com"],
  DE: ["dw.com"],
  CN: [
    "globaltimes.cn", "xinhuanet.com", "news.cn", "cgtn.com", "163.com", "sohu.com", "qq.com", "ifeng.com",
    "sina.com", "chinanews.com", "huanqiu.com", "eastmoney.com", "caixin.com",
  ],
  HK: ["scmp.com", "rthk.hk"],
  TW: ["taipeitimes.com", "ltn.com.tw", "udn.com"],
  JP: ["sankei.com", "asahi.com", "nikkei.com", "japantimes.co.jp", "nhk.or.jp", "kyodonews.net"],
  KR: ["koreaherald.com", "chosun.com", "donga.com", "hankyung.com", "koreajoongangdaily.joins.com"],
  IN: [
    "indiatimes.com", "hindustantimes.com", "ndtv.com", "thehindu.com", "thehindubusinessline.com",
    "indianexpress.com", "news18.com", "livemint.com", "deccanherald.com", "business-standard.com",
  ],
  PK: ["dawn.com", "geo.tv", "thenews.com.pk"],
  SG: ["straitstimes.com", "channelnewsasia.com", "todayonline.com"],
  MY: ["malaymail.com", "freemalaysiatoday.com"],
  PH: ["inquirer.net", "rappler.com", "philstar.com", "gmanetwork.com", "manilatimes.net"],
  ID: ["antaranews.com", "kompas.com", "detik.com", "tempo.co", "jakartaglobe.id", "okezone.com"],
  VN: ["vnexpress.net", "vietnamnet.vn"],
  TH: ["bangkokpost.com", "nationthailand.com"],
  RU: ["rt.com", "tass.com", "themoscowtimes.com"],
  UA: ["kyivindependent.com", "ukrinform.net", "pravda.com.ua"],
  IL: ["timesofisrael.com", "jpost.com", "haaretz.com", "ynetnews.com"],
  TR: ["dailysabah.com", "hurriyetdailynews.com", "aa.com.tr"],
  AE: ["thenationalnews.com", "gulfnews.com", "khaleejtimes.com"],
  SA: ["arabnews.com", "saudigazette.com.sa"],
  IR: ["tehrantimes.com", "presstv.ir"],
  NG: ["punchng.com", "vanguardngr.com", "premiumtimesng.com", "thisdaylive.com", "guardian.ng"],
  KE: ["nation.africa", "the-star.co.ke"],
  ZA: ["news24.com", "dailymaverick.co.za"],
  BR: ["globo.com", "uol.com.br"],
  AR: ["infobae.com", "clarin.com", "lanacion.com.ar"],
  MX: ["milenio.com", "eluniversal.com.mx", "jornada.com.mx"],
  ES: ["elpais.com", "elmundo.es", "abc.es"],
  CA: ["cbc.ca", "theglobeandmail.com", "nationalpost.com"],
  AU: ["abc.net.au", "smh.com.au"],
};

const OUTLET_COUNTRY = new Map();
for (const [iso2, domains] of Object.entries(OUTLETS)) {
  for (const domain of domains) OUTLET_COUNTRY.set(domain, iso2);
}

// ccTLDs sold as generic names (.tv, .io, .co, ...) — not a location signal.
const GENERIC_CCTLDS = new Set([
  "ac", "ad", "ag", "ai", "am", "cc", "cd", "co", "fm", "gg", "im", "io", "la", "ly", "me", "ms",
  "nu", "sh", "so", "st", "tk", "to", "tv", "vc", "ws",
]);
const TLD_ALIASES = { uk: "GB", su: "RU" };

// Languages published overwhelmingly from one country. English, Spanish,
// French, Arabic, Portuguese etc. are deliberately absent.
const LANGUAGE_COUNTRY = {
  zh: "CN", ja: "JP", ko: "KR", vi: "VN", th: "TH", tr: "TR", pl: "PL", uk: "UA", el: "GR", cs: "CZ",
  hu: "HU", ro: "RO", he: "IL", iw: "IL", fa: "IR", id: "ID", ms: "MY", bn: "BD", it: "IT", nl: "NL",
  sv: "SE", fi: "FI", da: "DK", no: "NO", nb: "NO", bg: "BG", hr: "HR", sr: "RS", sk: "SK", sl: "SI",
  lt: "LT", lv: "LV", et: "EE", hy: "AM", ka: "GE", az: "AZ", kk: "KZ", uz: "UZ", mn: "MN", km: "KH",
  lo: "LA", my: "MM", si: "LK", ne: "NP", hi: "IN", mr: "IN", ur: "PK", am: "ET", ru: "RU", de: "DE",
  // A region subtag beats the bare language.
  "zh-tw": "TW", "zh-hk": "HK", "zh-mo": "MO", "pt-br": "BR", "pt-pt": "PT", "es-mx": "MX", "fr-ca": "CA",
};

/** Hostname without a leading www., or null for anything that is not http(s). */
export function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} host  bare hostname, e.g. "edition.cnn.com"
 * @param {string | null | undefined} lang  ISO 639-1 code from the feed
 * @returns {import("./countries.js").Country | null}
 */
export function sourceCountry(host, lang) {
  // Try every parent domain: edition.cnn.com -> cnn.com.
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    const iso2 = OUTLET_COUNTRY.get(labels.slice(i).join("."));
    if (iso2) return resolveCountry(iso2);
  }

  const tld = labels[labels.length - 1];
  if (TLD_ALIASES[tld]) return resolveCountry(TLD_ALIASES[tld]);
  if (tld.length === 2 && !GENERIC_CCTLDS.has(tld)) {
    const country = resolveCountry(tld);
    if (country) return country;
  }

  const language = typeof lang === "string" ? lang.toLowerCase().replace("_", "-") : "";
  const iso2 = LANGUAGE_COUNTRY[language] ?? LANGUAGE_COUNTRY[language.split("-")[0]];
  return iso2 ? resolveCountry(iso2) : null;
}

const NON_ARTICLE_PATH =
  /\/(tags?|category|categories|topics?|authors?|people|profile|music|songs?|downloads?|search|shop|products?|catalog|objects?|listings?|login|register|jobs?|weather|horoscopes?|obituaries)(\/|$)/i;
const NON_ARTICLE_TITLE = /(下载|官方版|手机版|免费版|直降|优惠券)/;

/**
 * Cheap "is this a news story?" test. The feed is every page GDELT crawled,
 * including section fronts, author pages, app stores and shop listings.
 */
export function isLikelyArticle(url, title) {
  if (!title || title.length < 12 || NON_ARTICLE_TITLE.test(title)) return false;
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (NON_ARTICLE_PATH.test(path)) return false;
  // Story URLs carry an id or date, or a long slug.
  return /\d{4,}/.test(path) || /[a-z0-9]+(?:[-_][a-z0-9]+){3,}/i.test(path);
}
