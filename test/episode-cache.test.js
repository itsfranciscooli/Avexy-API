import { test } from "node:test";
import assert from "node:assert/strict";
import * as episodeCache from "../core/episode-cache.js";

test("episode cache exposes an awaitable warmEpisodes alongside getEpisodesResponse", () => {
  assert.equal(typeof episodeCache.warmEpisodes, "function");
  assert.equal(typeof episodeCache.getEpisodesResponse, "function");
});

const DAY = 86_400_000;
const cachedEntry = (latest) => ({
  data: { anizone: { episodes: { sub: Array.from({ length: latest }, (_, i) => ({ number: i + 1 })) } } },
  cachedAt: Date.now() - DAY, refreshAfter: 15 * 60_000, expiresAt: Date.now() + 30 * DAY,
});

test("shouldRebuild never rebuilds when AniList media could not be fetched", () => {
  const anizip = { episodes: { 1: {}, 12: {} } };
  assert.equal(episodeCache.shouldRebuild(cachedEntry(12), null, anizip), false);
  assert.equal(episodeCache.shouldRebuild(cachedEntry(12), null, null), false);
});

test("shouldRebuild still rebuilds a releasing show that gained an episode", () => {
  const media = { status: "RELEASING", episodes: null, nextAiringEpisode: null };
  assert.equal(episodeCache.shouldRebuild(cachedEntry(5), media, { episodes: { 6: {} } }), true);
  assert.equal(episodeCache.shouldRebuild(cachedEntry(12), { ...media, status: "FINISHED" }, null), false);
});
