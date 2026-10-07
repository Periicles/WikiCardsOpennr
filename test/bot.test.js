import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Faux serveur WikiMasters : comportement piloté par `mode`.
let mode = 'ok';
let opened = 0;
const mock = http.createServer((req, res) => {
  const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.url === '/auth/v1/token?grant_type=refresh_token') {
    if (req.headers.apikey !== 'anon-key') return json(401, { message: 'No API key' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (JSON.parse(body).refresh_token !== 'good') return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' });
      json(200, { access_token: 'fresh', refresh_token: 'good2', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    });
    return;
  }
  if (req.url !== '/api/packs/open') return json(404, {});
  if (!/sid=abc/.test(req.headers.cookie || '') && req.headers.authorization !== 'Bearer fresh') return json(401, { error: 'unauthorized' });
  if (mode === 'verify') return json(403, { error: 'Vérification anti-bot requise', human_verification_required: true, code: 'human_verification_required' });
  if (mode === 'limit' && opened >= 2) return json(429, { error: 'Limite', rate_limited: true, retry_after: new Date(Date.now() + 3600e3).toISOString() });
  opened++;
  json(200, { cards: [
    { title: 'Colt Canada', rarity: 'peu commune' },
    { name: 'Odon de Crussol', rarity: 'C' },
    { article: { title: 'GHK-Cu', url: 'https://fr.wikipedia.org/wiki/GHK-Cu' }, rarity: 'rare' },
  ] }, { 'Set-Cookie': 'sid=abc; Path=/; HttpOnly' });
});

let bot, store;
before(async () => {
  await new Promise((r) => mock.listen(0, r));
  process.env.WM_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.WM_SUPABASE_URL = `http://localhost:${mock.address().port}`;
  process.env.WM_SUPABASE_ANON_KEY = 'anon-key';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-'));
  bot = await import('../src/bot.js');
  store = await import('../src/store.js');
});
after(() => mock.close());

test('needs reconnect without session', async () => {
  const run = await bot.runOnce('manual');
  assert.equal(run.status, 'needs_reconnect');
  assert.equal(store.state.blocked, 'reconnect');
});

test('opens packs and normalizes cards', async () => {
  bot.updateSession({ mode: 'cookie', cookie: 'Cookie: sid=abc', username: 'Periicles' });
  assert.equal(store.state.blocked, null);
  bot.updateSettings({ packsPerRun: 2 });
  const run = await bot.runOnce('manual');
  assert.equal(run.status, 'success');
  assert.equal(run.packs, 2);
  assert.deepEqual(run.cards.slice(0, 3).map((c) => c.rarity), ['PC', 'C', 'R']);
  assert.equal(run.cards[2].url, 'https://fr.wikipedia.org/wiki/GHK-Cu');
  assert.equal(store.state.stats.packsOpened, 2);
});

test('429 keeps opened packs and schedules after retry_after', async () => {
  mode = 'limit'; opened = 0;
  bot.updateSettings({ packsPerRun: 4 });
  const run = await bot.runOnce('scheduled');
  assert.equal(run.status, 'partial');
  assert.equal(run.packs, 2);
  assert.match(run.error, /^HTTP 429/);
  assert.ok(store.state.nextRunAt > Date.now() + 3500e3);
});

test('anti-bot verification blocks until the user resumes', async () => {
  mode = 'verify';
  const run = await bot.runOnce('scheduled');
  assert.equal(run.status, 'verification');
  assert.match(run.error, /^AUTH 403 \(mode=cookie\)/);
  assert.equal(store.state.blocked, 'verification');
  bot.setPaused(false);
  assert.equal(store.state.blocked, null);
  bot.setPaused(true);
});

test('parses a Supabase auth cookie (base64- prefix, split in chunks)', async () => {
  const wm = await import('../src/wikimasters.js');
  const session = { access_token: 'a.b.c', refresh_token: 'good', expires_at: 1791379473, user: { user_metadata: { username: 'Tester' } } };
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const pasted = `${value.slice(0, 40)}\n${value.slice(40)}`;
  assert.deepEqual(wm.parseSupabaseSession(pasted), { accessToken: 'a.b.c', refreshToken: 'good', expiresAt: 1791379473000, username: 'Tester' });
  assert.throws(() => wm.parseSupabaseSession('not a session'), /illisible/);
});

test('expired Supabase session is refreshed before opening packs', async () => {
  mode = 'ok';
  const session = { access_token: 'stale', refresh_token: 'good', expires_at: Math.floor(Date.now() / 1000) - 10, user: { user_metadata: { username: 'Tester' } } };
  bot.updateSession({ supabaseSession: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` });
  assert.equal(store.state.auth.mode, 'token');
  bot.updateSettings({ packsPerRun: 1 });
  const run = await bot.runOnce('manual');
  assert.equal(run.status, 'success');
  assert.equal(store.state.auth.accessToken, 'fresh');
  assert.equal(store.state.auth.refreshToken, 'good2');
  assert.ok(store.state.auth.expiresAt > Date.now());
});

test('dead refresh token in token mode', async () => {
  bot.updateSession({ mode: 'token', accessToken: 'expired', refreshToken: 'dead' });
  const run = await bot.runOnce('scheduled');
  assert.equal(run.status, 'needs_reconnect');
  assert.equal(run.error, 'Refresh rejected (400): refresh token is dead. Reconnect your session.');
});
