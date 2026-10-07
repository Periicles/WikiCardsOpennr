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
  if (req.url === '/api/auth/refresh') return json(400, { error: 'invalid_grant' });
  if (req.url !== '/api/packs/open') return json(404, {});
  if (!/sid=abc/.test(req.headers.cookie || '')) return json(401, { error: 'unauthorized' });
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

test('dead refresh token in token mode', async () => {
  bot.updateSession({ mode: 'token', accessToken: 'expired', refreshToken: 'dead' });
  const run = await bot.runOnce('scheduled');
  assert.equal(run.status, 'needs_reconnect');
  assert.equal(run.error, 'Refresh rejected (400): refresh token is dead. Reconnect your session.');
});
