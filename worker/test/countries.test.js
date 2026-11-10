import test from "node:test";
import assert from "node:assert/strict";
import { resolveCountry, resolveGdeltCountryName, sourceCountryClause } from "../src/countries.js";

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

test("ISO codes translate to the FIPS codes GDELT expects", () => {
  const clause = (id) => sourceCountryClause(resolveCountry(id));
  assert.equal(clause("CN"), "sourcecountry:CH");
  assert.equal(clause("CH"), "sourcecountry:SZ");
  assert.equal(clause("GB"), "sourcecountry:UK");
  assert.equal(clause("DE"), "sourcecountry:GM");
  assert.equal(clause("JP"), "sourcecountry:JA");
  assert.equal(clause("TR"), "sourcecountry:TU");
  assert.equal(clause("VN"), "sourcecountry:VM");
  assert.equal(clause("CD"), "sourcecountry:CG");
  assert.equal(clause("PS"), "(sourcecountry:WE OR sourcecountry:GZ)");
});

test("alpha-3 codes and names resolve", () => {
  assert.equal(resolveCountry("CHN").iso2, "CN");
  assert.equal(resolveCountry("United States of America").iso2, "US");
  assert.equal(resolveCountry("Côte d'Ivoire").iso2, "CI");
  assert.equal(resolveCountry("south+korea").iso2, "KR");
  assert.equal(resolveCountry("Atlantis"), null);
  assert.equal(resolveCountry(""), null);
});

test("GDELT source country names map back to ISO", () => {
  assert.equal(resolveGdeltCountryName("China").iso2, "CN");
  assert.equal(resolveGdeltCountryName("United Kingdom").iso2, "GB");
  assert.equal(resolveGdeltCountryName("South Korea").iso2, "KR");
  assert.equal(resolveGdeltCountryName("Russia").iso2, "RU");
  assert.equal(resolveGdeltCountryName(""), null);
  assert.equal(resolveGdeltCountryName(undefined), null);
});
