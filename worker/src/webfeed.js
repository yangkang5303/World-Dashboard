// GDELT web feed (gdeltv5/weblegacy), which GDELT asks clients to use instead
// of the DOC search API while that API moves to new infrastructure:
// https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/
//
// For some minutes GDELT publishes a gzipped table of contents of the pages it
// crawled, one JSON object per line:
//   {base}/YYYYMMDDHHMM00.toc.json.gz
//   {"ID":1,"date":"2026-11-10T06:47:00.000Z","img":"…","lang":"en","title":"…","url":"…"}
// Files cluster around a 15-minute heartbeat; most minutes have none (404).
//
// The scheduled run walks forward from a cursor, folds each file into a
// rolling per-country store in KV, and precomputes the global list. Visitors
// only ever read KV.
import { hostOf, isLikelyArticle, sourceCountry } from "./sources.js";

export const DEFAULT_FEED_URL = "https://data.gdeltproject.org/gdeltv5/weblegacy/ngrams";
export const FEED_KEYS = { global: "feed:v1:global", countries: "feed:v1:countries" };
export const PER_COUNTRY = 50;
export const GLOBAL_SIZE = 100;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A minute's file is released about two minutes later; leave some slack.
const PUBLISH_LAG_MS = 4 * MINUTE;
// Per run: probes are cheap 404s, but each file is ~1 MB of JSON to parse.
const MAX_PROBES = 30;
// How far back an empty store, or one left behind by an outage, starts:
// one run's worth of probes, so the first run reaches the present.
const BACKFILL_MS = (MAX_PROBES - 1) * MINUTE;
const MAX_FILES = 2;
const FETCH_TIMEOUT_MS = 15_000;

export class FeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedError";
  }
}

/** 2026-11-10T06:47:xx -> "20261110064700" */
export function stampOf(ms) {
  return new Date(ms).toISOString().replace(/\D/g, "").slice(0, 12) + "00";
}

export function parseStamp(stamp) {
  const [y, mo, d, h, mi] = [0, 4, 6, 8, 10].map((at, i) => Number(stamp.slice(at, at + (i ? 2 : 4))));
  return Date.UTC(y, mo - 1, d, h, mi);
}

const floorMinute = (ms) => ms - (ms % MINUTE);
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);

/**
 * Fetch one minute's table of contents.
 * @returns {Promise<string | null>} decompressed NDJSON, or null if GDELT has no file for that minute
 */
export async function fetchToc(baseUrl, stamp, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/${stamp}.toc.json.gz`, {
      headers: { "user-agent": "world-dashboard-worker/2.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeedError(`GDELT feed unreachable: ${error?.message || error}`);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeedError(`GDELT feed responded with HTTP ${response.status}`);
  }
  // Served as a plain .gz object (no Content-Encoding), so inflate it here.
  try {
    return await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
  } catch (error) {
    throw new FeedError(`GDELT feed file is corrupt: ${error?.message || error}`);
  }
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null);

/** NDJSON table of contents -> API articles that look like news and can be placed on the map. */
export function parseToc(ndjson) {
  const articles = [];
  for (const line of ndjson.split("\n")) {
    if (!line) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const url = text(raw?.url);
    const title = text(raw?.title);
    const host = url && hostOf(url);
    if (!host || !isLikelyArticle(url, title)) continue;
    const country = sourceCountry(host, raw.lang);
    if (!country) continue;
    articles.push({
      id: url,
      title,
      url,
      time: text(raw.date),
      source: host,
      source_country: country.iso2,
      language: text(raw.lang),
      image: /^https?:\/\//i.test(raw.img || "") ? raw.img : null,
      countries: [{ iso2: country.iso2, name: country.name }],
    });
  }
  return articles;
}

const titleKey = (article) => article.title.toLowerCase();
const timeOf = (article) => Date.parse(article.time) || 0;

/**
 * Fold freshly parsed articles into the stored state.
 * @param {{ countries: Record<string, object[]>, hourly: Record<string, Record<string, number>> }} state
 * @returns the new state (inputs are not mutated)
 */
export function mergeArticles(state, fresh, now, windowMs) {
  const cutoff = now - windowMs;
  const countries = {};
  const hourly = {};
  for (const [hour, counts] of Object.entries(state.hourly)) {
    // Keep an hour bucket while any part of it is inside the window.
    if (Date.parse(`${hour}:00:00Z`) + HOUR > cutoff) hourly[hour] = { ...counts };
  }

  const byCountry = new Map();
  for (const article of fresh) {
    if (!byCountry.has(article.source_country)) byCountry.set(article.source_country, []);
    byCountry.get(article.source_country).push(article);
  }

  for (const iso2 of new Set([...Object.keys(state.countries), ...byCountry.keys()])) {
    const kept = (state.countries[iso2] || []).filter((article) => timeOf(article) > cutoff);
    const seenUrls = new Set(kept.map((article) => article.url));
    const seenTitles = new Set(kept.map(titleKey));
    for (const article of byCountry.get(iso2) || []) {
      const time = timeOf(article);
      // The same wire story is syndicated across many outlets; keep the first.
      if (time <= cutoff || seenUrls.has(article.url) || seenTitles.has(titleKey(article))) continue;
      seenUrls.add(article.url);
      seenTitles.add(titleKey(article));
      kept.push(article);
      const bucket = (hourly[hourKey(time)] ||= {});
      bucket[iso2] = (bucket[iso2] || 0) + 1;
    }
    if (kept.length) countries[iso2] = kept.sort((a, b) => timeOf(b) - timeOf(a)).slice(0, PER_COUNTRY);
  }
  return { countries, hourly };
}

/** Articles per country over the stored window. */
export function countryVolumes(hourly) {
  const totals = {};
  for (const counts of Object.values(hourly)) {
    for (const [iso2, n] of Object.entries(counts)) totals[iso2] = (totals[iso2] || 0) + n;
  }
  return totals;
}

/**
 * Global "hot" list: seats are shared out between countries in proportion to
 * how much they published (D'Hondt), so the map's heat follows real volume,
 * and each country contributes its newest stories first.
 */
export function pickGlobal(countries, volumes, size = GLOBAL_SIZE) {
  const queues = Object.entries(countries)
    .filter(([iso2, list]) => list.length && volumes[iso2])
    .map(([iso2, list]) => ({ weight: volumes[iso2], list, taken: 0 }));
  const picked = [];
  const seenTitles = new Set();
  while (picked.length < size && queues.length) {
    let best = 0;
    for (let i = 1; i < queues.length; i += 1) {
      const q = queues[i];
      if (q.weight / (q.taken + 1) > queues[best].weight / (queues[best].taken + 1)) best = i;
    }
    const queue = queues[best];
    const article = queue.list[queue.taken];
    queue.taken += 1;
    if (queue.taken >= queue.list.length) queues.splice(best, 1);
    if (seenTitles.has(titleKey(article))) continue;
    seenTitles.add(titleKey(article));
    picked.push(article);
  }
  return picked;
}

/**
 * Advance the cursor over newly published files and persist the result.
 * @param {{ kv: KVNamespace, baseUrl?: string, windowMs: number, fetchImpl?: typeof fetch, now?: () => number }} options
 * @returns {Promise<{ global: object, countries: object, files: number }>}
 */
export async function ingest({ kv, baseUrl = DEFAULT_FEED_URL, windowMs, fetchImpl = fetch, now = Date.now }) {
  const [globalDoc, countriesDoc] = await Promise.all([
    kv.get(FEED_KEYS.global, "json"),
    kv.get(FEED_KEYS.countries, "json"),
  ]);
  const latest = floorMinute(now() - PUBLISH_LAG_MS);
  const earliest = latest - BACKFILL_MS;
  let next = globalDoc?.cursor ? Math.max(parseStamp(globalDoc.cursor) + MINUTE, earliest) : earliest;
  let cursor = next - MINUTE;

  const files = [];
  let failure = null;
  for (let probes = 0; next <= latest && probes < MAX_PROBES && files.length < MAX_FILES; probes += 1) {
    try {
      const ndjson = await fetchToc(baseUrl, stampOf(next), fetchImpl);
      if (ndjson !== null) files.push(ndjson);
    } catch (error) {
      // Keep what was gathered; the next run resumes from this minute.
      failure = error;
      break;
    }
    cursor = next;
    next += MINUTE;
  }
  if (failure && !files.length) throw failure;

  const fresh = files.flatMap(parseToc);
  const state = mergeArticles(
    { countries: countriesDoc?.countries || {}, hourly: globalDoc?.hourly || {} },
    fresh,
    now(),
    windowMs,
  );
  const updatedAt = files.length || !globalDoc ? new Date(now()).toISOString() : globalDoc.updated_at;
  const volumes = countryVolumes(state.hourly);
  const nextGlobal = {
    cursor: stampOf(cursor),
    updated_at: updatedAt,
    hourly: state.hourly,
    volumes,
    articles: files.length || !globalDoc ? pickGlobal(state.countries, volumes) : globalDoc.articles,
  };
  const nextCountries = files.length || !countriesDoc ? { updated_at: updatedAt, countries: state.countries } : countriesDoc;

  // KV allows ~1 write/s per key and (on the free plan) 1000 writes a day:
  // the small global doc is written every run, the large one only on change.
  const writes = [kv.put(FEED_KEYS.global, JSON.stringify(nextGlobal))];
  if (nextCountries !== countriesDoc) writes.push(kv.put(FEED_KEYS.countries, JSON.stringify(nextCountries)));
  await Promise.all(writes);
  return { global: nextGlobal, countries: nextCountries, files: files.length };
}
