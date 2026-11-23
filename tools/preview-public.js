// Local-only preview of the deployable public directory, with an in-memory mock for /counter.php.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../public');
const port = Number(process.env.AI_SPEND_SITE_PORT || 9023);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.zip': 'application/zip',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const SAFE_ASSET = /^[a-zA-Z0-9._-]{1,80}$/;

function createCounterStore() {
  const state = { views: 0, dailyViews: {}, downloads: {}, updatedAt: null };
  function trimDaily() {
    const keys = Object.keys(state.dailyViews).sort();
    if (keys.length > 90) {
      for (const oldKey of keys.slice(0, keys.length - 90)) {
        delete state.dailyViews[oldKey];
      }
    }
  }
  function snapshot() {
    return {
      views: state.views,
      dailyViews: { ...state.dailyViews },
      downloads: { ...state.downloads },
      updatedAt: state.updatedAt,
    };
  }
  function handle(req, res, url) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    };
    const send = (status, body) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      return send(200, snapshot());
    }
    if (method !== 'POST') {
      return send(405, { error: 'method_not_allowed' });
    }
    const event = url.searchParams.get('event') || '';
    const asset = url.searchParams.get('asset') || '';
    if (event !== 'view' && event !== 'download') {
      return send(400, { error: 'invalid_event' });
    }
    if (event === 'download') {
      if (!SAFE_ASSET.test(asset)) {
        return send(400, { error: 'invalid_asset' });
      }
      if (Object.prototype.hasOwnProperty.call(state.downloads, asset) || Object.keys(state.downloads).length < 64) {
        state.downloads[asset] = (state.downloads[asset] || 0) + 1;
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      state.views += 1;
      state.dailyViews[today] = (state.dailyViews[today] || 0) + 1;
      trimDaily();
    }
    state.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return send(200, snapshot());
  }
  return { handle, snapshot };
}

function createPreviewServer(dir = root) {
  const counter = createCounterStore();
  return http.createServer((req, res) => {
    let url;
    let file;
    try {
      url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/counter.php') {
        return counter.handle(req, res, url);
      }
      if (url.pathname === '/counter-data.json' || url.pathname === '/.htaccess') {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Forbidden');
      }
      file = path.resolve(dir, '.' + decodeURIComponent(url.pathname));
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (file === dir) file = path.join(dir, 'index.html');
    if (!file.startsWith(dir + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      if (!fs.statSync(file).isFile()) throw Error();
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

if (require.main === module) {
  createPreviewServer(root).listen(port, '127.0.0.1', () => {
    console.log(`Public site preview: http://127.0.0.1:${port}`);
  });
}

module.exports = { createPreviewServer, createCounterStore, MIME };
