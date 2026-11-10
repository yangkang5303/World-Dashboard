// World Dashboard — Cloudflare Worker.
// Serves the JSON API under /api/* and hands everything else to static assets.
//
// News comes from GDELT's per-minute web feed (see webfeed.js). A cron run
// ingests it into KV; requests only read KV, through an in-memory/edge cache.
import { SwrCache } from "./cache.js";
import { resolveCountry } from "./countries.js";
import { DEFAULT_FEED_URL, FEED_KEYS, FeedError, GLOBAL_SIZE, ingest } from "./webfeed.js";

const MAX_RECORDS = GLOBAL_SIZE;
const TIMESPAN_PATTERN = /^(\d{1,4})(min|h|d|w)$/i;
const UNIT_MS = { min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// One cache per isolate; it outlives individual requests.
const cache = new SwrCache();

export class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function readConfig(env) {
  const seconds = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const window = parseSpan((env.FEED_WINDOW || "1d").trim()) ?? UNIT_MS.d;
  return {
    feedUrl: (env.GDELT_FEED_URL || DEFAULT_FEED_URL).replace(/\/+$/, ""),
    windowMs: window,
    ttlMs: seconds(env.CACHE_TTL_SECONDS, 60) * 1000,
    staleMs: seconds(env.CACHE_STALE_SECONDS, 86_400) * 1000,
    corsOrigins: String(env.CORS_ALLOW_ORIGINS || "*")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

function parseSpan(value) {
  const match = TIMESPAN_PATTERN.exec(value);
  return match ? Number(match[1]) * UNIT_MS[match[2].toLowerCase()] : null;
}

function parseMaxRecords(url, fallback) {
  const raw = url.searchParams.get("max_records");
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RECORDS) {
    throw new HttpError(400, `max_records must be an integer between 1 and ${MAX_RECORDS}`);
  }
  return value;
}

/** Optional ?timespan= narrows the stored window; it can never widen it. */
function parseTimespan(url) {
  const raw = url.searchParams.get("timespan");
  if (raw === null) return null;
  const span = parseSpan(raw.trim());
  if (!span) throw new HttpError(400, "timespan must look like 30min, 12h, 1d or 1w");
  return span;
}

// Concurrent cache misses on an empty store share one ingest run.
let ingesting = null;
function ingestOnce(config, env, deps) {
  ingesting ||= ingest({ kv: env.NEWS_KV, baseUrl: config.feedUrl, windowMs: config.windowMs, ...deps }).finally(
    () => (ingesting = null),
  );
  return ingesting;
}

/** Read one feed document from KV; an empty store is filled on the spot. */
async function loadDoc(which, config, env, deps) {
  if (!env.NEWS_KV) throw new HttpError(500, "NEWS_KV binding is not configured");
  const stored = await env.NEWS_KV.get(FEED_KEYS[which], "json");
  if (stored) return stored;
  return (await ingestOnce(config, env, deps))[which];
}

function readDoc(which, config, env, ctx, deps) {
  // KV is the source of truth, so the cache keeps no KV tier of its own.
  const policy = { ttlMs: config.ttlMs, staleMs: config.staleMs, kv: null };
  return cache.get(`${config.feedUrl}|${FEED_KEYS[which]}`, policy, () => loadDoc(which, config, env, deps), ctx);
}

async function handleApi(request, env, ctx, url, deps) {
  const config = readConfig(env);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health" || path === "/health") {
    return { body: { status: "ok" }, cacheControl: "no-store" };
  }

  if (path === "/api/global") {
    const maxRecords = parseMaxRecords(url, 20);
    const span = parseTimespan(url);
    const result = await readDoc("global", config, env, ctx, deps);
    return { result, articles: result.value.articles, maxRecords, span };
  }

  const countryMatch = /^\/api\/country\/([^/]+)$/.exec(path);
  if (countryMatch) {
    let identifier;
    try {
      identifier = decodeURIComponent(countryMatch[1]);
    } catch {
      throw new HttpError(400, "Malformed country identifier");
    }
    const country = resolveCountry(identifier);
    if (!country) throw new HttpError(400, `Unsupported country identifier: ${identifier.slice(0, 80)}`);
    const maxRecords = parseMaxRecords(url, 50);
    const span = parseTimespan(url);
    const result = await readDoc("countries", config, env, ctx, deps);
    return {
      result,
      articles: result.value.countries[country.iso2] || [],
      maxRecords,
      span,
      extra: { country: { iso2: country.iso2, name: country.name } },
    };
  }

  throw new HttpError(404, "Not found");
}

function corsHeaders(request, env) {
  const { corsOrigins } = readConfig(env);
  const origin = request.headers.get("origin");
  const headers = { "access-control-allow-methods": "GET, HEAD, OPTIONS", vary: "Origin" };
  if (corsOrigins.includes("*")) headers["access-control-allow-origin"] = "*";
  else if (origin && corsOrigins.includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  });
}

function errorResponse(error, cors) {
  if (error instanceof HttpError) {
    return json({ detail: error.detail }, error.status, { ...cors, "cache-control": "no-store" });
  }
  if (error instanceof FeedError) {
    return json({ detail: error.message }, 502, { ...cors, "cache-control": "no-store", "retry-after": "60" });
  }
  console.error("Unhandled error", error);
  return json({ detail: "Internal error" }, 500, { ...cors, "cache-control": "no-store" });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps] test seams
 */
export async function handleRequest(request, env, ctx, deps) {
  const url = new URL(request.url);
  const isApi = url.pathname === "/health" || url.pathname === "/api" || url.pathname.startsWith("/api/");

  if (!isApi) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }

  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "access-control-max-age": "86400" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ detail: "Method not allowed" }, 405, { ...cors, allow: "GET, HEAD, OPTIONS" });
  }

  const started = Date.now();
  try {
    const outcome = await handleApi(request, env, ctx, url, deps);
    if (!outcome.result) {
      return json(outcome.body, 200, { ...cors, "cache-control": outcome.cacheControl });
    }

    const { result, maxRecords, span, extra } = outcome;
    const now = deps?.now?.() ?? Date.now();
    const inSpan = span ? outcome.articles.filter((article) => Date.parse(article.time) > now - span) : outcome.articles;
    const articles = inSpan.slice(0, maxRecords);
    const updatedAt = result.value.updated_at;
    const etag = `W/"${Date.parse(updatedAt).toString(36)}-${articles.length}"`;
    const headers = {
      ...cors,
      etag,
      // Browsers may reuse a response for a minute and revalidate cheaply via ETag.
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      age: String(Math.floor(result.ageMs / 1000)),
      "x-cache": `${result.state}; tier=${result.tier}`,
      "server-timing": `app;dur=${Date.now() - started}`,
      "access-control-expose-headers": "X-Cache, Age, ETag",
    };

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return json({ ...extra, count: articles.length, updated_at: updatedAt, articles }, 200, headers);
  } catch (error) {
    return errorResponse(error, cors);
  }
}

/** Cron: pull newly published feed files into KV. */
export async function handleScheduled(env, ctx, deps) {
  const config = readConfig(env);
  try {
    const { files, global } = await ingestOnce(config, env, deps);
    console.log(`Feed ingest: ${files} file(s), cursor ${global.cursor}, ${global.articles.length} global articles`);
  } catch (error) {
    // Visitors keep getting the previous copy; the next run resumes from the cursor.
    console.warn("Feed ingest failed:", error?.message || error);
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  scheduled: (_controller, env, ctx) => handleScheduled(env, ctx),
};
