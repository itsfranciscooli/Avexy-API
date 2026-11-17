import {
  getAsync, setAsync, isFresh, needsRefresh,
  episodeTTL,
} from "./smartcache.js";
import { getEpisodes as mkissaEpisodesRaw } from "../providers/mkissa.js";
import { getEpisodes as reanimeEpisodesRaw } from "../providers/reanime.js";
import { getEpisodes as anikotoEpisodesRaw } from "../providers/anikoto.js";
import { getEpisodes as animeggEpisodesRaw } from "../providers/animegg.js";
import { getEpisodes as animenosubEpisodesRaw } from "../providers/animenosub.js";
import { getEpisodes as anizoneEpisodesRaw } from "../providers/anizone.js";
import { getEpisodes as aniwavesEpisodesRaw } from "../providers/aniwaves.js";
import { getEpisodes as senshiEpisodesRaw } from "../providers/senshi.js";
import { getEpisodes as kaaEpisodesRaw } from "../providers/kickassanime.js";
import { getEpisodes as animedunyaEpisodesRaw } from "../providers/animedunya.js";
import { getEpisodes as animeonsenEpisodesRaw } from "../providers/animeonsen.js";
import { getEpisodes as anipmEpisodesRaw } from "../providers/anipm.js";
import { getEpisodes as gogoanimeEpisodesRaw } from "../providers/gogoanime.js";
import { getEpisodes as animesaturnEpisodesRaw } from "../providers/animesaturn.js";
import { trackProvider } from "./provider-health.js";

// Every real upstream call is recorded for GET /status (cache hits never reach these).
const mkissaEpisodes      = trackProvider("mkissa", mkissaEpisodesRaw);
const reanimeEpisodes     = trackProvider("reanime", reanimeEpisodesRaw);
const anikotoEpisodes     = trackProvider("anikoto", anikotoEpisodesRaw);
const animeggEpisodes     = trackProvider("animegg", animeggEpisodesRaw);
const animenosubEpisodes  = trackProvider("animenosub", animenosubEpisodesRaw);
const anizoneEpisodes     = trackProvider("anizone", anizoneEpisodesRaw);
const aniwavesEpisodes    = trackProvider("aniwaves", aniwavesEpisodesRaw);
const senshiEpisodes      = trackProvider("senshi", senshiEpisodesRaw);
const kaaEpisodes         = trackProvider("kaa", kaaEpisodesRaw);
const animedunyaEpisodes  = trackProvider("animedunya", animedunyaEpisodesRaw);
const animeonsenEpisodes  = trackProvider("animeonsen", animeonsenEpisodesRaw);
const anipmEpisodes       = trackProvider("anipm", anipmEpisodesRaw);
const gogoanimeEpisodes   = trackProvider("gogoanime", gogoanimeEpisodesRaw);
const animesaturnEpisodes = trackProvider("animesaturn", animesaturnEpisodesRaw);

const inflight  = new Map();
const bgRunning = new Set();

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function bg(key, fn) {
  if (bgRunning.has(key)) return;
  bgRunning.add(key);
  Promise.resolve()
    .then(fn)
    .catch(e => console.error(`[bg:${key}]`, e.message))
    .finally(() => bgRunning.delete(key));
}

async function withCache(key, status, fetchFn) {
  const [ttl, refreshAfter] = episodeTTL(status);
  const entry = await getAsync(key);

  if (isFresh(entry)) {
    if (needsRefresh(entry)) {
      bg(key, async () => {
        const data = await fetchFn();
        await setAsync(key, data, ttl, refreshAfter);
      });
    }
    return entry.data;
  }

  const data = await fetchFn();
  await setAsync(key, data, ttl, refreshAfter);
  return data;
}

function orderEpisodeFields(data) {
  if (!data?.episodes || typeof data.episodes !== "object") return data;
  const episodes = Object.fromEntries(Object.entries(data.episodes).map(([audio, list]) => [
    audio,
    Array.isArray(list)
      ? list.map(({ id, audio: itemAudio, sourceNumber, ...episode }) => ({
        ...(id === undefined ? {} : { id }),
        ...(sourceNumber === undefined ? {} : { sourceNumber }),
        ...(itemAudio === undefined ? {} : { audio: itemAudio }),
        ...episode,
      }))
      : list,
  ]));
  return { ...data, episodes };
}

async function safe(label, fn) {
  try   { return { ok: true,  data: orderEpisodeFields(await fn()) }; }
  catch (e) { console.error(`[ep:${label}]`, e.message); return { ok: false, error: e.message, stack: e.stack }; }
}

const PROVIDER_ALIASES = {
  mkissa: "mkissa",
  reanime:  "reanime",
  anikoto:  "anikoto",
  animegg:  "animegg",
  animenosub: "animenosub",
  anizone: "anizone",
  aniwaves: "aniwaves",
  senshi: "senshi",
  kaa:    "kaa",
  animedunya: "animedunya",
  animeonsen: "animeonsen",
  anipm: "anipm",
  gogoanime: "gogoanime",
  gogo: "gogoanime",
  animesaturn: "animesaturn",
  saturn: "animesaturn",
};

export function resolveProviders(rawNames) {
  const resolved = new Set();
  const unknown  = [];
  for (const raw of rawNames) {
    const name = PROVIDER_ALIASES[raw.toLowerCase()];
    if (name) resolved.add(name);
    else unknown.push(raw);
  }
  return { resolved, unknown };
}

function providerFns(anilistId, status, ctx) {
  return {
    mkissa: () => withCache(`epv:match2:mkissa:${anilistId}`, status, () => mkissaEpisodes(anilistId, ctx)),
    reanime:  () => withCache(`epv:match2:reanime:${anilistId}`, status, () => reanimeEpisodes(anilistId, ctx)),
    anikoto:  () => withCache(`epv:match2:anikoto:${anilistId}`, status, () => anikotoEpisodes(anilistId, ctx)),
    animegg:  () => withCache(`epv:match2:animegg:${anilistId}`, status, () => animeggEpisodes(anilistId, ctx)),
    animenosub: () => withCache(`epv:match2:animenosub:${anilistId}`, status, () => animenosubEpisodes(anilistId, ctx)),
    anizone: () => withCache(`epv:match2:anizone:${anilistId}`, status, () => anizoneEpisodes(anilistId, ctx)),
    aniwaves: () => withCache(`epv:match2:aniwaves:${anilistId}`, status, () => aniwavesEpisodes(anilistId, ctx)),
    senshi: () => withCache(`epv:senshi:${anilistId}`,  status, () => senshiEpisodes(anilistId, ctx)),
    kaa:    () => withCache(`epv:match2:kaa:${anilistId}`, status, () => kaaEpisodes(anilistId, ctx)),
    animedunya: () => withCache(`epv:animedunya:${anilistId}`, status, () => animedunyaEpisodes(anilistId, ctx)),
    animeonsen: () => withCache(`epv:match2:animeonsen:${anilistId}`, status, () => animeonsenEpisodes(anilistId, ctx)),
    anipm: () => withCache(`epv:match2:anipm:${anilistId}`, status, () => anipmEpisodes(anilistId, ctx)),
    gogoanime: () => withCache(`epv:match2:gogoanime:${anilistId}`, status, () => gogoanimeEpisodes(anilistId, ctx)),
    animesaturn: () => withCache(`epv:match2:animesaturn:${anilistId}`, status, () => animesaturnEpisodes(anilistId, ctx)),
  };
}

export async function buildFilteredEpisodesWithCache(anilistId, providers, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const ctx  = { media, anizip, maxPages: undefined };
  const fns  = providerFns(anilistId, status, ctx);

  const pairs = await Promise.all(
    [...providers].map(async (name) => {
      const result = await safe(name, fns[name]);
      return [name, result.ok ? result.data : { error: result.error, stack: result.stack }];
    })
  );

  return Object.fromEntries(pairs);
}

export async function buildEpisodesWithCache(anilistId, media, anizip) {
  const status = media?.status ?? "RELEASING";
  const ctx = { media, anizip, maxPages: undefined };

  const [mkissa, reanime, anikoto, animegg, animenosub, anizone, aniwaves, senshi, kaa, animedunya, animeonsen, anipm, gogoanime, animesaturn] = await Promise.all([
    safe("mkissa",     () => withCache(`epv:match2:mkissa:${anilistId}`,     status, () => mkissaEpisodes(anilistId, ctx))),
    safe("reanime",    () => withCache(`epv:match2:reanime:${anilistId}`,    status, () => reanimeEpisodes(anilistId, ctx))),
    safe("anikoto",    () => withCache(`epv:match2:anikoto:${anilistId}`,    status, () => anikotoEpisodes(anilistId, ctx))),
    safe("animegg",    () => withCache(`epv:match2:animegg:${anilistId}`,    status, () => animeggEpisodes(anilistId, ctx))),
    safe("animenosub", () => withCache(`epv:match2:animenosub:${anilistId}`, status, () => animenosubEpisodes(anilistId, ctx))),
    safe("anizone",    () => withCache(`epv:match2:anizone:${anilistId}`,    status, () => anizoneEpisodes(anilistId, ctx))),
    safe("aniwaves",   () => withCache(`epv:match2:aniwaves:${anilistId}`,   status, () => aniwavesEpisodes(anilistId, ctx))),
    safe("senshi",     () => withCache(`epv:senshi:${anilistId}`,     status, () => senshiEpisodes(anilistId, ctx))),
    safe("kaa",        () => withCache(`epv:match2:kaa:${anilistId}`,        status, () => kaaEpisodes(anilistId, ctx))),
    safe("animedunya", () => withCache(`epv:animedunya:${anilistId}`, status, () => animedunyaEpisodes(anilistId, ctx))),
    safe("animeonsen", () => withCache(`epv:match2:animeonsen:${anilistId}`, status, () => animeonsenEpisodes(anilistId, ctx))),
    safe("anipm",      () => withCache(`epv:match2:anipm:${anilistId}`,      status, () => anipmEpisodes(anilistId, ctx))),
    safe("gogoanime",  () => withCache(`epv:match2:gogoanime:${anilistId}`,  status, () => gogoanimeEpisodes(anilistId, ctx))),
    safe("animesaturn", () => withCache(`epv:match2:animesaturn:${anilistId}`, status, () => animesaturnEpisodes(anilistId, ctx))),
  ]);

  return {
    mkissa:      mkissa.ok      ? mkissa.data      : { error: mkissa.error,      stack: mkissa.stack },
    reanime:     reanime.ok     ? reanime.data     : { error: reanime.error,     stack: reanime.stack },
    anikoto:     anikoto.ok     ? anikoto.data     : { error: anikoto.error,     stack: anikoto.stack },
    animegg:     animegg.ok     ? animegg.data     : { error: animegg.error,     stack: animegg.stack },
    animenosub:  animenosub.ok  ? animenosub.data  : { error: animenosub.error,  stack: animenosub.stack },
    anizone:     anizone.ok     ? anizone.data     : { error: anizone.error,     stack: anizone.stack },
    aniwaves:    aniwaves.ok    ? aniwaves.data    : { error: aniwaves.error,    stack: aniwaves.stack },
    senshi:      senshi.ok      ? senshi.data      : { error: senshi.error,      stack: senshi.stack },
    kaa:         kaa.ok         ? kaa.data         : { error: kaa.error,         stack: kaa.stack },
    animedunya:  animedunya.ok  ? animedunya.data  : { error: animedunya.error,  stack: animedunya.stack },
    animeonsen:  animeonsen.ok  ? animeonsen.data  : { error: animeonsen.error,  stack: animeonsen.stack },
    anipm:       anipm.ok       ? anipm.data       : { error: anipm.error,       stack: anipm.stack },
    gogoanime:   gogoanime.ok   ? gogoanime.data   : { error: gogoanime.error,   stack: gogoanime.stack },
    animesaturn: animesaturn.ok ? animesaturn.data : { error: animesaturn.error, stack: animesaturn.stack },
  };
}
