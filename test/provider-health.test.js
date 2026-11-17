import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure, providerHealth, recordProviderFailure, recordProviderSuccess,
  resetProviderHealth, trackProvider, PROVIDERS,
} from "../core/provider-health.js";

beforeEach(() => resetProviderHealth());

test("classifies the failures seen in the deployment logs", () => {
  const cases = [
    ["AnimeDunya HTTP 403 fetching https://anime-dunya.com/en/play/16498/1", { kind: "blocked", httpStatus: 403 }],
    ["Senshi episodes 403 (MAL 64340)", { kind: "blocked", httpStatus: 403 }],
    ["HTTP 429 fetching https://example.com", { kind: "rateLimited", httpStatus: 429 }],
    ["HTTP 502 fetching https://www.animegg.org/x", { kind: "error", httpStatus: 502 }],
    ["HTTP 520 fetching https://www.animesaturn.cx/x", { kind: "error", httpStatus: 520 }],
    ["Embed fetch failed: 403", { kind: "blocked", httpStatus: 403 }],
    ["HTTP 404 fetching https://example.com/anime/x", { kind: "noMatch", httpStatus: 404 }],
    ["fetch failed", { kind: "error", httpStatus: null }],
    ["AnimeDunya connection error: connection reset", { kind: "error", httpStatus: null }],
    ["AniWaves match not confident for AniList 404", { kind: "noMatch", httpStatus: null }],
    ["Senshi: no match for MAL 403", { kind: "noMatch", httpStatus: null }],
  ];
  for (const [message, expected] of cases) {
    assert.deepEqual(classifyFailure(new Error(message)), expected, message);
  }
  assert.deepEqual(classifyFailure({ message: "boom", status: 403 }), { kind: "blocked", httpStatus: 403 });
});

test("AniList failures are not blamed on a provider", () => {
  assert.equal(classifyFailure(new Error("No data found for AniList ID 1")), null);
  assert.equal(classifyFailure(new Error("AniList HTTP 500")), null);
  recordProviderFailure("kaa", new Error("AniList HTTP 500"));
  assert.equal(providerHealth().sources.kaa.status, "not checked yet");
});

test("a blocked provider reads 'blocked (403) since ...'", () => {
  recordProviderFailure("animedunya", new Error("AnimeDunya HTTP 403 fetching https://anime-dunya.com/en/anime/1"));
  const { sources, summary } = providerHealth();
  const dunya = sources.animedunya;
  assert.equal(dunya.status, "blocked");
  assert.equal(dunya.httpStatus, 403);
  assert.match(dunya.summary, /^blocked \(403\) since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(dunya.lastError, /HTTP 403/);
  assert.equal(summary.blocked, 1);
  assert.equal(summary["not checked yet"], PROVIDERS.length - 1);
});

test("'since' only moves when the status changes", async () => {
  recordProviderFailure("senshi", new Error("Senshi episodes 403 (MAL 1)"));
  const first = providerHealth().sources.senshi.since;
  await new Promise((r) => setTimeout(r, 5));
  recordProviderFailure("senshi", new Error("Senshi episodes 403 (MAL 2)"));
  assert.equal(providerHealth().sources.senshi.since, first);

  await new Promise((r) => setTimeout(r, 5));
  recordProviderSuccess("senshi");
  const recovered = providerHealth().sources.senshi;
  assert.equal(recovered.status, "ok");
  assert.notEqual(recovered.since, first);
  assert.equal(recovered.lastError, null);
  assert.deepEqual(recovered.recent, { blocked: 2, ok: 1 });
});

test("a provider that never matches shows 'no matches' after 5 misses", () => {
  for (let i = 0; i < 4; i++) recordProviderFailure("mkissa", new Error("MKissa match not found"));
  assert.equal(providerHealth().sources.mkissa.status, "not checked yet");
  recordProviderFailure("mkissa", new Error("MKissa match not found"));
  assert.match(providerHealth().sources.mkissa.summary, /^no matches since /);
});

test("a show missing from a working site doesn't hide its ok status", () => {
  recordProviderSuccess("gogoanime");
  for (let i = 0; i < 10; i++) recordProviderFailure("gogoanime", new Error("Gogoanime match not found"));
  assert.equal(providerHealth().sources.gogoanime.status, "ok");
});

test("trackProvider records outcomes and rethrows", async () => {
  const ok = trackProvider("anizone", async () => [1]);
  assert.deepEqual(await ok(), [1]);
  assert.equal(providerHealth().sources.anizone.status, "ok");

  const blocked = trackProvider("anizone", async () => { throw new Error("HTTP 403 fetching https://anizone.to"); });
  await assert.rejects(blocked(), /HTTP 403/);
  assert.equal(providerHealth().sources.anizone.summary.startsWith("blocked (403)"), true);
});
