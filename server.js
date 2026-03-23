const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists (Railway volume mount point)
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Simple JSON DB (single global store — one user, all devices) ───
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { history: {}, watchlist: {}, episodes: {}, lastPage: 'home' };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── MIME types ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ─── Parse JSON body ──────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ─── CORS headers ─────────────────────────────────────────────────
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

// ─── Server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API Routes ──────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {

    // GET /api/sync — load all data
    if (req.method === 'GET' && pathname === '/api/sync') {
      return json(res, loadDB());
    }

    // POST /api/sync — save all data
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

    // POST /api/history — update a single history entry
    if (req.method === 'POST' && pathname === '/api/history') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.key && body.data) {
        db.history[body.key] = { ...db.history[body.key], ...body.data, updated: Date.now() };
        saveDB(db);
      }
      return json(res, { ok: true });
    }

    // POST /api/watchlist — toggle watchlist item
    if (req.method === 'POST' && pathname === '/api/watchlist') {
      const body = await parseBody(req);
      const db = loadDB();
      if (body.key) {
        if (db.watchlist[body.key]) {
          delete db.watchlist[body.key];
        } else {
          db.watchlist[body.key] = { ...body.data, added: Date.now() };
        }
        saveDB(db);
      }
      return json(res, { ok: true, inList: !!db.watchlist[body.key] });
    }

    // POST /api/episodes — mark episode watched
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

    // POST /api/page — save last visited page
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

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`OmairMovies server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
