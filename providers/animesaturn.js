import { getMedia } from "../core/anilist.js";
import {
  UA,
  buildTitles,
  episodeMeta,
  expectedCount,
  fetchHtml,
  json,
  stripTags,
  titleIdentityScore,
} from "../core/new-provider-utils.js";
import { get, set, isFresh, SHOW_IDENTITY_TTL } from "../core/smartcache.js";

// AnimeSaturn is an Italian site: "sub" is Japanese audio with Italian
// (hard) subtitles, "dub" is the Italian dub ("(ITA)" entries).
const BASE = "https://www.animesaturn.net";
const LANGUAGE = "it";
const PAGE_TTL = 10 * 60_000;
const MAX_PAGES_PER_AUDIO = 8;
const MAX_QUERIES = 5;
const SERIES_MEMO_TTL = 6 * 60 * 60_000;
const pageCache = new Map();
const seriesMemo = new Map();

export function isItaDub(title = "", slug = "") {
  return /\(\s*ita\s*\)\s*$/i.test(title) || /-ita-[A-Za-z0-9]+$/.test(slug);
}

export function cleanTitle(title = "") {
  return title.replace(/\(\s*ita\s*\)\s*$/i, "").trim();
}

// /filter?key= lists every match; the JSON /api/search stops at 10, which
// drops e.g. season 1 of long franchises. Posters are often named after the
// AniList id ("bx21459-…"), which ranks the right card first.
export function parseFilterResults(html) {
  const results = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']\/anime\/([^"'/?#]+)["'][^>]*class=["'][^"']*\bac\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, slug, card] = m;
    if (results.has(slug)) continue;
    const title = stripTags(card.match(/<h3\b[^>]*class=["'][^"']*ac__title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "")
      || slug.replace(/-[A-Za-z0-9]+$/, "").replace(/-/g, " ");
    const sub = stripTags(card.match(/<p\b[^>]*class=["'][^"']*ac__sub[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const year = Number(sub.match(/\b(19|20)\d{2}\b/)?.[0]) || null;
    const posterId = Number(card.match(/locandine\/bx(\d+)-/)?.[1]) || null;
    results.set(slug, { slug, title, text: cleanTitle(title), year, posterId, dub: isItaDub(title, slug) });
  }
  return [...results.values()];
}

export function parseAnimePage(html, slug) {
  const anilistId = Number(html.match(/anilist\.co\/anime\/(\d+)/)?.[1]) || null;
  const malId = Number(html.match(/myanimelist\.net\/anime\/(\d+)/)?.[1]) || null;
  const episodes = new Map();
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of html.matchAll(new RegExp(`href=["']/episode/${escaped}/ep-(\\d+)["']`, "g"))) {
    const number = Number(m[1]);
    if (!episodes.has(number)) episodes.set(number, { number, path: `${slug}/ep-${number}` });
  }
  return { anilistId, malId, episodes: [...episodes.values()].sort((a, b) => a.number - b.number) };
}

export function parseEmbedParams(html) {
  const m = html.match(/window\.__E\s*=\s*\{\s*i\s*:\s*(\d+)\s*,\s*k\s*:\s*"([^"]+)"\s*,\s*e\s*:\s*(\d+)\s*\}/);
  return m ? { id: m[1], key: m[2], expires: m[3] } : null;
}

export function decodeSaturn(value, key) {
  if (!value) return "";
  const raw = Buffer.from(value, "base64").toString("latin1");
  let out = "";
  const k = key || "as";
  for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ k.charCodeAt(i % k.length));
  return out;
}

// Broad Latin-script queries first: the site search is a plain substring
// match, so "Frieren" finds every season and its (ITA) dub while the full
// "…Season 2" title finds nothing.
export function searchQueries(titles, limit = MAX_QUERIES) {
  const latin = titles
    .filter((t) => t && !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(t))
    .map((t) => t.replace(/[‘’]/g, "'"));
  const out = [];
  const add = (value) => {
    const query = value.replace(/\s+/g, " ").trim();
    if (query.length >= 3 && !out.some((q) => q.toLowerCase() === query.toLowerCase())) out.push(query);
  };
  for (const title of latin.slice(0, 2)) {
    add(title.replace(/\b(?:season|part|cour)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+season\b/gi, " "));
    add(title.split(/[:–—|]/)[0]);
  }
  for (const title of latin.slice(0, 3)) add(title);
  return out.slice(0, limit);
}

async function getJson(url, referer) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: referer ?? `${BASE}/` } });
  if (!res.ok) throw new Error(`AnimeSaturn HTTP ${res.status}: ${url}`);
  return res.json();
}

async function search(query) {
  return parseFilterResults(await fetchHtml(`${BASE}/filter?key=${encodeURIComponent(query)}`));
}

async function animePage(slug) {
  const hit = pageCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.page;
  const page = parseAnimePage(await fetchHtml(`${BASE}/anime/${slug}`), slug);
  pageCache.set(slug, { page, expires: Date.now() + PAGE_TTL });
  return page;
}

function rankCandidates(candidates, titles, seasonYear, anilistId) {
  return candidates
    .map((c) => {
      let score = titleIdentityScore(titles, [c.text, c.slug.replace(/-[A-Za-z0-9]+$/, "").replace(/-/g, " ")]);
      if (seasonYear && c.year) score += c.year === Number(seasonYear) ? 0.3 : Math.abs(c.year - seasonYear) === 1 ? 0.1 : -0.2;
      if (c.posterId && c.posterId === Number(anilistId)) score += 2;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

async function findById(ranked, anilistId, malId) {
  for (let i = 0; i < Math.min(ranked.length, MAX_PAGES_PER_AUDIO); i += 4) {
    const batch = ranked.slice(i, Math.min(i + 4, MAX_PAGES_PER_AUDIO));
    const pages = await Promise.all(batch.map((c) => animePage(c.slug).catch(() => null)));
    const index = pages.findIndex((p) => p && (
      p.anilistId === Number(anilistId) || (!p.anilistId && malId && p.malId === Number(malId))
    ));
    if (index >= 0) return { slug: batch[index].slug, title: batch[index].title };
  }
  return null;
}

// The site rate-limits bursts (429, Retry-After: 60), so queries run one at a
// time and stop as soon as the AniList/MAL id on an anime page matches.
async function resolveSeries(anilistId, ctx = {}) {
  const cacheKey = `np:match2:animesaturn:${anilistId}`;
  const memo = seriesMemo.get(cacheKey);
  if (memo && memo.expires > Date.now()) return memo.data;
  const cached = get(cacheKey);
  if (isFresh(cached)) return cached.data;

  const media = ctx.media ?? await getMedia(anilistId);
  const titles = buildTitles(media, ctx.anizip);
  const pool = new Map();
  let sub = null, dub = null, lastError = null;
  for (const query of searchQueries(titles)) {
    try {
      for (const c of await search(query)) pool.set(c.slug, c);
    } catch (error) {
      lastError = error;
      if (/HTTP 429/.test(error.message)) break;
      continue;
    }
    const ranked = rankCandidates([...pool.values()], titles, media?.seasonYear, anilistId);
    [sub, dub] = await Promise.all([
      sub ?? findById(ranked.filter((c) => !c.dub), anilistId, media?.idMal),
      dub ?? findById(ranked.filter((c) => c.dub), anilistId, media?.idMal),
    ]);
    if (sub && dub) break;
  }
  if (!sub && !dub) {
    if (!pool.size && lastError) throw new Error(`AnimeSaturn search failed for AniList ${anilistId}: ${lastError.message}`);
    throw new Error(`AnimeSaturn match not found for AniList ${anilistId}`);
  }

  const data = { sub, dub };
  seriesMemo.set(cacheKey, { data, expires: Date.now() + SERIES_MEMO_TTL });
  set(cacheKey, data, SHOW_IDENTITY_TTL);
  return data;
}

function buildEpisodeList(anilistId, episodes, audio, ctx, expected) {
  return episodes
    .filter((e) => e.number >= 1 && (!expected || e.number <= expected))
    .map((e) => {
      const meta = episodeMeta(e.number, ctx);
      return {
        id: `watch/animesaturn/${anilistId}/${audio}/animesaturn-${e.number}`,
        number: e.number,
        title: meta.title ?? `Episode ${e.number}`,
        duration: meta.duration,
        filler: meta.filler,
        uncensored: meta.uncensored,
        description: meta.description,
        image: meta.image,
        airDate: meta.airDate,
        audio,
      };
    });
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media ?? await getMedia(anilistId);
  const localCtx = { ...ctx, media };
  const series = await resolveSeries(anilistId, localCtx);
  const expected = expectedCount(media, ctx.anizip);
  const [subPage, dubPage] = await Promise.all([
    series.sub ? animePage(series.sub.slug) : null,
    series.dub ? animePage(series.dub.slug) : null,
  ]);
  const primary = series.sub ?? series.dub;
  return {
    meta: {
      id: primary.slug,
      title: cleanTitle(primary.title),
      dubId: series.dub?.slug ?? null,
      source: "animesaturn",
      language: LANGUAGE,
    },
    episodes: {
      sub: buildEpisodeList(anilistId, subPage?.episodes ?? [], "sub", localCtx, expected),
      dub: buildEpisodeList(anilistId, dubPage?.episodes ?? [], "dub", localCtx, expected),
    },
  };
}

async function resolveSaturnEmbed(embedUrl) {
  const html = await fetchHtml(embedUrl, { Referer: `${BASE}/` });
  const params = parseEmbedParams(html);
  if (!params) throw new Error("AnimeSaturn: embed params not found");
  const origin = new URL(embedUrl).origin;
  const data = await getJson(
    `${origin}/embed/${params.id}/playlist?token=${encodeURIComponent(params.key)}&expires=${params.expires}`,
    embedUrl,
  );
  const src = decodeSaturn(data?.d, params.key);
  if (!src || src.startsWith("youtube/")) return null;
  return { url: src, type: /\.m3u8(?:\?|$)/i.test(src) ? "hls" : "mp4" };
}

async function resolveServer(episodePath, server) {
  let link = server.link;
  if (!link && server.id != null) {
    link = (await getJson(`${BASE}/api/watch/${episodePath}?server=${server.id}`)).videoUrl;
  }
  if (!link) return [];
  const streams = [];
  if (/saturncdn\.[a-z]+\/embed\//i.test(link)) {
    const direct = await resolveSaturnEmbed(link).catch(() => null);
    if (direct) streams.push({ ...direct, server: server.name ?? "AnimeSaturn" });
  }
  if (server.downloadUrl) streams.push({ url: server.downloadUrl, type: "mp4", server: `${server.name ?? "AnimeSaturn"}-download` });
  streams.push({ url: link, type: "embed", server: `${server.name ?? "AnimeSaturn"}-embed`, referer: `${BASE}/` });
  return streams;
}

async function handleWatch(anilistId, audio, epNum) {
  const series = (await resolveSeries(anilistId))[audio];
  if (!series) return json({ error: `AnimeSaturn: no ${audio} series for AniList ${anilistId}` }, 404);

  const page = await animePage(series.slug);
  const ep = page.episodes.find((e) => e.number === Number(epNum));
  if (!ep) return json({ error: `AnimeSaturn episode ${epNum} not found` }, 404);

  const watch = await getJson(`${BASE}/api/watch/${ep.path}`);
  if (!watch?.ok) return json({ error: `AnimeSaturn: ${watch?.error ?? "watch failed"}` }, 502);
  const servers = Array.isArray(watch.servers) ? watch.servers : [];
  const results = await Promise.allSettled(servers.map((s) => resolveServer(ep.path, s)));
  const streams = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  if (!streams.length) return json({ error: `AnimeSaturn: no streams for episode ${epNum}` }, 404);

  const active = Math.max(0, streams.findIndex((s) => s.type !== "embed"));
  return json({
    anilistId: Number(anilistId),
    episode: Number(epNum),
    audio,
    language: LANGUAGE,
    streams: streams.map((s, i) => ({
      ...s,
      audio,
      language: LANGUAGE,
      priority: streams.length - i,
      isActive: i === active,
    })),
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*" } });
    }
    const url = new URL(request.url);
    try {
      const m = url.pathname.match(/^\/watch\/animesaturn\/(\d+)\/(sub|dub)\/animesaturn-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], m[3]);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  },
};
