// server.js — Fixed & expanded VidSrc / multi-provider scraper
import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json());

// ────────────────────────────────────────────────────────────────────
//  PROVIDERS — extended list. Each provider builds an embed URL for
//  movies or TV episodes. We try them all in parallel (rate-limited).
// ────────────────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: "vidsrc.xyz",
    movie: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidsrc.to",
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: "vidsrc.cc",
    movie: (id) => `https://vidsrc.cc/v2/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: "vidsrc.in",
    movie: (id) => `https://vidsrc.in/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.in/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidsrc.pm",
    movie: (id) => `https://vidsrc.pm/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.pm/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidsrc.net",
    movie: (id) => `https://vidsrc.net/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.net/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "autoembed",
    movie: (id) => `https://player.autoembed.cc/embed/movie/${id}`,
    tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: "multiembed",
    movie: (id) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
  {
    name: "2embed",
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    name: "embed.su",
    movie: (id) => `https://embed.su/embed/movie/${id}`,
    tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: "vidlink.pro",
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    name: "smashystream",
    movie: (id) => `https://embed.smashystream.com/playere.php?tmdb=${id}`,
    tv: (id, s, e) => `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "superembed",
    movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
  {
    name: "moviesapi",
    movie: (id) => `https://moviesapi.club/movie/${id}`,
    tv: (id, s, e) => `https://moviesapi.club/tv/${id}-${s}-${e}`,
  },
];

export const LANGUAGE_NAMES = { en: "English" };
export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Global browser instance, launched once
let browser;

// Simple LRU-ish in-memory cache (15 min TTL, capped at 200 entries)
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // refresh LRU position
  cache.delete(key);
  cache.set(key, v);
  return v.response;
}
function cacheSet(key, response) {
  cache.set(key, { timestamp: Date.now(), response });
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// Max concurrent providers being scraped (browsers are heavy)
const limit = pLimit(Number(process.env.SCRAPER_CONCURRENCY) || 3);

// ────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────
const SUBTITLE_RE = /\.(vtt|srt)(\?|$)/i;
const M3U8_RE = /\.m3u8(\?|$)/i;
const isSubtitle = (u) => SUBTITLE_RE.test(u);
const isM3u8 = (u) => M3U8_RE.test(u);

/**
 * Walk all frames (top + nested iframes) and try to click anything that
 * looks like a play button. Returns true if something was clicked.
 */
async function clickPlayEverywhere(page, providerName) {
  const CLICK_SELECTORS = [
    "#pl_but",                // vidsrc.xyz overlay
    "#the_frame",             // vidsrc family
    ".play-button",
    "[class*='play-btn']",
    "[class*='playBtn']",
    "[class*='play']",
    ".jw-display",
    ".plyr__play-large",
    "button[aria-label*='play' i]",
    "video",
    "#player",
    "iframe",
    "body",
  ];

  let clicked = false;
  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of CLICK_SELECTORS) {
      try {
        const el = await frame.$(sel);
        if (!el) continue;
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y).catch(() => {});
          await page.mouse.click(x, y).catch(() => {});
        } else {
          await frame.evaluate((s) => document.querySelector(s)?.click(), sel).catch(() => {});
        }
        console.log(`[${providerName}] clicked "${sel}" in frame ${frame.url().slice(0, 60)}`);
        clicked = true;
        break;
      } catch {}
    }
  }
  return clicked;
}

/**
 * Prefer master m3u8 playlists over variant streams.
 * A master is usually shorter (no /seg-/, no /chunk-) and contains words
 * like "master", "index", "playlist".
 */
function pickBestM3u8(urls) {
  if (!urls.length) return null;
  const score = (u) => {
    let s = 0;
    if (/master\.m3u8/i.test(u)) s += 50;
    if (/index\.m3u8/i.test(u)) s += 20;
    if (/playlist\.m3u8/i.test(u)) s += 15;
    if (/\/seg-|\/chunk-|chunklist/i.test(u)) s -= 50;
    s -= Math.min(u.length / 50, 10); // prefer shorter URLs
    return s;
  };
  return [...urls].sort((a, b) => score(b) - score(a))[0];
}

// ────────────────────────────────────────────────────────────────────
//  Generic scraper. Strategy:
//   1. Open new context (fresh cookies, realistic UA)
//   2. Passively listen for .m3u8 + subtitle requests
//   3. Navigate, then click play across ALL frames
//   4. Wait for m3u8, pick the master playlist
// ────────────────────────────────────────────────────────────────────
async function scrapeProvider(providerName, url, { timeoutMs = 30000 } = {}) {
  console.log(`\n[${providerName}] Scraping: ${url}`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Block heavy resources we don't need (speeds scraping a lot).
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  const m3u8Set = new Set();
  const subtitles = new Set();

  const onReq = (req) => {
    const u = req.url();
    if (isM3u8(u)) m3u8Set.add(u);
    if (isSubtitle(u)) subtitles.add(u);
  };
  const onResp = (resp) => {
    const u = resp.url();
    if (isM3u8(u)) m3u8Set.add(u);
    if (isSubtitle(u)) subtitles.add(u);
  };
  page.on("request", onReq);
  page.on("response", onResp);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    console.log(`[${providerName}] page loaded`);

    // Give the page a moment to attach players / iframes
    await page.waitForTimeout(1500);

    await clickPlayEverywhere(page, providerName);
    await page.waitForTimeout(2000);

    // Some providers need a 2nd click after iframe loads its UI
    await clickPlayEverywhere(page, providerName);

    // Wait up to remaining budget for an m3u8 to appear
    if (m3u8Set.size === 0) {
      await page
        .waitForResponse((r) => isM3u8(r.url()), { timeout: timeoutMs - 5000 })
        .then((r) => m3u8Set.add(r.url()))
        .catch(() => console.warn(`[${providerName}] no .m3u8 within budget`));
    }

    // Give subtitles a beat
    if (subtitles.size === 0) await page.waitForTimeout(2500);

    const hls = pickBestM3u8([...m3u8Set]);
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    if (!hls) throw new Error("HLS URL not found");
    return { hls_url: hls, all_m3u8: [...m3u8Set], subtitles: [...subtitles], error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${providerName}] ❌ ${error.message}`);
    return { hls_url: null, all_m3u8: [...m3u8Set], subtitles: [...subtitles], error: error.message };
  }
}

// ────────────────────────────────────────────────────────────────────
//  /extract — tries all providers, returns every successful source
// ────────────────────────────────────────────────────────────────────
app.get("/extract", async (req, res) => {
  const type    = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season  = req.query.season  ? parseInt(req.query.season, 10)  : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
  const only    = req.query.providers ? String(req.query.providers).split(",") : null;

  if (!tmdb_id) {
    return res.status(400).json({ success: false, error: "tmdb_id query param is required", results: {} });
  }
  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({ success: false, error: "season and episode are required for TV", results: {} });
  }

  const cacheKey = JSON.stringify(req.query);
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log("Serving from cache");
    return res.json(cached);
  }

  const selectedProviders = only
    ? PROVIDERS.filter((p) => only.includes(p.name))
    : PROVIDERS;

  try {
    const resultsArr = await Promise.all(
      selectedProviders.map((p) =>
        limit(async () => {
          const url = type === "tv" ? p.tv(tmdb_id, season, episode) : p.movie(tmdb_id);
          try {
            const result = await scrapeProvider(p.name, url);
            return [p.name, { ...result, embed_url: url }];
          } catch (err) {
            return [p.name, { hls_url: null, subtitles: [], embed_url: url, error: err.message }];
          }
        })
      )
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);

    const sources = Object.entries(results)
      .filter(([, r]) => r.hls_url)
      .map(([name, r]) => ({ provider: name, url: r.hls_url, quality: "auto" }));

    const allSubtitles = [
      ...new Map(
        Object.values(results)
          .flatMap((r) => r.subtitles || [])
          .map((s) => [s, { url: s, lang: "en", label: "English" }])
      ).values(),
    ];

    const response = { success, sources, subtitles: allSubtitles, results };
    cacheSet(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Unexpected server error", results: {} });
  }
});

// ────────────────────────────────────────────────────────────────────
//  Subtitle endpoints
// ────────────────────────────────────────────────────────────────────
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Failed to fetch IMDb ID from TMDB");
  const data = await response.json();
  return data.imdb_id || null;
}

async function searchSubtitles(imdb_id) {
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`,
    { headers: { "Api-Key": OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.data?.length) return [];
  return data.data
    .filter((item) => item.attributes?.files?.[0]?.file_id && COMMON_LANGUAGES.includes(item.attributes.language))
    .map((item) => ({
      language: item.attributes.language,
      language_name: LANGUAGE_NAMES[item.attributes.language] || item.attributes.language,
      file_id: item.attributes.files[0].file_id,
      download_count: item.attributes.download_count || 0,
    }))
    .sort((a, b) => b.download_count - a.download_count)
    .slice(0, 2);
}

async function getSubtitleDownloadUrl(file_id) {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" },
    body: JSON.stringify({ file_id }),
  });
  if (!res.ok) throw new Error("Subtitle download URL fetch failed");
  const data = await res.json();
  return data.link;
}

app.get("/movie-subtitles", async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;
  if (!tmdb_id) return res.status(400).json({ success: false, error: "tmdb_id is required" });
  try {
    const imdb_id = await getIMDbIdFromTMDB(tmdb_id, type);
    if (!imdb_id) return res.status(404).json({ success: false, error: "IMDb ID not found" });
    const baseList = await searchSubtitles(imdb_id);
    const subtitles = await Promise.all(
      baseList.map(async (sub) => {
        try {
          const url = await getSubtitleDownloadUrl(sub.file_id);
          return { language: sub.language, language_name: sub.language_name, url };
        } catch { return null; }
      })
    );
    res.json({ success: true, subtitles: subtitles.filter(Boolean), meta: { tmdb_id, imdb_id, type } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;
  try {
    if (type === "tv") {
      const vtt = await getTVSubtitleVTT(title, season, episode);
      if (!vtt) return res.status(404).send("No subtitle found");
      return res.set("Content-Type", "text/vtt").send(vtt);
    }
    res.status(400).send("Invalid type provided");
  } catch (err) {
    res.status(500).send("Internal server error");
  }
});

app.get("/subtitle-proxy", async (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) return res.status(400).send("Missing subtitle URL");
  try {
    const subtitleRes = await fetch(fileUrl);
    const srt = await subtitleRes.text();
    const vtt =
      "WEBVTT\n\n" +
      srt
        .replace(/\r+/g, "")
        .replace(/^\s+|\s+$/g, "")
        .split("\n")
        .map((line) => line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4"))
        .join("\n");
    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    res.status(500).send("Failed to convert subtitle");
  }
});

app.get("/providers", (req, res) => {
  res.json({ providers: PROVIDERS.map((p) => p.name) });
});

app.get("/test-providers", async (req, res) => {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      const url = new URL(p.movie("550")).origin;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
        return { provider: p.name, url, ok: r.ok, status: r.status };
      } catch (e) {
        return { provider: p.name, url, ok: false, error: e.message };
      }
    })
  );
  res.json(results);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), browser: !!browser });
});

app.get("/", (req, res) => {
  res.send("🎬 VidSrc Scraper API is running. Try /extract?tmdb_id=550&type=movie");
});

// ────────────────────────────────────────────────────────────────────
//  Bootstrap
// ────────────────────────────────────────────────────────────────────
(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
})();

const shutdown = async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
