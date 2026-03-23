const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Simple JSON DB ───────────────────────────────────────────────
function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  return { history: {}, watchlist: {}, episodes: {}, lastPage: 'home' };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon' };

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonRes(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ═══════════════════════════════════════════════════════════════════
// HTTP FETCH HELPER
// ═══════════════════════════════════════════════════════════════════
function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const request = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 8000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redir = response.headers.location;
        if (redir.startsWith('/')) redir = parsed.origin + redir;
        else if (redir.startsWith('//')) redir = parsed.protocol + redir;
        return httpFetch(redir, opts).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ body: data, status: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════
// STREAM EXTRACTORS
// ═══════════════════════════════════════════════════════════════════

// ─── EMBED.SU Extractor ──────────────────────────────────────────
async function extractEmbedSu(tmdbId, type, season, episode) {
  const url = type === 'tv'
    ? `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`
    : `https://embed.su/embed/movie/${tmdbId}`;

  const res = await httpFetch(url, { headers: { 'Referer': 'https://embed.su/' } });
  const html = res.body;

  // Extract vConfig
  const match = html.match(/window\.vConfig\s*=\s*JSON\.parse\(atob\(`(.+?)`\)\)/);
  if (!match) throw new Error('vConfig not found');

  const config = JSON.parse(Buffer.from(match[1], 'base64').toString());

  // Decode hash to get servers
  const firstDecode = Buffer.from(config.hash, 'base64').toString().split('.').map(item =>
    item.split('').reverse().join('')
  );
  const secondDecode = JSON.parse(
    Buffer.from(firstDecode.join('').split('').reverse().join(''), 'base64').toString()
  );

  const servers = secondDecode.map(s => ({ name: s.name, hash: s.hash }));
  const results = [];

  // Try each server to get stream URL
  for (const server of servers.slice(0, 3)) {
    try {
      const streamRes = await httpFetch(`https://embed.su/api/e/${server.hash}`, {
        headers: { 'Referer': 'https://embed.su/' }
      });
      const data = JSON.parse(streamRes.body);
      if (data.source) {
        results.push({
          name: server.name,
          url: data.source,
          subtitles: data.subtitles || [],
          referer: 'https://embed.su/',
        });
      }
    } catch {}
  }
  return results;
}

// ─── VIDLINK.PRO Extractor (via enc-dec.app) ─────────────────────
async function extractVidlink(tmdbId, type, season, episode) {
  try {
    // Get encrypted token from enc-dec.app
    const encRes = await httpFetch(`https://enc-dec.app/api/enc-vidlink?text=${tmdbId}`);
    const encData = JSON.parse(encRes.body);
    if (!encData.result) throw new Error('Encryption failed');

    const encodedId = encodeURIComponent(encData.result);
    const apiUrl = type === 'tv'
      ? `https://vidlink.pro/api/b/tv/${encodedId}/${season}/${episode}`
      : `https://vidlink.pro/api/b/movie/${encodedId}`;

    const streamRes = await httpFetch(apiUrl, {
      headers: { 'Referer': 'https://vidlink.pro/' }
    });

    // Try to decrypt via enc-dec.app
    const decRes = await httpFetch(`https://enc-dec.app/api/dec-vidlink?text=${encodeURIComponent(streamRes.body)}`);
    const decData = JSON.parse(decRes.body);
    if (!decData.result) throw new Error('Decryption failed');

    const parsed = JSON.parse(decData.result);
    if (parsed.stream?.playlist) {
      return [{
        name: 'Vidlink',
        url: parsed.stream.playlist,
        subtitles: (parsed.stream.captions || []).map(c => ({ label: c.language, file: c.url })),
        referer: 'https://vidlink.pro/',
      }];
    }
  } catch (e) {
    console.log('[Vidlink extractor error]', e.message);
  }
  return [];
}

// ─── VIDSRC.RIP Extractor ────────────────────────────────────────
async function extractVidsrcRip(tmdbId, type, season, episode) {
  try {
    const embedUrl = type === 'tv'
      ? `https://vidsrc.rip/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://vidsrc.rip/embed/movie/${tmdbId}`;

    const res = await httpFetch(embedUrl);
    const configMatch = res.body.match(/window\.config\s*=\s*(\{.*?\});/s);
    if (!configMatch) throw new Error('Config not found');

    // Parse config (it's JS object, not JSON — eval-safe parse)
    const configStr = configMatch[1].replace(/'/g, '"').replace(/,\s*}/g, '}');
    let config;
    try { config = JSON.parse(configStr); } catch { throw new Error('Config parse failed'); }

    // Get XOR key
    const keyRes = await httpFetch('https://vidsrc.rip/images/skip-button.png');
    const key = keyRes.body;

    // XOR encrypt to generate VRF
    function xorEnc(key, msg) {
      return Array.from(msg, (c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
      ).join('');
    }

    const apiPath = `/api/source/${config.server}/${tmdbId}`;
    const vrf = encodeURIComponent(Buffer.from(xorEnc(key, decodeURIComponent(apiPath))).toString('base64'));

    let sourceUrl = `https://vidsrc.rip${apiPath}?vrf=${vrf}`;
    if (type === 'tv') sourceUrl += `&s=${season}&e=${episode}`;

    const sourceRes = await httpFetch(sourceUrl, { headers: { 'Referer': embedUrl } });
    const sourceData = JSON.parse(sourceRes.body);

    if (sourceData.sources?.length > 0) {
      return sourceData.sources.map(s => ({
        name: 'VidSrc',
        url: s.file,
        quality: s.label,
        referer: 'https://vidsrc.rip/',
      }));
    }
  } catch (e) {
    console.log('[VidSrc.rip extractor error]', e.message);
  }
  return [];
}

// ─── Master extractor: try all sources ───────────────────────────
async function extractStreams(tmdbId, type, season, episode) {
  const results = await Promise.allSettled([
    extractEmbedSu(tmdbId, type, season, episode),
    extractVidlink(tmdbId, type, season, episode),
    extractVidsrcRip(tmdbId, type, season, episode),
  ]);

  const streams = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      streams.push(...r.value);
    }
  }
  return streams;
}

// ═══════════════════════════════════════════════════════════════════
// HLS PROXY — fetches M3U8 + segments with correct Referer headers
// ═══════════════════════════════════════════════════════════════════
async function proxyHls(targetUrl, referer, res) {
  try {
    const result = await httpFetch(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': new URL(referer).origin,
      }
    });

    let body = result.body;
    const contentType = result.headers['content-type'] || '';

    // If it's an M3U8 playlist, rewrite segment URLs to go through our proxy
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8') || body.includes('#EXTM3U')) {
      // Rewrite relative and absolute URLs in the M3U8 to proxy through us
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      body = body.split('\n').map(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) {
          // Rewrite URI="" in #EXT-X-KEY and similar
          if (line.includes('URI="')) {
            line = line.replace(/URI="([^"]+)"/g, (match, uri) => {
              const absUri = uri.startsWith('http') ? uri : (uri.startsWith('/') ? new URL(targetUrl).origin + uri : baseUrl + uri);
              return `URI="/hls-proxy?url=${encodeURIComponent(absUri)}&ref=${encodeURIComponent(referer)}"`;
            });
          }
          return line;
        }
        // It's a URL line (segment or sub-playlist)
        const absUrl = line.startsWith('http') ? line : (line.startsWith('/') ? new URL(targetUrl).origin + line : baseUrl + line);
        return `/hls-proxy?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
      }).join('\n');

      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } else {
      // Binary segment — pipe it through
      cors(res);
      const headers = { 'Content-Type': contentType || 'video/mp2t', 'Access-Control-Allow-Origin': '*' };
      if (result.headers['content-length']) headers['Content-Length'] = result.headers['content-length'];
      res.writeHead(200, headers);
      res.end(result.body, 'binary');
    }
  } catch (err) {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  }
}

// Binary-safe fetch for video segments
function httpFetchBinary(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const request = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 15000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redir = response.headers.location;
        if (redir.startsWith('/')) redir = parsed.origin + redir;
        return httpFetchBinary(redir, opts).then(resolve).catch(reject);
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ body: Buffer.concat(chunks), status: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
  });
}

async function proxyHlsBinary(targetUrl, referer, res) {
  try {
    const result = await httpFetchBinary(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': new URL(referer).origin,
      }
    });

    const contentType = result.headers['content-type'] || '';
    const bodyStr = result.body.toString('utf8');

    // If M3U8, rewrite URLs (text mode)
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8') || bodyStr.trimStart().startsWith('#EXTM3U')) {
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const rewritten = bodyStr.split('\n').map(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) {
          if (line.includes('URI="')) {
            line = line.replace(/URI="([^"]+)"/g, (m, uri) => {
              const abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? new URL(targetUrl).origin + uri : baseUrl + uri);
              return `URI="/hls-proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(referer)}"`;
            });
          }
          return line;
        }
        const abs = line.startsWith('http') ? line : (line.startsWith('/') ? new URL(targetUrl).origin + line : baseUrl + line);
        return `/hls-proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(referer)}`;
      }).join('\n');

      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(rewritten);
    } else {
      // Binary segment
      cors(res);
      const headers = { 'Content-Type': contentType || 'video/mp2t' };
      if (result.headers['content-length']) headers['Content-Length'] = result.headers['content-length'];
      res.writeHead(200, headers);
      res.end(result.body);
    }
  } catch (err) {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── STREAM EXTRACT API ──────────────────────────────────────────
  if (pathname === '/api/extract') {
    const tmdbId = url.searchParams.get('id');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('s');
    const episode = url.searchParams.get('e');

    if (!tmdbId) return jsonRes(res, { error: 'Missing id' }, 400);

    try {
      const streams = await extractStreams(tmdbId, type, season, episode);
      return jsonRes(res, { streams });
    } catch (err) {
      return jsonRes(res, { error: err.message, streams: [] });
    }
  }

  // ── HLS PROXY ──────────────────────────────────────────────────
  if (pathname === '/hls-proxy') {
    const targetUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('ref') || '';
    if (!targetUrl) { res.writeHead(400); res.end('Missing url'); return; }
    return proxyHlsBinary(targetUrl, referer, res);
  }

  // ── DATA API ───────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/sync') return jsonRes(res, loadDB());
    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.history) db.history = { ...db.history, ...body.history };
      if (body.watchlist) db.watchlist = body.watchlist;
      if (body.episodes) Object.entries(body.episodes).forEach(([k, v]) => { db.episodes[k] = { ...(db.episodes[k] || {}), ...v }; });
      if (body.lastPage) db.lastPage = body.lastPage;
      saveDB(db); return jsonRes(res, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/history') {
      const body = await parseBody(req); const db = loadDB();
      if (body.key && body.data) { db.history[body.key] = { ...db.history[body.key], ...body.data, updated: Date.now() }; saveDB(db); }
      return jsonRes(res, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/watchlist') {
      const body = await parseBody(req); const db = loadDB();
      if (body.key) { if (db.watchlist[body.key]) delete db.watchlist[body.key]; else db.watchlist[body.key] = { ...body.data, added: Date.now() }; saveDB(db); }
      return jsonRes(res, { ok: true, inList: !!db.watchlist[body?.key] });
    }
    if (req.method === 'POST' && pathname === '/api/episodes') {
      const body = await parseBody(req); const db = loadDB();
      if (body.seriesId && body.key) { if (!db.episodes[body.seriesId]) db.episodes[body.seriesId] = {}; db.episodes[body.seriesId][body.key] = true; saveDB(db); }
      return jsonRes(res, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/page') {
      const body = await parseBody(req); const db = loadDB();
      db.lastPage = body.page || 'home'; saveDB(db); return jsonRes(res, { ok: true });
    }
    return jsonRes(res, { error: 'Not found' }, 404);
  }

  // ── Static files ───────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res); }
    else { res.writeHead(404); res.end('Not found'); }
  } catch { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, () => {
  console.log(`OmairMovies server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
