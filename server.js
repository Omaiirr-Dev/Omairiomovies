const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Simple JSON DB ───────────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { history: {}, watchlist: {}, episodes: {}, lastPage: 'home' };
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ─── MIME types ───────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.ico':'image/x-icon' };

// ─── Helpers ──────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── PROXY: fetch embed page, inject ad-killer ────────────────────
// The ad-killer script runs INSIDE the embed's context — it can nuke
// window.open, kill overlay divs, block popups, etc.
const AD_KILLER = `<script>
// === OMAIRMOVIES AD KILLER — injected by proxy ===
(function(){
  // 1. Nuke window.open completely
  window.open = function(){ return null; };
  Object.defineProperty(window, 'open', { value: function(){ return null; }, writable: false, configurable: false });

  // 2. Kill popup/popunder scripts before they load
  var origCreate = document.createElement;
  document.createElement = function(tag) {
    var el = origCreate.call(document, tag);
    if (tag.toLowerCase() === 'a') {
      // Override click to prevent ad links
      setTimeout(function() {
        if (el.target === '_blank' && el.href && !el.href.includes(location.hostname)) {
          el.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); }, true);
        }
      }, 0);
    }
    return el;
  };

  // 3. Block onclick handlers that open ads
  document.addEventListener('click', function(e) {
    var t = e.target;
    // Block clicks on invisible overlays (ad click-jacking)
    if (t !== document.body) {
      var style = window.getComputedStyle(t);
      if ((style.position === 'fixed' || style.position === 'absolute') &&
          parseFloat(style.opacity) < 0.1 && t.tagName !== 'VIDEO' && t.tagName !== 'IFRAME') {
        e.preventDefault();
        e.stopPropagation();
        t.remove();
        return false;
      }
    }
    // Block links to external ad domains
    var a = t.closest ? t.closest('a') : null;
    if (a && a.target === '_blank' && a.href && !a.href.includes(location.hostname)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // 4. Remove ad overlays every 500ms
  setInterval(function() {
    // Remove invisible overlay divs used for click-jacking
    document.querySelectorAll('div, span, a').forEach(function(el) {
      var s = window.getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'absolute') && s.zIndex > 999 &&
          (parseFloat(s.opacity) < 0.15 || el.offsetWidth >= window.innerWidth * 0.8) &&
          !el.querySelector('video') && !el.querySelector('iframe') && el.id !== 'player') {
        el.remove();
      }
    });
    // Remove popunder iframes
    document.querySelectorAll('iframe').forEach(function(f) {
      var s = window.getComputedStyle(f);
      if (s.width === '0px' || s.height === '0px' || s.display === 'none' || s.visibility === 'hidden' ||
          (parseFloat(s.opacity) < 0.1)) {
        f.remove();
      }
    });
  }, 500);

  // 5. Block beforeunload hijacks
  window.onbeforeunload = null;
  Object.defineProperty(window, 'onbeforeunload', { set: function(){}, get: function(){ return null; } });

  // 6. Block setTimeout/setInterval ad scripts that re-inject
  var origSetTimeout = window.setTimeout;
  window.setTimeout = function(fn, delay) {
    var s = typeof fn === 'function' ? fn.toString() : String(fn);
    if (s.includes('window.open') || s.includes('popunder') || s.includes('pop_') || s.includes('_pop')) return 0;
    return origSetTimeout.apply(this, arguments);
  };
})();
</script>`;

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const request = lib.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': targetUrl,
      },
      timeout: 10000,
    }, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        if (redirectUrl.startsWith('/')) {
          const u = new URL(targetUrl);
          redirectUrl = u.origin + redirectUrl;
        }
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ body: data, statusCode: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── PROXY ROUTE ─────────────────────────────────────────────────
  if (pathname === '/proxy') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) { res.writeHead(400); res.end('Missing url param'); return; }

    try {
      const result = await fetchUrl(targetUrl);
      let html = result.body;

      // Inject ad-killer at the very start of <head> or <html> or just prepend
      if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + AD_KILLER);
      } else if (html.includes('<HEAD>')) {
        html = html.replace('<HEAD>', '<HEAD>' + AD_KILLER);
      } else if (html.includes('<html')) {
        html = html.replace(/<html[^>]*>/, '$&' + AD_KILLER);
      } else {
        html = AD_KILLER + html;
      }

      // Rewrite relative URLs to absolute (so resources still load from original server)
      const origin = new URL(targetUrl).origin;
      html = html.replace(/(href|src|action)="\/(?!\/)/g, `$1="${origin}/`);
      html = html.replace(/(href|src|action)='\/(?!\/)/g, `$1='${origin}/`);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'ALLOWALL',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(html);
    } catch (err) {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    }
    return;
  }

  // ── API Routes ──────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/sync') return json(res, loadDB());

    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.history) db.history = { ...db.history, ...body.history };
      if (body.watchlist) db.watchlist = body.watchlist;
      if (body.episodes) {
        Object.entries(body.episodes).forEach(([k, v]) => {
          db.episodes[k] = { ...(db.episodes[k] || {}), ...v };
        });
      }
      if (body.lastPage) db.lastPage = body.lastPage;
      saveDB(db);
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/history') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.key && body.data) {
        db.history[body.key] = { ...db.history[body.key], ...body.data, updated: Date.now() };
        saveDB(db);
      }
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/watchlist') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.key) {
        if (db.watchlist[body.key]) delete db.watchlist[body.key];
        else db.watchlist[body.key] = { ...body.data, added: Date.now() };
        saveDB(db);
      }
      return json(res, { ok: true, inList: !!db.watchlist[body.key] });
    }

    if (req.method === 'POST' && pathname === '/api/episodes') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.seriesId && body.key) {
        if (!db.episodes[body.seriesId]) db.episodes[body.seriesId] = {};
        db.episodes[body.seriesId][body.key] = true;
        saveDB(db);
      }
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/page') {
      const body = await parseBody(req);
      const db = loadDB();
      db.lastPage = body.page || 'home';
      saveDB(db);
      return json(res, { ok: true });
    }

    return json(res, { error: 'Not found' }, 404);
  }

  // ── Static files ────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else { res.writeHead(404); res.end('Not found'); }
  } catch { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, () => {
  console.log(`OmairMovies server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
