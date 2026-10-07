import crypto from 'node:crypto';
import { state, save, addRun } from './store.js';
import * as wm from './wikimasters.js';

const DELAY_BETWEEN_PACKS_MS = 2_000;
const MIN_INTERVAL_MINUTES = 10;

let timer = null;
let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isRunning() {
  return running;
}

function clampSettings() {
  const s = state.settings;
  s.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.min(24 * 60, Math.round(Number(s.intervalMinutes) || 50)));
  s.packsPerRun = Math.max(1, Math.min(20, Math.round(Number(s.packsPerRun) || 1)));
}

/** (Re)programme le prochain run automatique en fonction de nextRunAt. */
export function schedule() {
  clearTimeout(timer);
  timer = null;
  if (!state.nextRunAt) state.nextRunAt = Date.now() + state.settings.intervalMinutes * 60_000;
  save();
  if (state.settings.paused || state.blocked) return;
  const delay = Math.max(1_000, state.nextRunAt - Date.now());
  // setTimeout est limité à ~24,8 jours : on recalcule si besoin.
  timer = setTimeout(() => {
    if (Date.now() + 500 < state.nextRunAt) return schedule();
    runOnce('scheduled').catch((err) => console.error('[bot] run crashed:', err));
  }, Math.min(delay, 2 ** 31 - 1));
  timer.unref?.();
}

export async function runOnce(trigger = 'manual') {
  if (running) return null;
  running = true;
  state.lastRunStartedAt = Date.now();
  const run = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    finishedAt: null,
    trigger,
    status: 'success',
    packs: 0,
    cards: [],
    error: null,
  };
  let nextRunAt = Date.now() + state.settings.intervalMinutes * 60_000;

  try {
    if (!wm.hasCredentials()) {
      throw new wm.WMError('reconnect', 'No WikiMasters session configured. Reconnect your session in the settings.');
    }

    let toOpen = state.settings.packsPerRun;
    const available = await wm.getAvailablePacks();
    if (available !== null) toOpen = Math.min(toOpen, available);

    for (let i = 0; i < toOpen; i++) {
      if (i > 0) await sleep(DELAY_BETWEEN_PACKS_MS);
      const cards = await wm.openPack();
      run.packs += 1;
      run.cards.push(...cards);
    }
    if (run.packs === 0) run.status = 'no_packs';
  } catch (err) {
    if (!(err instanceof wm.WMError)) console.error('[bot] unexpected error:', err);
    run.error = err.message;
    switch (err.kind) {
      case 'reconnect':
        run.status = 'needs_reconnect';
        state.blocked = 'reconnect';
        break;
      case 'verification':
        // On ne contourne pas la vérification anti-bot : le bot se met en attente
        // jusqu'à ce que l'utilisateur l'ait faite lui-même sur le site.
        run.status = 'verification';
        state.blocked = 'verification';
        break;
      case 'rate_limit':
        run.status = run.packs > 0 ? 'partial' : 'rate_limited';
        if (err.retryAt) nextRunAt = Math.max(nextRunAt, err.retryAt + 30_000);
        break;
      case 'no_packs':
        run.status = run.packs > 0 ? 'success' : 'no_packs';
        run.error = run.packs > 0 ? null : err.message;
        break;
      default:
        run.status = 'error';
    }
  } finally {
    run.finishedAt = Date.now();
    state.stats.packsOpened += run.packs;
    state.stats.cardsFound += run.cards.length;
    if (run.packs > 0 || run.status === 'success') state.stats.runsCompleted += 1;
    addRun(run);
    state.nextRunAt = nextRunAt;
    running = false;
    console.log(`[bot] ${trigger} run: ${run.status}, ${run.packs} pack(s), ${run.cards.length} card(s)${run.error ? ` — ${run.error}` : ''}`);
    schedule();
  }
  return run;
}

export function setPaused(paused) {
  state.settings.paused = paused;
  if (!paused) {
    // "Reprendre" vaut aussi confirmation que la vérification humaine a été faite.
    if (state.blocked === 'verification') state.blocked = null;
    if (state.nextRunAt && state.nextRunAt < Date.now()) state.nextRunAt = Date.now() + 5_000;
  }
  schedule();
}

export function updateSettings({ intervalMinutes, packsPerRun }) {
  const oldInterval = state.settings.intervalMinutes;
  if (intervalMinutes !== undefined) state.settings.intervalMinutes = intervalMinutes;
  if (packsPerRun !== undefined) state.settings.packsPerRun = packsPerRun;
  clampSettings();
  if (state.settings.intervalMinutes !== oldInterval) {
    const base = state.runs[0]?.finishedAt ?? Date.now();
    state.nextRunAt = Math.max(Date.now() + 5_000, base + state.settings.intervalMinutes * 60_000);
  }
  schedule();
}

export function updateSession({ mode, cookie, accessToken, refreshToken, username }) {
  const a = state.auth;
  if (mode === 'cookie' || mode === 'token') a.mode = mode;
  if (typeof cookie === 'string' && cookie.trim()) a.cookie = cookie.trim().replace(/^cookie:\s*/i, '');
  if (typeof accessToken === 'string' && accessToken.trim()) a.accessToken = accessToken.trim().replace(/^bearer\s+/i, '');
  if (typeof refreshToken === 'string' && refreshToken.trim()) a.refreshToken = refreshToken.trim();
  if (typeof username === 'string') a.username = username.trim().slice(0, 64);
  if (state.blocked === 'reconnect' && wm.hasCredentials()) state.blocked = null;
  schedule();
}

export function clearSession() {
  Object.assign(state.auth, { cookie: '', accessToken: '', refreshToken: '' });
  schedule();
}

export function start() {
  clampSettings();
  if (state.nextRunAt && state.nextRunAt < Date.now()) state.nextRunAt = Date.now() + 10_000;
  schedule();
}
