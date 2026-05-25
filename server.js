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

const PROVIDERS = [
  {
    name: "vidsrcme",
    movie: (id) => `https://vidsrcme.ru/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrcme.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "vidlink",
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
];

export const LANGUAGE_NAMES = { en: "English" };
export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

let browser;
const cache = new Map();
const limit = pLimit(2);

async function scrapeProvider(providerName, url) {
  console.log(`\n[${providerName}] Scraping: ${url}`);

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  });

  context.on("page", (p) => {
    p.on("request", (req) => {
      if (req.url().includes(".m3u8")) {
        console.log(`[${providerName}] 🎯 m3u8 in new page: ${req.url()}`);
      }
    });
  });

  const page = await context.newPage();
  let hlsUrl = null;
  const subtitles = [];

  const isSubtitle = (u) =>
    /\.(vtt|srt)(\?.*)?$/.test(u) || u.includes(".vtt") || u.includes(".srt");

  try {
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        console.log(`[${providerName}] ✅ HLS: ${hlsUrl}`);
      }
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
      }
      route.continue();
    });

    page.on("request", (req) => {
      const reqUrl = req.url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        console.log(`[${providerName}] ✅ HLS (req): ${hlsUrl}`);
      }
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
      }
    });

    page.on("response", (resp) => {
      const respUrl = resp.url();
      if (!hlsUrl && respUrl.includes(".m3u8")) {
        hlsUrl = respUrl;
        console.log(`[${providerName}] ✅ HLS (resp): ${hlsUrl}`);
      }
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    console.log(`[${providerName}] Page loaded`);

    await page.waitForTimeout(2000);

    const frames = page.frames();
    console.log(`[${providerName}] Frames found: ${frames.length}`);

    for (const frame of frames) {
      try {
        await frame.evaluate(() => {
          const video = document.querySelector("video");
          if (video) video.play();
          const btn = document.querySelector(".play-button, [class*='play'], button");
          if (btn) btn.click();
        });
      } catch (_) {}
    }

    await page.mouse.click(640, 360);
    await page.waitForTimeout(3000);
    await page.mouse.click(640, 360);

    if (!hlsUrl) {
      await page
        .waitForResponse((resp) => resp.url().includes(".m3u8"), { timeout: 20000 })
        .then((resp) => { hlsUrl = resp.url(); })
        .catch(async () => {
          console.warn(`[${providerName}] .m3u8 not detected within 20s`);
          await page.waitForTimeout(3000);
        });
    }

    if (subtitles.length === 0) {
      await page.waitForTimeout(2000);
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

app.get("/extract", async (req, res) => {
  const type    = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season  = req.query.season  ? parseInt(req.query.season)  : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode) : undefined;

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
          const url = type === "tv" ? p.tv(tmdb_id, season, episode) : p.movie(tmdb_id);
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

    const sources = Object.entries(results)
      .filter(([, r]) => r.hls_url)
      .map(([name, r]) => ({ provider: name, url: r.hls_url, quality: "auto" }));

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

app.get("/test-providers", async (req, res) => {
  const urls = [
    "https://vidsrcme.ru",
    "https://vsembed.su",
    "https://vsembed.ru",
    "https://vsdash.net",
    "https://vidlink.pro",
    "https://vidsrc.rip",
    "https://vidsrc.wtf",
    "https://moviesapi.club",
    "https://w1.moviesapi.club",
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
      language:       item.attributes.language,
      language_name:  LANGUAGE_NAMES[item.attributes.language] || item.attributes.language,
      file_id:        item.attributes.files[0].file_id,
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

(async () => {
  browser = await chromium.launch({ headless: true });
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
})();

process.on("SIGINT",  async () => { if (browser) await browser.close(); process.exit(); });
process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(); });
