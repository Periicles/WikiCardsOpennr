const $ = (id) => document.getElementById(id);

let state = null;
let clockOffset = 0; // serverTime - Date.now()

const STATUS_LABELS = {
  success: 'success',
  error: 'error',
  needs_reconnect: 'needs reconnect',
  verification: 'verification required',
  rate_limited: 'rate limited',
  partial: 'partial',
  no_packs: 'no packs',
};
const RARITY_ORDER = ['M', 'L', 'E', 'TR', 'R', 'PC', 'C'];

// ---------- API ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; throw new Error('Unauthorized'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function refresh() {
  try {
    setState(await api('/api/state'));
  } catch (err) {
    console.error(err);
  }
}

function setState(s) {
  state = s;
  clockOffset = s.serverTime - Date.now();
  render();
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- Rendu ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function renderRun(run) {
  const cards = [...run.cards].sort((a, b) => {
    const ia = RARITY_ORDER.indexOf(a.rarity), ib = RARITY_ORDER.indexOf(b.rarity);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const chips = cards.length
    ? el('div', { class: 'cards' }, ...cards.map((c) => {
        const attrs = { class: `chip r-${c.rarity}`, title: c.title };
        if (c.url && /^https?:\/\//.test(c.url)) Object.assign(attrs, { href: c.url, target: '_blank', rel: 'noopener noreferrer' });
        return el(c.url ? 'a' : 'span', attrs, el('b', {}, c.rarity), el('span', { class: 't' }, c.title));
      }))
    : null;
  return el('div', { class: 'run' },
    el('div', { class: 'run-meta' },
      el('span', { class: `badge ${run.status}` }, STATUS_LABELS[run.status] || run.status),
      el('span', {}, formatDate(run.startedAt)),
      el('span', { class: 'dim' }, '·'),
      el('span', {}, `${run.trigger} · ${run.packs} pack(s)`)),
    chips,
    run.error ? el('div', { class: 'run-error' }, run.error) : null);
}

function renderBlocked() {
  const box = $('blocked-notice');
  box.replaceChildren();
  if (!state.blocked) return;
  if (state.blocked === 'verification') {
    const btn = el('button', { class: 'btn-ghost', type: 'button' }, "J'ai fait la vérification, reprendre");
    btn.addEventListener('click', () => act('/api/resume', 'Bot relancé'));
    box.append(el('div', { class: 'notice red' },
      'WikiMasters demande une vérification anti-bot. Ouvre le site dans ton navigateur, ouvre un paquet à la main et valide la vérification, puis reprends le bot. Si tu es en mode cookie, recopie aussi le cookie à jour dans les paramètres.',
      el('div', { class: 'actions' }, btn)));
  } else if (state.blocked === 'reconnect') {
    const btn = el('button', { class: 'btn-ghost', type: 'button' }, 'Mettre à jour la session');
    btn.addEventListener('click', openSettings);
    box.append(el('div', { class: 'notice red' },
      'La session WikiMasters est expirée ou absente. Reconnecte-toi sur le site et colle le nouveau cookie / token dans les paramètres.',
      el('div', { class: 'actions' }, btn)));
  }
}

function render() {
  if (!state) return;
  $('username').textContent = state.username || '';

  const pill = $('status-pill');
  let pillClass = 'active', pillText = 'Active';
  if (state.running) { pillClass = 'running'; pillText = 'Running'; }
  else if (state.blocked) { pillClass = 'blocked'; pillText = state.blocked === 'verification' ? 'Verification' : 'Reconnect'; }
  else if (state.paused) { pillClass = 'paused'; pillText = 'Paused'; }
  pill.className = `pill ${pillClass}`;
  pill.textContent = pillText;

  $('icon-pause').toggleAttribute('hidden', state.paused);
  $('icon-play').toggleAttribute('hidden', !state.paused);
  $('btn-pause').title = state.paused ? 'Reprendre' : 'Pause';
  $('btn-run').disabled = state.running;
  $('btn-run').textContent = state.running ? 'Running…' : 'Run now';

  $('stat-packs').textContent = state.stats.packsOpened;
  $('stat-cards').textContent = state.stats.cardsFound;
  $('stat-runs').textContent = state.stats.runsCompleted;

  renderBlocked();

  const [last, ...rest] = state.runs;
  $('last-run').replaceChildren(last ? renderRun(last) : el('div', { class: 'empty' }, "Aucun run pour l'instant."));
  $('history-wrap').hidden = rest.length === 0;
  $('history-count').textContent = rest.length;
  $('history').replaceChildren(...rest.map(renderRun));

  tick();
}

function tick() {
  if (!state) return;
  const now = Date.now() + clockOffset;
  const label = $('next-label');
  const cd = $('countdown');
  const bar = $('progress');
  if (state.running) {
    label.textContent = 'Running';
    cd.textContent = 'Opening packs…';
    bar.style.width = '100%';
    return;
  }
  if (state.blocked || state.paused) {
    label.textContent = state.blocked ? 'Waiting for you' : 'Paused';
    cd.textContent = state.blocked ? 'Action required' : 'Paused';
    bar.style.width = '0%';
    return;
  }
  label.textContent = 'Next run';
  const remaining = (state.nextRunAt || now) - now;
  cd.textContent = remaining <= 0 ? 'Starting…' : formatDuration(remaining);
  const start = state.previousRunAt || state.nextRunAt - state.settings.intervalMinutes * 60_000;
  const total = Math.max(1, state.nextRunAt - start);
  bar.style.width = `${Math.min(100, Math.max(0, ((now - start) / total) * 100))}%`;
  if (remaining <= -3000 && !tick.refreshing) {
    tick.refreshing = true;
    refresh().finally(() => { tick.refreshing = false; });
  }
}

// ---------- Actions ----------

async function act(path, msg, body = {}) {
  try {
    setState(await api(path, body));
    if (msg) toast(msg);
  } catch (err) {
    toast(err.message);
  }
}

function syncModeFields() {
  const mode = $('mode').value;
  document.querySelectorAll('[data-mode]').forEach((n) => { n.hidden = n.dataset.mode !== mode; });
}

function openSettings() {
  $('interval').value = state.settings.intervalMinutes;
  $('packs').value = state.settings.packsPerRun;
  $('mode').value = state.session.mode;
  $('wm-username').value = state.username || '';
  $('cookie').value = $('access').value = $('refresh').value = $('sb-session').value = '';
  const s = state.session;
  $('session-status').textContent = `Session enregistrée : cookie ${s.hasCookie ? '✓' : '✗'} · access token ${s.hasAccessToken ? '✓' : '✗'} · refresh token ${s.hasRefreshToken ? '✓' : '✗'}`;
  syncModeFields();
  $('settings').showModal();
}

$('btn-settings').addEventListener('click', openSettings);
$('mode').addEventListener('change', syncModeFields);
$('btn-cancel').addEventListener('click', () => $('settings').close());
$('btn-clear-session').addEventListener('click', async () => {
  if (!confirm('Supprimer le cookie et les tokens enregistrés ?')) return;
  await act('/api/session/clear', 'Session supprimée');
  $('settings').close();
});
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { intervalMinutes: Number($('interval').value), packsPerRun: Number($('packs').value) });
    setState(await api('/api/session', {
      mode: $('mode').value,
      username: $('wm-username').value,
      cookie: $('cookie').value,
      accessToken: $('access').value,
      refreshToken: $('refresh').value,
      supabaseSession: $('mode').value === 'token' ? $('sb-session').value : '',
    }));
    $('settings').close();
    toast('Paramètres enregistrés');
  } catch (err) {
    toast(err.message);
  }
});

$('btn-pause').addEventListener('click', () => (state.paused ? act('/api/resume', 'Bot relancé') : act('/api/pause', 'Bot en pause')));
$('btn-run').addEventListener('click', async () => {
  await act('/api/run', 'Run lancé');
  setTimeout(refresh, 1500);
});
$('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  location.href = '/login';
});

refresh();
setInterval(tick, 1000);
setInterval(refresh, 10_000);
