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

// ─────────────────────────────────────────────────────────────────
//  Providers – each entry defines how to build the embed URL
// ─────────────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: "vidsrcme",
    movie: (id) => `https://vidsrcme.ru/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrcme.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
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
];
  
export const LANGUAGE_NAMES = { en: "English" };
export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Global browser instance, launched once
let browser;

// Simple 15-minute in-memory cache
const cache = new Map();

// Max 2 providers scraped at the same time
const limit = pLimit(2);

// ─────────────────────────────────────────────────────────────────
//  Generic scraper – works across all providers
//  Strategy:
//    1. Intercept all .m3u8 network requests
//    2. Load the page
//    3. Try a cascade of click strategies until HLS is found
//    4. Return whatever was captured
// ─────────────────────────────────────────────────────────────────
async function scrapeProvider(providerName, url) {
  console.log(`\n[${providerName}] Scraping: ${url}`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  let hlsUrl = null;
  const subtitles = [];

  const isSubtitle = (u) =>
    /\.(vtt|srt)(\?.*)?$/.test(u) || u.includes(".vtt") || u.includes(".srt");

  try {
    // ── Intercept network requests ───────────────────────────────
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        console.log(`[${providerName}] ✅ HLS found: ${hlsUrl}`);
      }
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
      }
      route.continue();
    });

    page.on("request", (req) => {
      const reqUrl = req.url();
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
      }
    });

    // ── Load the page ────────────────────────────────────────────
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    console.log(`[${providerName}] Page loaded`);

    // ── Click strategy cascade ───────────────────────────────────
    // We try multiple selectors in order. The first one that exists gets clicked.
    // If none match we fall back to clicking the center of the page.

    const CLICK_SELECTORS = [
      "#the_frame",          // vidsrc family
      "iframe",              // generic iframe
      ".play-button",        // common play button class
      "[class*='play']",     // any element with 'play' in class
      "video",               // direct video element
      ".jw-display",         // JWPlayer
      ".plyr__play-large",   // Plyr
      "#player",             // generic player div
      "body",                // last resort – click center of page
    ];

    let clicked = false;
    for (const selector of CLICK_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (!el) continue;

        const box = await el.boundingBox();
        if (box) {
          const x = box.x + box.width  / 2;
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.click(x, y);
          console.log(`[${providerName}] Clicked "${selector}" at (${x.toFixed(0)}, ${y.toFixed(0)})`);
          clicked = true;
          break;
        } else {
          // Element exists but has no box (e.g. hidden) – try JS click
          await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
          console.log(`[${providerName}] JS-clicked "${selector}"`);
          clicked = true;
          break;
        }
      } catch (_) {
        // selector failed, try next
      }
    }

    if (!clicked) {
      console.warn(`[${providerName}] No clickable element found`);
    }
    
    await page.waitForTimeout(3000);

    // ── Wait for HLS URL to appear (up to 12 seconds) ───────────
    if (!hlsUrl) {
      await page
        .waitForResponse((resp) => resp.url().includes(".m3u8"), { timeout: 20000 })
        .then((resp) => { hlsUrl = resp.url(); })
        .catch(async () => {
          console.warn(`[${providerName}] .m3u8 not detected within 20s`);
          await page.waitForTimeout(3000);
        });
    }

    // ── Extra wait for subtitles ─────────────────────────────────
    if (subtitles.length === 0) {
      await page.waitForTimeout(4000);
    }

    await page.close();
    await context.close();

    if (!hlsUrl) throw new Error("HLS URL not found");

    return { hls_url: hlsUrl, subtitles, error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${providerName}] ❌ ${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// ─────────────────────────────────────────────────────────────────
//  /extract  – tries all providers, returns first success
// ─────────────────────────────────────────────────────────────────
app.get("/extract", async (req, res) => {
  const type     = req.query.type || "movie";
  const tmdb_id  = req.query.tmdb_id;
  const season   = req.query.season   ? parseInt(req.query.season)   : undefined;
  const episode  = req.query.episode  ? parseInt(req.query.episode)  : undefined;

  if (!tmdb_id) {
    return res.status(400).json({ success: false, error: "tmdb_id query param is required", results: {} });
  }
  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({ success: false, error: "season and episode are required for TV", results: {} });
  }

  const cacheKey = JSON.stringify(req.query);
  const cached   = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    console.log("Serving from cache");
    return res.json(cached.response);
  }

  try {
    const resultsArr = await Promise.all(
      PROVIDERS.map((p) =>
        limit(async () => {
          const url = type === "tv"
            ? p.tv(tmdb_id, season, episode)
            : p.movie(tmdb_id);
          try {
            const result = await scrapeProvider(p.name, url);
            return [p.name, result];
          } catch (err) {
            return [p.name, { hls_url: null, subtitles: [], error: err.message }];
          }
        })
      )
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);

    // Build a clean sources array from successful results
    const sources = Object.entries(results)
      .filter(([, r]) => r.hls_url)
      .map(([name, r]) => ({
        provider: name,
        url:      r.hls_url,
        quality:  "auto",
      }));

    // Merge all subtitles found across providers (deduplicated)
    const allSubtitles = [
      ...new Map(
        Object.values(results)
          .flatMap((r) => r.subtitles)
          .map((s) => [s, { url: s, lang: "en", label: "English" }])
      ).values(),
    ];

    const response = { success, sources, subtitles: allSubtitles, results };

    cache.set(cacheKey, { timestamp: Date.now(), response });
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, error: "Unexpected server error", results: {} });
  }
});

// ─────────────────────────────────────────────────────────────────
//  Subtitle endpoints (unchanged from original)
// ─────────────────────────────────────────────────────────────────
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url      = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
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
      language:      item.attributes.language,
      language_name: LANGUAGE_NAMES[item.attributes.language] || item.attributes.language,
      file_id:       item.attributes.files[0].file_id,
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

    const baseList  = await searchSubtitles(imdb_id);
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

app.get("/test-providers", async (req, res) => {
  const urls = [
    "https://vidsrcme.ru",
    "https://vsembed.su", 
    "https://2embed.cc",
    "https://vidlink.pro",
    "https://embed.su",
    "https://vidsrc.cc",
  ];

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return { url, ok: r.ok, status: r.status };
      } catch (e) {
        return { url, ok: false, error: e.message };
      }
    })
  );

  res.json(results);
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
    const srt         = await subtitleRes.text();
    const vtt         =
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

app.get("/", (req, res) => {
  res.send("🎬 VidSrc Scraper API is running. Visit /subtitles or /extract to use.");
});

// ─────────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────────
(async () => {
  browser = await chromium.launch({ headless: true });
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
})();

process.on("SIGINT",  async () => { if (browser) await browser.close(); process.exit(); });
process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(); });
