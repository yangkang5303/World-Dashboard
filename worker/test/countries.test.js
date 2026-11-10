import test from "node:test";
import assert from "node:assert/strict";
import { resolveCountry } from "../src/countries.js";

test("two-letter codes are always ISO, never FIPS", () => {
  // Each of these is a different country under FIPS 10-4.
  assert.equal(resolveCountry("CN").name, "China");
  assert.equal(resolveCountry("CH").name, "Switzerland");
  assert.equal(resolveCountry("GB").name, "United Kingdom");
  assert.equal(resolveCountry("AU").name, "Australia");
  assert.equal(resolveCountry("RS").name, "Serbia");
  assert.equal(resolveCountry("RU").name, "Russia");
  assert.equal(resolveCountry("cn").iso2, "CN");
});

test("alpha-3 codes and names resolve", () => {
  assert.equal(resolveCountry("CHN").iso2, "CN");
  assert.equal(resolveCountry("United States of America").iso2, "US");
  assert.equal(resolveCountry("Côte d'Ivoire").iso2, "CI");
  assert.equal(resolveCountry("south+korea").iso2, "KR");
  assert.equal(resolveCountry("Atlantis"), null);
  assert.equal(resolveCountry(""), null);
});
