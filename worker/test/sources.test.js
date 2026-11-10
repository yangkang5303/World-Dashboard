import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyArticle, sourceCountry } from "../src/sources.js";

const iso = (host, lang) => sourceCountry(host, lang)?.iso2 ?? null;

test("known outlets win over their generic TLD, including subdomains", () => {
  assert.equal(iso("nytimes.com", "en"), "US");
  assert.equal(iso("edition.cnn.com", "en"), "US");
  assert.equal(iso("bbc.com", "en"), "GB");
  assert.equal(iso("news.163.com", "zh"), "CN");
});

test("country-code TLDs map to ISO, with the usual exceptions", () => {
  assert.equal(iso("spiegel.de", "de"), "DE");
  assert.equal(iso("irishmirror.ie", "en"), "IE");
  assert.equal(iso("dailymail.co.uk", "en"), "GB");
  assert.equal(iso("thestar.com.my", "en"), "MY");
  assert.equal(iso("nzz.ch", "de"), "CH");
  // .tv and .io are sold as generic names, so fall through to language.
  assert.equal(iso("example.tv", "en"), null);
  assert.equal(iso("example.io", "ja"), "JP");
});

test("language only decides when it points at one country", () => {
  assert.equal(iso("example.com", "zh"), "CN");
  assert.equal(iso("example.com", "ko"), "KR");
  assert.equal(iso("n.yam.com", "zh-TW"), "TW");
  assert.equal(iso("example.com", "pt-BR"), "BR");
  assert.equal(iso("example.com", "en"), null);
  assert.equal(iso("example.com", "es"), null);
  assert.equal(iso("example.com", undefined), null);
});

test("section fronts, author pages and shop listings are not articles", () => {
  const story = "Warnings of infectious diseases after Venezuela quakes";
  assert.ok(isLikelyArticle("https://x.co.uk/news/26242139.warnings-infectious-diseases/", story));
  assert.ok(isLikelyArticle("https://x.com/2026/11/10/some-long-story-slug", story));
  assert.ok(!isLikelyArticle("https://x.com/news/", story));
  assert.ok(!isLikelyArticle("https://klrc.com/music/songs/e4439ff7e85c4a6b33b448fed69b321c", story));
  assert.ok(!isLikelyArticle("https://kvartiravmoskve.ru/Objects/17046/", "Стартовая площадка Квартал 34-35 корпус 27"));
  assert.ok(!isLikelyArticle("https://wmra.org/people/larry-kaplow-is-here-now", story));
  assert.ok(!isLikelyArticle("https://x.com/a/573592.html", "肉呆去广告官方版下载安装-手机版免费下载v0.4.1"));
  assert.ok(!isLikelyArticle("https://x.com/2026/11/10/story", "Short"));
});
