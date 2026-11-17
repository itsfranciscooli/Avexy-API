<div align="center">


<img src="docs/logo.svg" width="80" height="80"/>


# Anivexa API

**Anime streaming aggregator API — one endpoint, all your sources.**

![Views](https://visitor-badge.laobi.icu/badge?page_id=walterwhite-69.Anivexa-API)
[![GitHub stars](https://img.shields.io/github/stars/walterwhite-69/Anivexa-API?style=flat-square&color=yellow)](https://github.com/walterwhite-69/Anivexa-API/stargazers)


</div>

---

## What is this?

A single API that aggregates anime episode lists and streaming links from multiple providers. Give it an AniList ID, get back everything — episodes, sources, and stream URLs — all in one place.

## Notice!
***This API intentionally uses AniList as its catalog and identity layer. When AniList is unavailable, the API may be partially unavailable or unstable as well. If you do not want an AniList-backed catalog, this simply is not the API for your use case!. So dont bother using it.***

---

## Providers

All listed providers are active. Coverage and stream availability vary by title.

| Provider | Highlights |
|---|---|
| **MKissa** | Large catalog; captcha retries can slow requests |
| **Reanime** | Broad catalog |
| **AniKoto** | Broad catalog |
| **AnimeGG** | Fuzzy title matching |
| **AnimeNoSub** | Sub and dub episodes |
| **AniZone** | Sub, HLS, and subtitles |
| **AniWaves** | HLS, MP4, and embed fallbacks |
| **Senshi** | Episode mapping and streams |
| **Kickassanime** | Fuzzy title matching |
| **AnimeDunya** | MAL-backed; sub, HLS, and subtitles |
| **AnimeOnsen** | AniList/MAL matching; sub, DASH, and subtitles |
| **Ani.pm** | Soft-sub and hard-sub variants |

---

## Routes

```
GET /map/:anilistId
```
Returns cross-platform ID mappings — MAL, TVDB, TMDB, Kitsu, AniDB, and more.

```
GET /episodes/:anilistId
GET /episodes/:provider[/:provider...]/:anilistId
```
Returns episode lists in a single response with smart background refresh. Pass one or more provider names in the path to filter results — e.g. `/episodes/anizone/mkissa/16498` returns only those two. Omit providers to get all of them.

```
GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
```
Returns stream URLs for a specific episode from a specific provider.

```
GET /stream/reanime/:id/sub|dub/:ep
```
302 redirect directly to the HLS stream.

<a id="reanime-flixcloud-playback"></a>
## ReAnime / FlixCloud playback notes

<details>
<summary>Click to see playback/decryption guide</summary>

ReAnime uses FlixCloud for some streams. The returned `url` can be a signed HLS master URL, but FlixCloud may return the manifest as a Base64 + XOR payload instead of plaintext `#EXTM3U`.

For those streams, use the returned `playlist_key` or `key` field to decode the master playlist and any child playlists before handing them to an HLS player.

```js
function decryptFlixManifest(bodyBuffer, playlistKey) {
  const raw = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  const trimmed = raw.toString("utf8").trim();

  if (trimmed.startsWith("#EXTM3U")) return trimmed;

  const key = Buffer.from(playlistKey, "base64");
  let payload = Buffer.from(trimmed, "base64");
  const out = Buffer.alloc(payload.length);

  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ key[i % key.length];
  }

  const text = out.toString("utf8").trim();
  if (!text.startsWith("#EXTM3U")) throw new Error("FlixCloud manifest decrypt failed");
  return text;
}

function getManifestUrls(m3u8Text) {
  return m3u8Text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function fetchAndDecryptFlixManifest(manifestUrl, playlistKey) {
  const res = await fetch(manifestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://flixcloud.cc/",
      "Origin": "https://flixcloud.cc"
    }
  });

  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);

  const body = Buffer.from(await res.arrayBuffer());
  return decryptFlixManifest(body, playlistKey);
}
```

`HD-1` commonly uses AES-keyed HLS playlists. `HD-2` commonly uses image-wrapped `.png`/`.webp` segment URLs, so a custom proxy/player may need to unwrap those segment bytes before playback.

For HD-2 style image-wrapped segments, fetch the segment through your proxy, unwrap it, and return it as `video/mp2t`.

```js
const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

function unwrapFlixImageSegment(bodyBuffer) {
  const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  let offset = 0;
  let needsXor = false;

  const isWebp =
    body.length > 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50;

  const isPng =
    body.length > 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a;

  if (isWebp) {
    offset = 12;
    needsXor = body[offset] !== 0x47;
  } else if (isPng) {
    offset = 8;
    needsXor = body[offset] !== 0x47;
  }

  if (!offset) return { body, unwrapped: false };

  const out = Buffer.from(body.subarray(offset));
  if (needsXor) {
    for (let i = 0; i < out.length; i++) {
      out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
    }
  }

  return { body: out, unwrapped: true };
}
```

The API does not expose a public ReAnime `/proxy` route. If you need direct custom-player playback, use the returned `embed` URL or implement the manifest decode/proxy flow above.

***Removed the ReAnime `/proxy` endpoint since it was unnecessary and did not handle the Flixcloud playback flow anyway.***

</details>

---

## Self-hosted

```bash
git clone https://github.com/walterwhite-69/Anivexa-API
cd Anivexa-API
npm install
cp .env.example .env
node server.js
```

Runs on Node.js. No build step needed. Caching runs entirely locally (memory + disk);
no external service is required.

### Run the full stack (app + local Redis) with Docker

For a self-contained local deployment that includes a Redis cache, use the bundled
`docker-compose.yml` — it starts the API and a local Redis container together:

```bash
docker compose up --build
```

The API comes up on `http://localhost:4000` with `CACHE_ENABLED=true` and
`REDIS_URL=redis://redis:6379`. Everything is local — no accounts, no external services.

### Cache warming

When caching is on, the server fills the cache in the background so popular shows are fast even on their first visit. Two jobs run at startup and then on a timer:

| Job | Runs every | Shows |
|---|---|---|
| hourly | 1 hour | MyAnimeZone community trending, plus every show with an episode airing today |
| six-hourly | 6 hours | AniList trending, AniList most popular of all time, every show in the current season, and every show airing this week |

Shows that are already cached and haven't changed (for example, finished series) are checked but not re-scraped.

### Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Notes |
|---|---|---|
| `CACHE_ENABLED` | `true` | Set to `false` to disable caching. When on, the cache uses in-memory + on-disk tiers, plus a local Redis if one is reachable at `REDIS_URL`. No external service is required. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | A **local** Redis server (e.g. the one in `docker-compose.yml`). Entirely optional — if Redis isn't running, the cache falls back to memory + disk automatically. |
| `DEFAULT_REDIS_TTL` | `900` | Seconds. Fallback expiry for Redis writes when a per-item TTL isn't computed. Most cache entries use their own smart TTLs based on anime status (finished/airing/etc.) — this is just the safety-net default. |
| `WARMUP_ENABLED` | `true` | Pre-cache popular anime in the background (see *Cache warming*). Only runs when `CACHE_ENABLED=true` and the app is started with `server.js`. |
| `WARMUP_LIMIT` | `50` | How many AniList trending and all-time-popular shows to pre-cache (each list). |
| `WARMUP_CONCURRENCY` | `3` | How many shows are scraped at the same time while warming. |
| `WARMUP_COMMUNITY_URL` | `https://myanimezone.xyz/api/community/trending` | Community trending feed checked every hour. Set to an empty value to disable. |
| `PORT` | `4000` | Local dev server port (`server.js` only — ignored on Vercel/serverless). Change it if `4000` is already in use, then hit `http://localhost:PORT`. |

On Vercel (or Railway/Render), set these as regular project environment variables instead of committing `.env`.

---

## Deploying on Coolify

The repo ships with a `Dockerfile`, so Coolify can build it directly. Caching is **on** by default and runs locally (memory + disk) with no external service.

1. In Coolify, create a new resource from this Git repository.
2. Set **Build Pack** to `Dockerfile`.
3. Set **Ports Exposes** to `4000`.
4. Deploy.

No environment variables are required. If you want a shared Redis cache, run a Redis instance (e.g. a sidecar container) and point `REDIS_URL` at it; otherwise the cache uses memory + disk automatically. Set `CACHE_ENABLED=false` to turn caching off.

---

## Deploying on Vercel

> ⚠️ **Not recommended.** Vercel runs on shared datacenter IPs that are widely blocked by anime streaming sites. Most providers will fail silently or return errors — the API will technically run but you'll get little to no data back. Use a self-hosted VPS or use railway, render etc etc.

---

## Contributing

> **Only request providers that self-host their content. No scrapers of third-party sites.**

Got a provider you'd like added? Open an issue.

This project is community-kept-alive — if it helps you, please:

- ⭐ **Star the repo** so others can find it
- 🛠️ **Open a PR** if you want to add or fix something

---

<div align="center">

hope it helped :3

</div>
