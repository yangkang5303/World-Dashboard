// World Dashboard — Cloudflare Worker.
// Serves the JSON API under /api/* and hands everything else to static assets.
import { SwrCache } from "./cache.js";
import { resolveCountry, sourceCountryClause } from "./countries.js";
import { fetchArticles, formatArticles, GdeltError } from "./gdelt.js";

const DEFAULT_GLOBAL_QUERY =
  "(theme:ARMEDCONFLICT OR theme:POLITICS OR theme:SECURITY " +
  "OR theme:ECONOMY OR theme:GOVERNMENT OR theme:TERROR)";

// Always ask GDELT for the same page size and slice per request, so that
// ?max_records=20 and ?max_records=50 share one cache entry.
const UPSTREAM_RECORDS = 100;
const MAX_QUERY_LENGTH = 400;
const TIMESPAN_PATTERN = /^\d{1,4}(min|h|d|w|m)$/i;

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
  return {
    globalQuery: (env.GDELT_GLOBAL_QUERY || DEFAULT_GLOBAL_QUERY).trim(),
    timespan: (env.GDELT_TIMESPAN || "1d").trim(),
    translation: env.GDELT_TRANSLATION ?? "googtrans",
    docUrl: env.GDELT_DOC_URL || undefined,
    ttlMs: seconds(env.CACHE_TTL_SECONDS, 600) * 1000,
    staleMs: seconds(env.CACHE_STALE_SECONDS, 86_400) * 1000,
    corsOrigins: String(env.CORS_ALLOW_ORIGINS || "*")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

function parseMaxRecords(url, fallback) {
  const raw = url.searchParams.get("max_records");
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > UPSTREAM_RECORDS) {
    throw new HttpError(400, `max_records must be an integer between 1 and ${UPSTREAM_RECORDS}`);
  }
  return value;
}

function parseTimespan(url, fallback) {
  const raw = (url.searchParams.get("timespan") || fallback).trim();
  if (!TIMESPAN_PATTERN.test(raw)) {
    throw new HttpError(400, "timespan must look like 12h, 1d or 2w");
  }
  return raw.toLowerCase();
}

const parenthesised = (query) => (query.startsWith("(") && query.endsWith(")") ? query : `(${query})`);

async function loadGlobal(config, query, timespan, deps) {
  const raw = await fetchArticles(config, { query, timespan, maxRecords: UPSTREAM_RECORDS }, deps);
  return { query, articles: formatArticles(raw) };
}

async function loadCountry(config, country, timespan, deps) {
  const clause = sourceCountryClause(country);
  // Prefer the curated topics; fall back to everything published in the country.
  const candidates = config.globalQuery ? [`${clause} AND ${parenthesised(config.globalQuery)}`, clause] : [clause];

  let lastError;
  let answered = false;
  let query = candidates[0];
  for (const candidate of candidates) {
    try {
      const raw = await fetchArticles(config, { query: candidate, timespan, maxRecords: UPSTREAM_RECORDS }, deps);
      answered = true;
      query = candidate;
      const articles = formatArticles(raw);
      if (articles.length) return { query, articles };
    } catch (error) {
      // A rejected query (e.g. "too common") may still work in its simpler
      // form; an outage or rate limit will not, so stop hammering.
      if (!(error instanceof GdeltError) || error.kind !== "query") throw error;
      lastError = error;
    }
  }
  if (!answered && lastError) throw lastError;
  return { query, articles: [] };
}

async function handleApi(request, env, ctx, url, deps) {
  const config = readConfig(env);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health" || path === "/health") {
    return { body: { status: "ok" }, cacheControl: "no-store" };
  }

  const policy = { ttlMs: config.ttlMs, staleMs: config.staleMs };

  if (path === "/api/global") {
    const maxRecords = parseMaxRecords(url, 20);
    const timespan = parseTimespan(url, config.timespan);
    const query = (url.searchParams.get("query") || config.globalQuery).trim();
    if (!query || query.length > MAX_QUERY_LENGTH) {
      throw new HttpError(400, `query must be between 1 and ${MAX_QUERY_LENGTH} characters`);
    }
    const result = await cache.get(
      `global|${timespan}|${query}`,
      policy,
      () => loadGlobal(config, query, timespan, deps),
      ctx,
    );
    return { result, maxRecords };
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
    const timespan = parseTimespan(url, config.timespan);
    const result = await cache.get(
      `country|${country.iso2}|${timespan}`,
      policy,
      () => loadCountry(config, country, timespan, deps),
      ctx,
    );
    return { result, maxRecords, extra: { country: { iso2: country.iso2, name: country.name } } };
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
  if (error instanceof GdeltError) {
    const rateLimited = error.kind === "rate-limit";
    return json({ detail: `GDELT request failed: ${error.message}` }, rateLimited ? 503 : 502, {
      ...cors,
      "cache-control": "no-store",
      ...(rateLimited ? { "retry-after": "10" } : {}),
    });
  }
  console.error("Unhandled error", error);
  return json({ detail: "Internal error" }, 500, { ...cors, "cache-control": "no-store" });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps] test seams
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

    const { result, maxRecords, extra } = outcome;
    const articles = result.value.articles.slice(0, maxRecords);
    const { storedAt } = result;
    const etag = `W/"${storedAt.toString(36)}-${articles.length}"`;
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
    return json(
      {
        query: result.value.query,
        ...extra,
        count: articles.length,
        updated_at: new Date(storedAt).toISOString(),
        articles,
      },
      200,
      headers,
    );
  } catch (error) {
    return errorResponse(error, cors);
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
