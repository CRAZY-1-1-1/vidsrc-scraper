// utils/tvSubtitles.js — Fixed: removed shadowed variable, replaced
// removed node-fetch .buffer() with arrayBuffer(), hardened parsing.
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "stream";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randomSleep(min = 4000, max = 6000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`⏳ Sleeping for ${delay}ms`);
  return sleep(delay);
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Connection: "keep-alive",
};

function buildZipUrlFromTitle(title) {
  console.log("Title:", title);
  const clean = title.replace(/[()]/g, "").trim();
  console.log("Cleaned Title:", clean);

  const match = clean.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);
  if (!match) {
    console.warn("⚠️ Unexpected title format. Using fallback.");
    const fallback = clean.replace(/\s+/g, "_") + ".en.zip";
    return `https://www.tvsubtitles.net/files/${fallback}`;
  }
  const [, showName, episodeCode, releaseInfo] = match;
  const fileName = `${showName}_${episodeCode}_${releaseInfo}.en.zip`;
  return `https://www.tvsubtitles.net/files/${encodeURIComponent(fileName)}`;
}

async function searchTVShow(title) {
  try {
    const searchRes = await fetch("https://www.tvsubtitles.net/search.php", {
      method: "POST",
      headers: { ...COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ qs: title }).toString(),
    });
    const html = await searchRes.text();
    const $ = cheerio.load(html);
    const link = $("a[href^='/tvshow-']")
      .filter(function () {
        return $(this).text().toLowerCase().includes(title.toLowerCase());
      })
      .first()
      .attr("href");
    if (!link) throw new Error("No TV show found");
    const idMatch = link.match(/tvshow-(\d+)\.html/);
    if (!idMatch) throw new Error("Show ID not found");
    return idMatch[1];
  } catch (err) {
    console.error("❌ TVSubtitles Search Error:", err.message);
    return null;
  }
}

async function getSubtitleIDAndEpisodeTitle(episodePageId) {
  try {
    const url = `https://www.tvsubtitles.net/episode-${episodePageId}-en.html`;
    console.log("📄 Fetching episode page:", url);
    const res = await fetch(url, { headers: COMMON_HEADERS });
    const html = await res.text();
    const $ = cheerio.load(html);
    const anchor = $("a[href^='/subtitle-']").first();
    if (!anchor.length) { console.warn("❌ No subtitle link found"); return null; }
    const subtitleId = anchor.attr("href")?.match(/subtitle-(\d+)\.html/)?.[1];
    const h5Text = anchor.find("h5").clone().find("img").remove().end()
      .text().replace(/\s+/g, " ").trim();
    if (!h5Text || !subtitleId) { console.warn("❌ Could not extract subtitle title or ID"); return null; }
    console.log("✅ Subtitle ID:", subtitleId);
    console.log("📝 Subtitle Title:", h5Text);
    return { subtitleId, subtitleTitle: h5Text };
  } catch (err) {
    console.error("❌ Subtitle Page Scrape Error:", err.message);
    return null;
  }
}

async function getEpisodePageId(showId, seasonNumber, episodeNumber) {
  try {
    const url = `https://www.tvsubtitles.net/tvshow-${showId}-${seasonNumber}.html`;
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (!res.ok) throw new Error("Failed to fetch season page");
    const html = await res.text();
    const $ = cheerio.load(html);

    let episodePageId = null;
    $("table.tableauto tr").each((_, row) => {
      const episodeCell = $(row).find("td").first().text().trim();
      const rowMatch = episodeCell.match(/^(\d+)x(\d+)$/);
      if (
        rowMatch &&
        parseInt(rowMatch[1], 10) === parseInt(seasonNumber, 10) &&
        parseInt(rowMatch[2], 10) === parseInt(episodeNumber, 10)
      ) {
        const episodeLink = $(row).find("td").eq(1).find("a").attr("href");
        const linkMatch = episodeLink?.match(/episode-(\d+)\.html/);
        if (linkMatch) {
          episodePageId = linkMatch[1];
          console.log(`🎯 Episode Page ID: ${episodePageId}`);
        }
      }
    });

    if (!episodePageId) throw new Error("Episode Page ID not found");
    return episodePageId;
  } catch (err) {
    console.error("❌ TVSubtitles Season Scrape Error:", err.message);
    return null;
  }
}

async function getActualFilenameFromSubtitlePage(subtitleId) {
  try {
    const url = `https://www.tvsubtitles.net/subtitle-${subtitleId}.html`;
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (!res.ok) throw new Error("Failed to fetch subtitle page");
    const html = await res.text();
    const $ = cheerio.load(html);
    let filename = null;
    $(".subtitle_grid div").each((i, el) => {
      const label = $(el).text().trim().toLowerCase();
      if (label === "filename:") filename = $(el).next().text().trim();
    });
    if (!filename) { console.warn("⚠️ Could not find filename on subtitle page"); return null; }
    return filename;
  } catch (err) {
    console.error("❌ Subtitle Download Page Scrape Error:", err.message);
    return null;
  }
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let result = "";
    stream.on("data", (c) => (result += c.toString()));
    stream.on("end", () => resolve(result));
    stream.on("error", reject);
  });
}

function extractReleaseFromFilename(filename) {
  const hyphenParts = filename.split(" - ");
  const lastPart = hyphenParts[2] || "";
  const noExt = lastPart.replace(/\.en\.srt$|\.srt$/, "").trim();
  const parts = noExt.split(".");
  const hasResolution = parts.some((p) => /\d{3,4}p/.test(p));
  if (hasResolution) {
    const resIndex = parts.findIndex((p) => /\d{3,4}p/.test(p));
    const [res, rip, group] = parts.slice(resIndex);
    if (group) return `${res} ${rip}.${group}`;
    if (rip) return `${res} ${rip}`;
    return res;
  }
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (secondLast && secondLast !== last) return `${secondLast}.${last}`;
  return last;
}

async function downloadAndConvertToVTT(zipUrl) {
  try {
    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) throw new Error("Failed to download subtitle ZIP");
    // node-fetch v3 removed .buffer() — use arrayBuffer()
    const ab = await zipRes.arrayBuffer();
    const zipBuffer = Buffer.from(ab);
    const zip = new AdmZip(zipBuffer);
    const srtEntry = zip.getEntries().find((e) => e.entryName.endsWith(".srt"));
    if (!srtEntry) throw new Error("No .srt file found in ZIP");
    const srtBuffer = srtEntry.getData();
    const srtStream = Readable.from(srtBuffer);
    const vttStream = srtStream.pipe(srt2vtt());
    const vttText = await streamToString(vttStream);
    console.log("✅ Converted VTT (preview):\n", vttText.slice(0, 200));
    return vttText;
  } catch (err) {
    console.error("❌ Conversion error:", err.message);
    return null;
  }
}

export async function getTVSubtitleVTT(title, season, episode) {
  const showId = await searchTVShow(title);
  if (!showId) return null;
  await randomSleep();
  const episodeId = await getEpisodePageId(showId, season, episode);
  if (!episodeId) return null;
  await randomSleep();
  const subtitleMeta = await getSubtitleIDAndEpisodeTitle(episodeId);
  if (!subtitleMeta) return null;
  const { subtitleId, subtitleTitle } = subtitleMeta;
  const actualFilename = await getActualFilenameFromSubtitlePage(subtitleId);
  let finalTitle = subtitleTitle;
  if (actualFilename) {
    const correctRelease = extractReleaseFromFilename(actualFilename);
    const m = subtitleTitle.match(/\(([^)]+)\)/);
    const currentRelease = m ? m[1] : null;
    if (currentRelease) {
      if (currentRelease.includes(".") || currentRelease.includes(" ")) {
        if (currentRelease !== correctRelease) {
          finalTitle = subtitleTitle.replace(/\([^)]+\)/, `(${correctRelease})`);
        }
      } else {
        finalTitle = subtitleTitle.replace(/\([^)]+\)/, `(${currentRelease})`);
      }
    }
  }
  await randomSleep();
  const zipUrl = buildZipUrlFromTitle(finalTitle);
  await randomSleep();
  console.log("📦 Zip URL:", zipUrl);
  return await downloadAndConvertToVTT(zipUrl);
}
