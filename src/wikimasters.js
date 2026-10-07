import { config } from './config.js';
import { state, save } from './store.js';

/**
 * Erreur typée renvoyée par le client WikiMasters.
 * kind : 'auth' | 'verification' | 'reconnect' | 'rate_limit' | 'no_packs' | 'http' | 'network'
 */
export class WMError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const truncate = (s, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------- Gestion des cookies (mode "cookie") ----------

function parseCookieString(str) {
  const jar = new Map();
  for (const part of (str || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  return jar;
}

const serializeJar = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

// Applique les Set-Cookie renvoyés par le serveur pour garder la session à jour.
function applySetCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!setCookies.length || state.auth.mode !== 'cookie') return;
  const jar = parseCookieString(state.auth.cookie);
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v] = a.split('=').map((x) => x && x.trim().toLowerCase());
      return (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v) < Date.now());
    });
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  const next = serializeJar(jar);
  if (next !== state.auth.cookie) {
    state.auth.cookie = next;
    save();
  }
}

// ---------- Requêtes HTTP ----------

const isAbsolute = (p) => /^https?:\/\//i.test(p);
const resolveUrl = (p) => (isAbsolute(p) ? p : `${config.wm.baseUrl}${p}`);
const isSupabaseUrl = (url) => Boolean(config.wm.supabaseUrl) && url.startsWith(config.wm.supabaseUrl);

function supabaseProjectRef() {
  const m = config.wm.supabaseUrl.match(/\/\/([^.]+)\.supabase/);
  return m ? m[1] : '';
}

function buildSiteSessionCookie() {
  const ref = supabaseProjectRef();
  if (!ref || !state.auth.accessToken || !state.auth.refreshToken) return '';
  const session = JSON.stringify({
    access_token: state.auth.accessToken,
    refresh_token: state.auth.refreshToken,
    token_type: 'bearer',
  });
  const encoded = `base64-${Buffer.from(session).toString('base64url')}`;
  const name = `sb-${ref}-auth-token`;
  const CHUNK = 3180;
  if (encoded.length <= CHUNK) return `${name}=${encoded}`;
  const parts = [];
  for (let i = 0; i * CHUNK < encoded.length; i++) {
    parts.push(`${name}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  return parts.join('; ');
}

function authHeaders(url) {
  const h = {};
  if (state.auth.mode === 'cookie' && state.auth.cookie && !isSupabaseUrl(url)) h.Cookie = state.auth.cookie;
  if (state.auth.mode === 'token' && !isSupabaseUrl(url)) {
    const cookie = buildSiteSessionCookie();
    if (cookie) h.Cookie = cookie;
  }
  if (state.auth.mode === 'token' && state.auth.accessToken && isSupabaseUrl(url)) {
    h.Authorization = `Bearer ${state.auth.accessToken}`;
  }
  if (isSupabaseUrl(url) && config.wm.supabaseAnonKey) h.apikey = config.wm.supabaseAnonKey;
  return h;
}

async function rawRequest(method, path, body, { headers = authHeaders(resolveUrl(path)) } = {}) {
  const url = resolveUrl(path);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': config.wm.userAgent,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new WMError('network', `Network error: ${err.cause?.code || err.message}`);
  }
  if (!isSupabaseUrl(url)) applySetCookies(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
  return { res, text, json };
}

export function hasCredentials() {
  return state.auth.mode === 'cookie' ? Boolean(state.auth.cookie) : Boolean(state.auth.accessToken || state.auth.refreshToken);
}

function refreshRequest() {
  const token = state.auth.refreshToken;
  if (config.wm.supabaseUrl) {
    // Flux Supabase GoTrue : le refresh token est à usage unique et tourne à chaque appel.
    if (!config.wm.supabaseAnonKey) {
      throw new WMError('http', 'WM_SUPABASE_ANON_KEY is missing: cannot refresh a Supabase session.');
    }
    return rawRequest('POST', `${config.wm.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { refresh_token: token }, {
      headers: { apikey: config.wm.supabaseAnonKey, Authorization: `Bearer ${config.wm.supabaseAnonKey}` },
    });
  }
  return rawRequest('POST', config.wm.refreshPath, { refresh_token: token, refreshToken: token });
}

export async function refreshToken() {
  if (!state.auth.refreshToken) {
    throw new WMError('reconnect', 'No refresh token. Reconnect your session.');
  }
  const { res, json, text } = await refreshRequest();
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new WMError('reconnect', `Refresh rejected (${res.status}): refresh token is dead. Reconnect your session.`);
    }
    throw new WMError('http', `Refresh failed HTTP ${res.status}: ${truncate(text)}`);
  }
  const access = json?.access_token ?? json?.accessToken ?? json?.token ?? json?.session?.access_token;
  const refresh = json?.refresh_token ?? json?.refreshToken ?? json?.session?.refresh_token;
  if (!access) throw new WMError('http', `Refresh response without access token: ${truncate(text)}`);
  state.auth.accessToken = access;
  if (refresh) state.auth.refreshToken = refresh;
  state.auth.expiresAt = tokenExpiry(json, access);
  save();
}

// Expiration du token d'accès en ms : champ expires_at (s) ou claim "exp" du JWT.
function tokenExpiry(json, access) {
  if (Number.isFinite(json?.expires_at)) return json.expires_at * 1000;
  if (Number.isFinite(json?.expires_in)) return Date.now() + json.expires_in * 1000;
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch { /* token opaque */ }
  return null;
}

/**
 * Lit une session Supabase telle que stockée par le site : valeur du cookie
 * sb-<projet>-auth-token (morceaux .0, .1… mis bout à bout, préfixe "base64-")
 * ou JSON brut. Renvoie { accessToken, refreshToken, expiresAt, username }.
 */
export function parseSupabaseSession(raw) {
  let text = String(raw || '').replace(/\s+/g, '');
  if (!text) throw new Error('Session vide');
  try { text = decodeURIComponent(text); } catch { /* déjà décodé */ }
  if (text.startsWith('base64-')) text = Buffer.from(text.slice(7), 'base64url').toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Session illisible : colle la valeur complète du cookie sb-…-auth-token (morceaux .0 puis .1 à la suite).'); }
  if (Array.isArray(json)) json = { access_token: json[0], refresh_token: json[1] };
  const session = json.currentSession ?? json.session ?? json;
  if (!session.access_token || !session.refresh_token) throw new Error('access_token ou refresh_token manquant dans la session.');
  const meta = session.user?.user_metadata ?? {};
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: tokenExpiry(session, session.access_token),
    username: meta.username ?? meta.user_name ?? meta.name ?? '',
  };
}

/** Requête authentifiée, avec un rafraîchissement de token automatique en mode "token". */
async function request(method, path, body) {
  const a = state.auth;
  if (a.mode === 'token' && a.refreshToken && (!a.accessToken || (a.expiresAt && a.expiresAt - Date.now() < 60_000))) {
    await refreshToken();
  }
  let r = await rawRequest(method, path, body);
  if (r.res.status === 401 && a.mode === 'token' && a.refreshToken) {
    await refreshToken();
    r = await rawRequest(method, path, body);
  }
  const { res, text, json } = r;
  if (res.ok) return json;

  const mode = state.auth.mode;
  if (res.status === 401 || res.status === 403) {
    if (json?.human_verification_required || json?.code === 'human_verification_required') {
      // Le site demande une vérification humaine : on s'arrête et on attend l'utilisateur.
      throw new WMError('verification', `AUTH ${res.status} (mode=${mode}): ${truncate(text)}`);
    }
    throw new WMError(res.status === 401 ? 'reconnect' : 'auth', `AUTH ${res.status} (mode=${mode}): ${truncate(text)}`);
  }
  if (res.status === 429) {
    const header = res.headers.get('retry-after');
    let retryAt = json?.retry_after ? Date.parse(json.retry_after) : NaN;
    if (Number.isNaN(retryAt) && header) {
      retryAt = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header);
    }
    throw new WMError('rate_limit', `HTTP 429: ${truncate(text)}`, {
      retryAt: Number.isNaN(retryAt) ? null : retryAt,
      daily: Boolean(json?.rate_limit_daily),
    });
  }
  if ((res.status === 400 || res.status === 409) && /no[_ ]?packs?|aucun paquet|pas de paquet/i.test(text)) {
    throw new WMError('no_packs', `No pack available: ${truncate(text)}`);
  }
  throw new WMError('http', `HTTP ${res.status}: ${truncate(text)}`);
}

// ---------- Normalisation des réponses ----------

const RARITY_ALIASES = {
  c: 'C', common: 'C', commune: 'C', commun: 'C',
  pc: 'PC', uncommon: 'PC', 'peu commune': 'PC', 'peu_commune': 'PC', 'peu-commune': 'PC',
  r: 'R', rare: 'R',
  tr: 'TR', 'très rare': 'TR', 'tres rare': 'TR', 'tres_rare': 'TR', 'very rare': 'TR', 'very_rare': 'TR',
  e: 'E', epic: 'E', 'épique': 'E', epique: 'E',
  l: 'L', legendary: 'L', 'légendaire': 'L', legendaire: 'L',
  m: 'M', mythic: 'M', mythique: 'M',
};

export function normalizeRarity(raw) {
  if (raw === undefined || raw === null) return '?';
  const key = String(raw).trim().toLowerCase();
  return RARITY_ALIASES[key] || String(raw).trim().toUpperCase().slice(0, 3);
}

function normalizeCard(c) {
  if (typeof c === 'string') return { title: c, rarity: '?' };
  const article = c.article && typeof c.article === 'object' ? c.article : {};
  const title = c.wikipedia_title ?? c.title ?? c.name ?? c.label ?? article.title ?? c.article ?? c.page ?? 'Carte inconnue';
  const rarity = normalizeRarity(c.rarity_code ?? c.rarity ?? c.rarete ?? c.tier ?? article.rarity);
  const url = c.wikipedia_url ?? c.url ?? article.url ?? null;
  return { title: String(title), rarity, ...(url ? { url } : {}) };
}

export function extractCards(json) {
  const candidates = [json, json?.cards, json?.pack?.cards, json?.data?.cards, json?.data, json?.result?.cards, json?.items];
  const arr = candidates.find((x) => Array.isArray(x));
  return arr ? arr.map(normalizeCard) : [];
}

function extractAvailable(json) {
  const keys = ['available', 'available_packs', 'availablePacks', 'packs', 'stock', 'count', 'remaining'];
  for (const src of [json, json?.data, json?.packs]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) if (Number.isFinite(src[k])) return src[k];
  }
  return null;
}

// ---------- API publique ----------

/** Nombre de paquets disponibles, ou null si l'endpoint n'est pas configuré / pas lisible. */
export async function getAvailablePacks() {
  if (!config.wm.packsStatusPath) return null;
  return extractAvailable(await request('GET', config.wm.packsStatusPath));
}

export async function openPack() {
  const json = await request('POST', config.wm.openPackPath, {});
  return extractCards(json);
}
