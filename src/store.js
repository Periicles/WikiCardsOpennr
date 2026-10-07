import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_RUNS = 100;
const file = path.join(config.dataDir, 'state.json');

function defaults() {
  return {
    settings: {
      intervalMinutes: config.defaults.intervalMinutes,
      packsPerRun: config.defaults.packsPerRun,
      paused: false,
    },
    // Session WikiMasters. Jamais renvoyée telle quelle au navigateur.
    auth: { mode: 'cookie', cookie: '', accessToken: '', refreshToken: '', username: '' },
    // null | 'reconnect' | 'verification' : le bot attend une action humaine.
    blocked: null,
    stats: { packsOpened: 0, cardsFound: 0, runsCompleted: 0 },
    nextRunAt: null,
    lastRunStartedAt: null,
    runs: [],
  };
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const d = defaults();
    return {
      ...d,
      ...saved,
      settings: { ...d.settings, ...saved.settings },
      auth: { ...d.auth, ...saved.auth },
      stats: { ...d.stats, ...saved.stats },
    };
  } catch {
    return defaults();
  }
}

export const state = load();

export function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function addRun(run) {
  state.runs.unshift(run);
  state.runs.length = Math.min(state.runs.length, MAX_RUNS);
}
