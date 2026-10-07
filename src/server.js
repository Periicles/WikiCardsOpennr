import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { state } from './store.js';
import * as bot from './bot.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'wmb_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

if (!config.dashboardPassword) {
  console.error('DASHBOARD_PASSWORD est obligatoire (voir .env.example).');
  process.exit(1);
}
const secret = config.sessionSecret || crypto.randomBytes(32).toString('hex');
if (!config.sessionSecret) console.warn('[server] SESSION_SECRET absent : les sessions du dashboard expireront au redémarrage.');

// ---------- Session du dashboard (cookie signé HMAC) ----------

const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

function makeSessionCookie() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const attrs = [`${COOKIE_NAME}=${exp}.${sign(exp)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

function isAuthed(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE_NAME.length + 1).split('.');
  if (!exp || !sig) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) && Number(exp) > Date.now();
}

function passwordMatches(pw) {
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(config.dashboardPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Helpers HTTP ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function serveStatic(res, route) {
  const [file, type] = STATIC[route];
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new Error('Content-Type must be application/json'));
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function publicState() {
  return {
    serverTime: Date.now(),
    username: state.auth.username || null,
    session: {
      mode: state.auth.mode,
      hasCookie: Boolean(state.auth.cookie),
      hasAccessToken: Boolean(state.auth.accessToken),
      hasRefreshToken: Boolean(state.auth.refreshToken),
    },
    blocked: state.blocked,
    paused: state.settings.paused,
    running: bot.isRunning(),
    nextRunAt: state.nextRunAt,
    previousRunAt: state.runs[0]?.finishedAt ?? null,
    settings: { intervalMinutes: state.settings.intervalMinutes, packsPerRun: state.settings.packsPerRun },
    stats: state.stats,
    runs: state.runs.slice(0, 30),
  };
}

// ---------- Routes ----------

const failedLogins = new Map();

async function handleApi(req, res, route) {
  if (route === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress;
    const fails = failedLogins.get(ip) || 0;
    if (fails >= 5) await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** (fails - 5))));
    const { password } = await readJson(req);
    if (!password || !passwordMatches(password)) {
      failedLogins.set(ip, fails + 1);
      return send(res, 401, { error: 'Mot de passe incorrect' });
    }
    failedLogins.delete(ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': makeSessionCookie() });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Unauthorized' });

  if (route === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (route === '/api/state' && req.method === 'GET') return send(res, 200, publicState());

  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const body = await readJson(req);

  switch (route) {
    case '/api/run':
      if (bot.isRunning()) return send(res, 409, { error: 'Un run est déjà en cours' });
      bot.runOnce('manual').catch((err) => console.error('[bot] manual run crashed:', err));
      return send(res, 202, publicState());
    case '/api/pause':
      bot.setPaused(true);
      return send(res, 200, publicState());
    case '/api/resume':
      bot.setPaused(false);
      return send(res, 200, publicState());
    case '/api/settings':
      bot.updateSettings({ intervalMinutes: body.intervalMinutes, packsPerRun: body.packsPerRun });
      return send(res, 200, publicState());
    case '/api/session':
      bot.updateSession(body);
      return send(res, 200, publicState());
    case '/api/session/clear':
      bot.clearSession();
      return send(res, 200, publicState());
    default:
      return send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  try {
    if (route === '/healthz') return send(res, 200, { ok: true });
    if (route.startsWith('/api/')) return await handleApi(req, res, route);
    if (req.method !== 'GET' || !STATIC[route]) return send(res, 404, 'Not found');
    if (route === '/' && !isAuthed(req)) return send(res, 302, '', { Location: '/login' });
    if (route === '/login' && isAuthed(req)) return send(res, 302, '', { Location: '/' });
    return serveStatic(res, route);
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message });
  }
});

bot.start();
server.listen(config.port, () => {
  console.log(`[server] WikiMasters Bot dashboard on http://localhost:${config.port}`);
  console.log(`[server] WikiMasters API: ${config.wm.baseUrl}${config.wm.openPackPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
