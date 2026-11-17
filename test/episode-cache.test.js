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

const MIN = 60_000;
const NOW = 1_800_000_000_000;

test("isProbeDue follows the API probe rule: every 15 min normally", () => {
  assert.equal(episodeCache.isProbeDue(undefined, NOW), true);
  assert.equal(episodeCache.isProbeDue({ lastProbeAt: NOW - 14 * MIN }, NOW), false);
  assert.equal(episodeCache.isProbeDue({ lastProbeAt: NOW - 15 * MIN }, NOW), true);
});

test("isProbeDue drops to 5 min from 10 min before an episode airs until 6 h after", () => {
  const state = (airInMin) => ({ lastProbeAt: NOW - 6 * MIN, nextAiringAt: (NOW + airInMin * MIN) / 1000 });
  assert.equal(episodeCache.isProbeDue(state(9), NOW), true);
  assert.equal(episodeCache.isProbeDue(state(11), NOW), false);
  assert.equal(episodeCache.isProbeDue(state(-359), NOW), true);
  assert.equal(episodeCache.isProbeDue(state(-361), NOW), false);
});
