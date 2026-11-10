// Country identity handling.
//
// The public API speaks ISO 3166-1 alpha-2 only. GDELT speaks FIPS 10-4, and the
// two code sets collide badly (FIPS "CH" is China but ISO "CH" is Switzerland;
// FIPS "GB" is Gabon but ISO "GB" is the United Kingdom; ...). FIPS codes are
// therefore never accepted from clients — they are only produced here, right
// before a query is sent upstream.
import { COUNTRY_ROWS } from "./country-data.js";

/** @typedef {{ iso2: string, iso3: string, fips: string[], name: string }} Country */

/** @type {Map<string, Country>} */
const BY_ISO2 = new Map();
/** @type {Map<string, Country>} */
const BY_ISO3 = new Map();
/** @type {Map<string, Country>} */
const BY_NAME = new Map();

export function normalizeName(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

for (const [iso2, iso3, fips, name] of COUNTRY_ROWS) {
  const country = Object.freeze({ iso2, iso3, fips, name });
  BY_ISO2.set(iso2, country);
  if (iso3) BY_ISO3.set(iso3, country);
  // Primary names win over aliases of other countries.
  BY_NAME.set(normalizeName(name), country);
}
for (const [iso2, , , , aliases] of COUNTRY_ROWS) {
  for (const alias of aliases) {
    const key = normalizeName(alias);
    if (key && !BY_NAME.has(key)) BY_NAME.set(key, BY_ISO2.get(iso2));
  }
}

/**
 * Resolve a client-supplied identifier: ISO alpha-2, ISO alpha-3 or a name.
 * @param {string | null | undefined} value
 * @returns {Country | null}
 */
export function resolveCountry(value) {
  if (!value) return null;
  const text = String(value).replace(/\+/g, " ").trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper.length === 2 && BY_ISO2.has(upper)) return BY_ISO2.get(upper);
  if (upper.length === 3 && BY_ISO3.has(upper)) return BY_ISO3.get(upper);
  return BY_NAME.get(normalizeName(text)) ?? null;
}

/**
 * Resolve the `sourcecountry` field of a GDELT article, which is a country
 * name in GDELT's own spelling ("United States", "South Korea", ...).
 * @param {unknown} value
 * @returns {Country | null}
 */
export function resolveGdeltCountryName(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return BY_NAME.get(normalizeName(value)) ?? null;
}

/** GDELT `sourcecountry:` clause for a country (some have two FIPS codes). */
export function sourceCountryClause(country) {
  const parts = country.fips.map((code) => `sourcecountry:${code}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}
