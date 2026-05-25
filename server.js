require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PROVIDERS = {
  vidplay: {
    baseUrl: 'https://vidplay.site',
    searchPath: '/search?q=',
    embedPattern: /vidplay\.site\/e\/([a-zA-Z0-9]+)/i,
    servers: ['vidplay.site', 'vidplay.lol', 'vidplay.online']
  },
  vidsrc: {
    baseUrl: 'https://vidsrc.me',
    searchPath: '/search?q=',
    embedPattern: /vidsrc\.me\/embed\/([a-zA-Z0-9]+)/i,
    servers: ['vidsrc.me', 'vidsrc.net', 'vidsrc.xyz', 'vidsrc.cc']
  },
  vidstream: {
    baseUrl: 'https://vidstream.to',
    searchPath: '/search?q=',
    embedPattern: /vidstream\.to\/e\/([a-zA-Z0-9]+)/i,
    servers: ['vidstream.to', 'vidstream.pro']
  },
  moviesapi: {
    baseUrl: 'https://moviesapi.club',
    searchPath: '/search?q=',
    embedPattern: /moviesapi\.club\/movie\/([0-9]+)/i,
    servers: ['moviesapi.club']
  },
  smashy: {
    baseUrl: 'https://player.smashy.stream',
    searchPath: '/search?q=',
    embedPattern: /player\.smashy\.stream\/movie\/([0-9]+)/i,
    servers: ['player.smashy.stream']
  },
  embedsu: {
    baseUrl: 'https://embed.su',
    searchPath: '/search?q=',
    embedPattern: /embed\.su\/embed\/movie\/([0-9]+)/i,
    servers: ['embed.su']
  },
  autoembed: {
    baseUrl: 'https://autoembed.cc',
    searchPath: '/search?q=',
    embedPattern: /autoembed\.cc\/embed\/movie\/([0-9]+)/i,
    servers: ['autoembed.cc', 'autoembed.xyz']
  }
};

let browser = null;

async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
  }
  return browser;
}

async function scrapeWithPlaywright(url, selector = 'body') {
  const bw = await initBrowser();
  const context = await bw.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.1.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });

  const intercepted = new Set();

  context.on('request', (request) => {
    const u = request.url();
    if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
      intercepted.add(u);
    }
  });

  try {
    const page = await context.newPage();

    page.on('request', (request) => {
      const u = request.url();
      if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
        intercepted.add(u);
      }
    });

    await page.route('**/*', (route) => {
      const u = route.request().url();
      const blocked = [
        'googlesyndication', 'doubleclick', 'adservice', 'google-analytics',
        'googletagmanager', 'facebook.net', 'amazon-adsystem', 'adnxs',
        'rubiconproject', 'openx', 'pubmatic', 'criteo', 'taboola', 'outbrain',
        'popads', 'popcash', 'propellerads', 'exoclick', 'trafficjunky',
        'juicyads', 'hilltopads', 'adsterra', 'monetag',
      ];
      if (blocked.some((b) => u.includes(b))) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    const deadline = Date.now() + 12000;
    while (intercepted.size === 0 && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    const htmlContent = await page.content();
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');

    await page.close();
    await context.close();

    return {
      content: htmlContent,
      text,
      success: true,
      interceptedStreams: [...intercepted],
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function extractVideoLinks(content, interceptedStreams = []) {
  const links = [...interceptedStreams];
  const patterns = [
    /(https?:\/\/[^\s\"]+\.m3u8[^\s\"]*)/gi,
    /(https?:\/\/[^\s\"]+\.mp4[^\s\"]*)/gi,
    /["'](https?:\/\/[^"']+\/e\/[^"']+)["']/gi,
    /["'](https?:\/\/[^"']+\/embed\/[^"']+)["']/gi,
    /["'](https?:\/\/[^"']+\/v\/[^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url && !links.includes(url)) {
        links.push(url);
      }
    }
  }

  return links;
}

app.get('/api/scrape', async (req, res) => {
  const { url, provider } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  try {
    const result = await scrapeWithPlaywright(url);
    const videoLinks = extractVideoLinks(result.content, result.interceptedStreams);
    
    res.json({
      success: true,
      url,
      provider: provider || 'unknown',
      videoLinks,
      textPreview: result.text.substring(0, 500),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      url
    });
  }
});

app.get('/api/scrape-all', async (req, res) => {
  const { query, type = 'movie' } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }
  
  const results = [];
  
  for (const [name, config] of Object.entries(PROVIDERS)) {
    for (const server of config.servers) {
      try {
        const searchUrl = `https://${server}${config.searchPath}${encodeURIComponent(query)}`;
        const result = await scrapeWithPlaywright(searchUrl);
        const videoLinks = extractVideoLinks(result.content, result.interceptedStreams);
        
        if (videoLinks.length > 0) {
          results.push({
            provider: name,
            server,
            videoLinks,
            searchUrl,
            found: true
          });
        }
      } catch (error) {
        results.push({
          provider: name,
          server,
          error: error.message,
          found: false
        });
      }
    }
  }
  
  res.json({
    success: true,
    query,
    type,
    totalProviders: Object.keys(PROVIDERS).length,
    results
  });
});

app.get('/api/providers', (req, res) => {
  res.json({
    success: true,
    providers: Object.entries(PROVIDERS).map(([name, config]) => ({
      name,
      servers: config.servers,
      baseUrl: config.baseUrl
    }))
  });
});

app.get('/api/search/:provider', async (req, res) => {
  const { provider } = req.params;
  const { q } = req.query;
  
  if (!PROVIDERS[provider]) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  const config = PROVIDERS[provider];
  const results = [];
  
  for (const server of config.servers) {
    try {
      const searchUrl = `https://${server}${config.searchPath}${encodeURIComponent(q)}`;
      const result = await scrapeWithPlaywright(searchUrl);
      const videoLinks = extractVideoLinks(result.content, result.interceptedStreams);
      
      results.push({
        server,
        searchUrl,
        videoLinks,
        found: videoLinks.length > 1
      });
    } catch (error) {
      results.push({
        server,
        error: error.message,
        found: false
      });
    }
  }
  
  res.json({
    success: true,
    provider,
    query: q,
    results
  });
});

app.get('/api/embed/:provider', async (req, res) => {
  const { provider } = req.params;
  const { id, tmdb } = req.query;
  
  if (!PROVIDERS[provider]) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  
  const config = PROVIDERS[provider];
  const embedUrls = [];
  
  for (const server of config.servers) {
    let embedUrl;
    if (tmdb) {
      embedUrl = `https://${server}/embed/movie/${tmdb}`;
    } else if (id) {
      embedUrl = `https://${server}/e/${id}`;
    } else {
      continue;
    }
    
    try {
      const result = await scrapeWithPlaywright(embedUrl);
      const videoLinks = extractVideoLinks(result.content, result.interceptedStreams);
      
      embedUrls.push({
        server,
        embedUrl,
        videoLinks,
        found: videoLinks.length > 1
      });
    } catch (error) {
      embedUrls.push({
        server,
        embedUrl,
        error: error.message,
        found: false
      });
    }
  }
  
  res.json({
    success: true,
    provider,
    id: id || tmdb,
    results: embedUrls
  });
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    port: PORT,
    providers: Object.keys(PROVIDERS),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>Video Scraper API</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .endpoint { background: #16213e; padding: 15px; margin: 10px 0; border-radius: 8px; }
    code { background: #0f3460; padding: 2px 8px; border-radius: 4px; color: #e94560; }
    .provider { display: inline-block; background: #533483; color: white; padding: 4px 12px; margin: 4px; border-radius: 20px; font-size: 14px; }
    a { color: #00d4ff; }
  </style>
</head>
<body>
  <h1>Video Scraper API</h1>
  <p>רץ על פורט: ${PORT}</p>
  
  <h2>ספקים זמינים:</h2>
  ${Object.entries(PROVIDERS).map(([name, config]) => 
    `<span class="provider">${name} (${config.servers.length} שרתים)</span>`
  ).join('')}
  
  <h2>נקודות קצה:</h2>
  <div class="endpoint">
    <code>GET /api/scrape?url=&lt;URL&gt;</code> - סריקת URL בודד
  </div>
  <div class="endpoint">
    <code>GET /api/scrape-all?query=&lt;QUERY&gt;</code> - סריקה בכל הספקים
  </div>
  <div class="endpoint">
    <code>GET /api/search/:provider?q=&lt;QUERY&gt;</code> - חיפוש בספק ספציפי
  </div>
  <div class="endpoint">
    <code>GET /api/embed/:provider?tmdb=&lt;ID&gt;</code> - שליפת embed לפי TMDB ID
  </div>
  <div class="endpoint">
    <code>GET /api/providers</code> - רשימת כל הספקים
  </div>
  <div class="endpoint">
    <code>GET /health</code> - בדיקת תקינות (Railway)
  </div>
  
  <h2>דוגמאות:</h2>
  <ul>
    <li><a href="/api/scrape?url=https://vidsrc.me">/api/scrape?url=https://vidsrc.me</a></li>
    <li><a href="/api/scrape-all?query=batman">/api/scrape-all?query=batman</a></li>
    <li><a href="/api/providers">/api/providers</a></li>
  </ul>
</body>
</html>
  `);
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://0.1.0.0:${PORT}`);
  console.log(`📊 Health check: http://0.1.0.0:${PORT}/health`);
  console.log(`🎬 Providers: ${Object.keys(PROVIDERS).join(', ')}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (browser) await browser.close();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  if (browser) await browser.close();
  server.close(() => {
    process.exit(0);
  });
});
