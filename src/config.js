import fs from 'node:fs';
import path from 'node:path';

// Charge un éventuel fichier .env (format KEY=VALUE) sans dépendance externe.
function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export const config = {
  port: int(env.PORT, 3000),
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  cookieSecure: env.COOKIE_SECURE === 'true',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  wm: {
    baseUrl: (env.WM_BASE_URL || 'https://www.wiki-masters.com').replace(/\/+$/, ''),
    openPackPath: env.WM_OPEN_PACK_PATH || '/api/packs/open',
    packsStatusPath: env.WM_PACKS_STATUS_PATH || '',
    refreshPath: env.WM_REFRESH_PATH || '/api/auth/refresh',
    // Si WikiMasters utilise Supabase Auth : URL du projet et clé publique "anon".
    supabaseUrl: (env.WM_SUPABASE_URL || '').replace(/\/+$/, ''),
    supabaseAnonKey: env.WM_SUPABASE_ANON_KEY || '',
    userAgent: env.WM_USER_AGENT || 'WikiMastersBot/1.0 (+self-hosted)',
  },
  defaults: {
    intervalMinutes: int(env.DEFAULT_INTERVAL_MINUTES, 50),
    packsPerRun: int(env.DEFAULT_PACKS_PER_RUN, 5),
  },
};
