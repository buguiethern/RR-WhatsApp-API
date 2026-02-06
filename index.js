// server/index.js
'use strict';

require('dotenv').config();

const express = require('express');
const fileUpload = require('express-fileupload');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const ipRangeCheck = require('ip-range-check');

const app = express();
const port = Number(process.env.PORT || 3001);

app.set('trust proxy', 'loopback, linklocal, uniquelocal');

const allowedIPs = (process.env.ALLOWED_IPS || '127.0.0.1,::1')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log('[BOOT] ALLOWED_IPS aplicado:', allowedIPs.join(', '));

function normalizeIP(ip) {
  if (!ip) return '';
  const s = ip.toString().trim();
  return s.replace(/^::ffff:/, '');
}

function getClientIPExpress(req) {
  return normalizeIP(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '');
}

app.use((req, res, next) => {
  const cleanedIP = getClientIPExpress(req);
  if (ipRangeCheck(cleanedIP, allowedIPs)) return next();

  const xff = (req.headers['x-forwarded-for'] || '').toString();
  console.log('[BLOCK]', cleanedIP, 'xff=', xff, 'path=', req.path, 'ua=', req.headers['user-agent']);
  return res.status(403).send('Acesso negado.');
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

// ✅ importante: pra multipart + texto vir em req.body
app.use(fileUpload({ createParentPath: true, limits: { fileSize: 25 * 1024 * 1024 } }));

// ===== WebSocket
const wsPort = Number(process.env.WS_PORT || 8080);
const wss = new WebSocket.Server({ port: wsPort });

function getClientIPWS(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const first = xff.split(',')[0].trim();
  const ip = first || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return normalizeIP(ip);
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((wsClient) => {
    if (wsClient.readyState === WebSocket.OPEN) wsClient.send(payload);
  });
}

wss.on('connection', function connection(ws, req) {
  const cleanedIP = getClientIPWS(req);
  if (!ipRangeCheck(cleanedIP, allowedIPs)) {
    const xff = (req.headers['x-forwarded-for'] || '').toString();
    console.log(`[WS BLOCK] ip=${cleanedIP} xff=${xff}`);
    ws.terminate();
    return;
  }

  console.log(`Cliente conectado via WebSocket: ${cleanedIP}`);

  if (waState.qrCodeData) ws.send(JSON.stringify({ type: 'qr', data: waState.qrCodeData }));
  else ws.send(JSON.stringify({ type: 'status', authenticated: waState.authenticated, state: waState.lastKnownState }));
});

// ===== WhatsApp state
const waState = {
  client: null,
  qrCodeData: null,
  authenticated: false,
  lastKnownState: 'INIT',
  isStarting: false,
  isStopping: false,
  isRestarting: false,
  restartCount: 0,
  lastReadyAt: 0,
  lastStateCheckAt: 0,
  lastStateOkAt: 0,
  lastErrorAt: 0,
};

const SESSION_DIR = path.join(__dirname, 'session');
const STARTUP_MIN_DELAY_MS = Number(process.env.WA_STARTUP_DELAY_MS || 1500);
const RESTART_BASE_DELAY_MS = Number(process.env.WA_RESTART_BASE_DELAY_MS || 2500);
const RESTART_MAX_DELAY_MS = Number(process.env.WA_RESTART_MAX_DELAY_MS || 60000);
const STATE_WATCHDOG_INTERVAL_MS = Number(process.env.WA_WATCHDOG_INTERVAL_MS || 15000);
const STATE_STUCK_TIMEOUT_MS = Number(process.env.WA_STUCK_TIMEOUT_MS || 90000);
const DESTROY_TIMEOUT_MS = Number(process.env.WA_DESTROY_TIMEOUT_MS || 12000);
const LOGOUT_TIMEOUT_MS = Number(process.env.WA_LOGOUT_TIMEOUT_MS || 12000);

// ✅ versão do WhatsApp Web (evita QR “inválido” por versão velha)
const WA_WEB_VERSION = (process.env.WA_WEB_VERSION || '').trim();
// remotePath com {version} é o formato esperado pelo RemoteWebCache
const WA_WEB_REMOTE_PATH =
  (process.env.WA_WEB_REMOTE_PATH || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html').trim();

console.log('[BOOT] WA_WEB_VERSION:', WA_WEB_VERSION || '(auto/default)');
console.log('[BOOT] WA_WEB_REMOTE_PATH:', WA_WEB_REMOTE_PATH);

// ===========================
// ✅ SEND QUEUE
// ===========================
let sendChain = Promise.resolve();
function enqueueSend(fn) {
  sendChain = sendChain.then(fn).catch(() => {});
  return sendChain;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function backoffDelay(attempt) {
  const base = RESTART_BASE_DELAY_MS;
  const exp = base * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 500);
  return clamp(exp + jitter, base, RESTART_MAX_DELAY_MS);
}

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function safeRmDir(dir) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.log('[WARN] Falha ao remover dir:', dir, e?.message || e); }
}

function getPuppeteerOptions() {
  const executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--mute-audio',
    '--user-data-dir=/tmp/whatsapp_browser',
  ];
  if ((process.env.WA_SINGLE_PROCESS || '').toLowerCase() === 'true') args.push('--single-process');
  return { headless: true, args, defaultViewport: null, timeout: 0, executablePath };
}

function buildClient() {
  const opts = {
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: getPuppeteerOptions(),

    // ✅ aumenta tolerância de regeneração de QR
    qrMaxRetries: Number(process.env.WA_QR_MAX_RETRIES || 10),

    takeoverOnConflict: true,
    takeoverTimeoutMs: 3000,

    // ✅ força cache remoto de versão do WhatsApp Web (mitiga QR “inválido”)
    webVersionCache: {
      type: 'remote',
      remotePath: WA_WEB_REMOTE_PATH,
      strict: false,
    },
  };

  if (WA_WEB_VERSION) opts.webVersion = WA_WEB_VERSION;

  return new Client(opts);
}

function setState(nextState) {
  waState.lastKnownState = nextState;
  broadcast({ type: 'state', state: nextState, authenticated: waState.authenticated });
}

function clearQr() { waState.qrCodeData = null; }

async function stopClient({ doLogout = false, wipeSession = false, reason = 'stop' } = {}) {
  if (waState.isStopping) return;
  waState.isStopping = true;

  try {
    const c = waState.client;
    waState.client = null;
    waState.authenticated = false;
    clearQr();
    setState('STOPPING');
    broadcast({ type: 'stopping', reason, wipeSession });

    if (c) {
      try { c.removeAllListeners(); } catch {}

      if (doLogout) {
        try { await withTimeout(c.logout(), LOGOUT_TIMEOUT_MS, 'client.logout'); }
        catch (e) { console.log('[WARN] logout falhou:', e?.message || e); }
      }

      try { await withTimeout(c.destroy(), DESTROY_TIMEOUT_MS, 'client.destroy'); }
      catch (e) { console.log('[WARN] destroy falhou/timeout:', e?.message || e); }
    }

    if (wipeSession) safeRmDir(SESSION_DIR);

    setState('STOPPED');
    broadcast({ type: 'stopped', reason, wipeSession });
  } finally {
    waState.isStopping = false;
  }
}

async function startClient({ reason = 'start' } = {}) {
  if (waState.isStarting || waState.client) return;
  waState.isStarting = true;

  try {
    setState('STARTING');
    broadcast({ type: 'starting', reason });

    await sleep(STARTUP_MIN_DELAY_MS);

    const c = buildClient();
    waState.client = c;
    registerClientEvents(c);

    try { c.initialize(); }
    catch (e) {
      waState.lastErrorAt = Date.now();
      console.log('[ERR] initialize lançou erro:', e?.message || e);
      throw e;
    }
  } finally {
    waState.isStarting = false;
  }
}

async function restartClient({ reason = 'restart', wipeSession = false, doLogout = false } = {}) {
  if (waState.isRestarting) return;
  waState.isRestarting = true;

  try {
    waState.restartCount += 1;
    const wait = backoffDelay(Math.min(waState.restartCount, 8));

    console.log(`[WA] restart solicitado. reason=${reason} wipeSession=${wipeSession} doLogout=${doLogout} wait=${wait}ms`);
    broadcast({ type: 'restart_scheduled', reason, wipeSession, doLogout, wait });

    await stopClient({ reason, wipeSession, doLogout });
    await sleep(wait);
    await startClient({ reason });
  } finally {
    waState.isRestarting = false;
  }
}

function registerClientEvents(client) {
  client.removeAllListeners();

  client.on('qr', (qr) => {
    waState.qrCodeData = qr;
    waState.authenticated = false;
    setState('QR');
    console.log('[WA] QR Code gerado.');
    broadcast({ type: 'qr', data: qr });
  });

  client.on('authenticated', () => {
    console.log('[WA] authenticated (sessão ok).');
    broadcast({ type: 'authenticated' });
  });

  client.on('ready', async () => {
    console.log('[WA] ready!');
    clearQr();
    await sleep(1200);

    let state = 'UNKNOWN';
    try {
      state = await client.getState();
      waState.lastStateOkAt = Date.now();
    } catch (e) {
      console.log('[WARN] getState no ready falhou:', e?.message || e);
    }

    waState.lastReadyAt = Date.now();
    waState.authenticated = (state === 'CONNECTED');
    setState(state || 'READY');
    broadcast({ type: 'ready', state, authenticated: waState.authenticated });
  });

  client.on('change_state', (state) => {
    console.log('[WA] change_state:', state);
    waState.lastKnownState = state;
    if (state === 'CONNECTED') waState.authenticated = true;
    if (state === 'UNPAIRED' || state === 'UNLAUNCHED') waState.authenticated = false;
    broadcast({ type: 'change_state', state, authenticated: waState.authenticated });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[WA] loading_screen ${percent}%: ${message}`);
    broadcast({ type: 'loading', percent, message });
  });

  client.on('auth_failure', async (msg) => {
    console.log('[WA] auth_failure:', msg);
    waState.lastErrorAt = Date.now();
    waState.authenticated = false;
    clearQr();
    setState('AUTH_FAILURE');
    broadcast({ type: 'auth_failure', msg });
    await restartClient({ reason: 'auth_failure', wipeSession: true, doLogout: false });
  });

  client.on('disconnected', async (reason) => {
    console.log('[WA] disconnected:', reason);
    waState.lastErrorAt = Date.now();
    waState.authenticated = false;
    clearQr();
    setState('DISCONNECTED');
    broadcast({ type: 'disconnected', reason });

    const r = String(reason || '').toLowerCase();
    const shouldWipe = r.includes('logout') || r.includes('unpaired') || r.includes('auth') || r.includes('banned');
    await restartClient({ reason: `disconnected:${reason}`, wipeSession: shouldWipe, doLogout: false });
  });

  client.on('message', async (msg) => {
    try {
      if (msg.type === 'chat' && (msg.body || '').toLowerCase().trim() === '!ping') {
        await client.sendMessage(msg.from, 'PONG');
      }
    } catch (e) {
      console.log('[WARN] erro no handler message:', e?.message || e);
    }
  });

  client.on('call', async (call) => {
    try {
      console.log(`[WA] chamada de ${call.from} (video=${call.isVideo})`);
      await call.reject();
      const message = '*Mensagem automática!*\n\nEste número não aceita chamadas de voz ou de vídeo.';
      await client.sendMessage(call.from, message);
    } catch (e) {
      console.log('[WARN] erro no handler call:', e?.message || e);
    }
  });
}

// Watchdog
let watchdogTimer = null;
async function watchdogTick() {
  if (!waState.client) return;
  if (waState.isRestarting || waState.isStopping || waState.isStarting) return;

  const now = Date.now();
  waState.lastStateCheckAt = now;

  try {
    const st = await waState.client.getState();
    waState.lastStateOkAt = now;
    waState.lastKnownState = st || waState.lastKnownState;

    const authed = (st === 'CONNECTED');
    if (authed !== waState.authenticated) waState.authenticated = authed;

    broadcast({ type: 'watchdog', ok: true, state: st, authenticated: waState.authenticated });
  } catch (e) {
    waState.lastErrorAt = now;
    console.log('[WA][WATCHDOG] getState falhou:', e?.message || e);
    broadcast({ type: 'watchdog', ok: false, error: e?.message || String(e) });
  }

  const sinceOk = now - (waState.lastStateOkAt || 0);
  if (waState.lastStateOkAt && sinceOk > STATE_STUCK_TIMEOUT_MS) {
    console.log(`[WA][WATCHDOG] estado possivelmente travado há ${sinceOk}ms -> restart`);
    await restartClient({ reason: 'watchdog_stuck', wipeSession: false, doLogout: false });
  }
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => { watchdogTick().catch(() => {}); }, STATE_WATCHDOG_INTERVAL_MS);
}
function stopWatchdog() { if (watchdogTimer) clearInterval(watchdogTimer); watchdogTimer = null; }

// init WA
(async () => {
  startWatchdog();
  await startClient({ reason: 'boot' });
})().catch(async (e) => {
  console.log('[BOOT] falha ao iniciar WA:', e?.message || e);
  await restartClient({ reason: 'boot_fail', wipeSession: false, doLogout: false });
});

// ============================================================
// ✅ CONFIG PERSISTENTE DO PLANO DE ENVIO (SEM EDITAR .env)
// ============================================================
const SEND_PLAN_FILE = path.join(__dirname, 'send_plan.json');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.log('[WARN] readJsonSafe falhou:', filePath, e?.message || e);
    return null;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseHHMM(value, fallbackMinutes) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMinutes;
  const hh = clamp(Number(m[1]), 0, 23);
  const mm = clamp(Number(m[2]), 0, 59);
  return hh * 60 + mm;
}

function toHHMM(mins) {
  const m = ((Number(mins) || 0) % (24 * 60) + (24 * 60)) % (24 * 60);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function sanitizePlanInput(planLike) {
  const p = (planLike && typeof planLike === 'object') ? planLike : {};

  const envStart = process.env.SEND_WINDOW_START || '08:00';
  const envEnd = process.env.SEND_WINDOW_END || '19:00';

  const startMin = parseHHMM(p.window_start ?? p.windowStart ?? p.window_start_hhmm ?? envStart, parseHHMM(envStart, 8 * 60));
  const endMin = parseHHMM(p.window_end ?? p.windowEnd ?? p.window_end_hhmm ?? envEnd, parseHHMM(envEnd, 19 * 60));

  const delayMin = clamp(Number(p.delay_min_ms ?? p.delayMinMs ?? 45000), 0, 10 * 60 * 1000);
  const delayMax = clamp(Number(p.delay_max_ms ?? p.delayMaxMs ?? 110000), delayMin, 10 * 60 * 1000);

  const longEvery = clamp(Number(p.long_break_every ?? p.longBreakEvery ?? 25), 0, 5000);
  const longMin = clamp(Number(p.long_break_min_ms ?? p.longBreakMinMs ?? (10 * 60 * 1000)), 0, 6 * 60 * 60 * 1000);
  const longMax = clamp(Number(p.long_break_max_ms ?? p.longBreakMaxMs ?? (20 * 60 * 1000)), longMin, 6 * 60 * 60 * 1000);

  const hardStop = String(p.hard_stop_outside_window ?? p.hardStopOutsideWindow ?? 'false').toLowerCase() === 'true';

  return {
    window_start: toHHMM(startMin),
    window_end: toHHMM(endMin),
    delay_min_ms: delayMin,
    delay_max_ms: delayMax,
    long_break_every: longEvery,
    long_break_min_ms: longMin,
    long_break_max_ms: longMax,
    hard_stop_outside_window: hardStop,
  };
}

let persistedSendPlan = null;
(function loadPersistedPlan() {
  const fromDisk = readJsonSafe(SEND_PLAN_FILE);
  if (fromDisk && typeof fromDisk === 'object') {
    persistedSendPlan = sanitizePlanInput(fromDisk);
    console.log('[BOOT] send_plan.json carregado:', persistedSendPlan);
  } else {
    persistedSendPlan = null;
    console.log('[BOOT] send_plan.json não encontrado (usando env/padrões).');
  }
})();

function getDefaultPlanObject() {
  if (persistedSendPlan) return { ...persistedSendPlan };

  return sanitizePlanInput({
    window_start: process.env.SEND_WINDOW_START || '08:00',
    window_end: process.env.SEND_WINDOW_END || '19:00',
    delay_min_ms: Number(process.env.SEND_DELAY_MIN_MS || 45000),
    delay_max_ms: Number(process.env.SEND_DELAY_MAX_MS || 110000),
    long_break_every: Number(process.env.SEND_LONG_BREAK_EVERY || 25),
    long_break_min_ms: Number(process.env.SEND_LONG_BREAK_MIN_MS || (10 * 60 * 1000)),
    long_break_max_ms: Number(process.env.SEND_LONG_BREAK_MAX_MS || (20 * 60 * 1000)),
    hard_stop_outside_window: String(process.env.SEND_HARD_STOP_OUTSIDE_WINDOW || 'false'),
  });
}

// ===== Public config (injetando UI + botão "Salvar" no Avançado)
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');

  const cfg = {
    wsPort,
    sendPlan: getDefaultPlanObject(),
  };

  const js = `
/* config.js (gerado pelo servidor) */
window.__WS_PORT__ = ${JSON.stringify(cfg.wsPort)};
window.__SEND_PLAN_DEFAULT__ = ${JSON.stringify(cfg.sendPlan)};

(function () {
  function qs(sel) { try { return document.querySelector(sel); } catch(e) { return null; } }
  function qsa(sel) { try { return Array.from(document.querySelectorAll(sel)); } catch(e) { return []; } }

  function firstExisting(selectors) {
    for (const s of selectors) {
      const el = qs(s);
      if (el) return el;
    }
    return null;
  }

  function makeEl(tag, attrs, html) {
    const el = document.createElement(tag);
    if (attrs && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = String(v);
        else if (k === 'style') el.setAttribute('style', String(v));
        else el.setAttribute(k, String(v));
      }
    }
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  function toast(msg, ok) {
    const host = firstExisting(['#toastHost', '#toast-host']) || document.body;
    if (!host) return alert(msg);

    let box = qs('#__plan_toast__');
    if (!box) {
      box = makeEl('div', {
        id: '__plan_toast__',
        style: 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:360px;'
      });
      host.appendChild(box);
    }

    const item = makeEl('div', {
      style: 'margin-top:8px;padding:10px 12px;border-radius:10px;font-family:system-ui,Segoe UI,Arial;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
             (ok ? 'background:#0f5132;color:#d1e7dd;border:1px solid #0a3622;' : 'background:#842029;color:#f8d7da;border:1px solid #58151c;')
    }, String(msg));

    box.appendChild(item);
    setTimeout(() => { try { item.remove(); } catch(e) {} }, 4000);
  }

  function normalizeHHMM(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\\d{1,2}):(\\d{2})$/);
    if (!m) return '';
    const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    const H = String(hh).padStart(2, '0');
    const M = String(mm).padStart(2, '0');
    return H + ':' + M;
  }

  function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function getAdvInputs() {
    // tenta achar inputs existentes na sua UI; se não existir, a gente cria.
    const map = {
      window_start: firstExisting(['#planWindowStart', '#windowStart', 'input[name="window_start"]', 'input[data-plan="window_start"]']),
      window_end: firstExisting(['#planWindowEnd', '#windowEnd', 'input[name="window_end"]', 'input[data-plan="window_end"]']),
      delay_min_ms: firstExisting(['#delayMinMs', '#delay_min_ms', 'input[name="delay_min_ms"]', 'input[data-plan="delay_min_ms"]']),
      delay_max_ms: firstExisting(['#delayMaxMs', '#delay_max_ms', 'input[name="delay_max_ms"]', 'input[data-plan="delay_max_ms"]']),
      long_break_every: firstExisting(['#longBreakEvery', '#long_break_every', 'input[name="long_break_every"]', 'input[data-plan="long_break_every"]']),
      long_break_min_ms: firstExisting(['#longBreakMinMs', '#long_break_min_ms', 'input[name="long_break_min_ms"]', 'input[data-plan="long_break_min_ms"]']),
      long_break_max_ms: firstExisting(['#longBreakMaxMs', '#long_break_max_ms', 'input[name="long_break_max_ms"]', 'input[data-plan="long_break_max_ms"]']),
      hard_stop_outside_window: firstExisting(['#hardStopOutsideWindow', '#hard_stop_outside_window', 'input[name="hard_stop_outside_window"]', 'input[data-plan="hard_stop_outside_window"]']),
    };
    return map;
  }

  function fillInputsFromPlan(plan) {
    const inputs = getAdvInputs();
    if (inputs.window_start) inputs.window_start.value = plan.window_start || '';
    if (inputs.window_end) inputs.window_end.value = plan.window_end || '';
    if (inputs.delay_min_ms) inputs.delay_min_ms.value = String(plan.delay_min_ms ?? '');
    if (inputs.delay_max_ms) inputs.delay_max_ms.value = String(plan.delay_max_ms ?? '');
    if (inputs.long_break_every) inputs.long_break_every.value = String(plan.long_break_every ?? '');
    if (inputs.long_break_min_ms) inputs.long_break_min_ms.value = String(plan.long_break_min_ms ?? '');
    if (inputs.long_break_max_ms) inputs.long_break_max_ms.value = String(plan.long_break_max_ms ?? '');
    if (inputs.hard_stop_outside_window) {
      if (inputs.hard_stop_outside_window.type === 'checkbox') inputs.hard_stop_outside_window.checked = !!plan.hard_stop_outside_window;
      else inputs.hard_stop_outside_window.value = String(!!plan.hard_stop_outside_window);
    }
  }

  function collectPlanFromInputs() {
    const inputs = getAdvInputs();

    const plan = {
      window_start: normalizeHHMM(inputs.window_start ? inputs.window_start.value : (window.__SEND_PLAN_DEFAULT__?.window_start || '08:00')),
      window_end: normalizeHHMM(inputs.window_end ? inputs.window_end.value : (window.__SEND_PLAN_DEFAULT__?.window_end || '19:00')),
      delay_min_ms: num(inputs.delay_min_ms ? inputs.delay_min_ms.value : (window.__SEND_PLAN_DEFAULT__?.delay_min_ms ?? 45000), 45000),
      delay_max_ms: num(inputs.delay_max_ms ? inputs.delay_max_ms.value : (window.__SEND_PLAN_DEFAULT__?.delay_max_ms ?? 110000), 110000),
      long_break_every: num(inputs.long_break_every ? inputs.long_break_every.value : (window.__SEND_PLAN_DEFAULT__?.long_break_every ?? 25), 25),
      long_break_min_ms: num(inputs.long_break_min_ms ? inputs.long_break_min_ms.value : (window.__SEND_PLAN_DEFAULT__?.long_break_min_ms ?? 600000), 600000),
      long_break_max_ms: num(inputs.long_break_max_ms ? inputs.long_break_max_ms.value : (window.__SEND_PLAN_DEFAULT__?.long_break_max_ms ?? 1200000), 1200000),
      hard_stop_outside_window: (function () {
        const el = inputs.hard_stop_outside_window;
        if (!el) return !!(window.__SEND_PLAN_DEFAULT__?.hard_stop_outside_window);
        if (el.type === 'checkbox') return !!el.checked;
        const v = String(el.value || '').toLowerCase();
        return (v === 'true' || v === '1' || v === 'sim' || v === 'yes' || v === 'on');
      })()
    };

    return plan;
  }

  async function apiGetPlan() {
    try {
      const r = await fetch('/api/send-config', { method: 'GET' });
      const j = await r.json();
      if (j && j.status === 'success' && j.plan) return j.plan;
    } catch(e) {}
    return window.__SEND_PLAN_DEFAULT__ || null;
  }

  async function apiSavePlan(plan) {
    const r = await fetch('/api/send-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && j.message) ? j.message : ('Erro HTTP ' + r.status);
      throw new Error(msg);
    }
    if (!j || j.status !== 'success') throw new Error(j?.message || 'Falha ao salvar.');
    return j.plan;
  }

  function ensureAdvancedUI() {
    // tenta achar o container do "Avançado"
    const adv = firstExisting([
      '#advanced',
      '#advancedSettings',
      '#advanced-settings',
      '#advancedPanel',
      '#advanced-panel',
      '[data-advanced="true"]',
      '.advanced',
      '.avancado',
      '#collapseAdvanced',
      '#advancedCollapse'
    ]);

    if (!adv) return null;

    // cria um bloco se não existir
    let box = qs('#__send_plan_box__');
    if (!box) {
      box = makeEl('div', { id: '__send_plan_box__', style: 'margin-top:12px;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.12);' });
      adv.appendChild(box);
    }

    // título
    if (!qs('#__send_plan_title__')) {
      box.appendChild(makeEl('div', { id: '__send_plan_title__', style: 'font-weight:700;margin-bottom:10px;' }, 'Configuração de envio (padrão)'));
    }

    function mkRow(label, inputHtml) {
      const row = makeEl('div', { style: 'display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap;' });
      row.appendChild(makeEl('div', { style: 'min-width:160px;opacity:.9;' }, label));
      const wrap = makeEl('div', { style: 'flex:1;min-width:220px;' });
      wrap.innerHTML = inputHtml;
      row.appendChild(wrap);
      return row;
    }

    // cria inputs se não existir (por IDs)
    const exists = {
      ws: !!qs('#planWindowStart'),
      we: !!qs('#planWindowEnd'),
      dmin: !!qs('#delayMinMs'),
      dmax: !!qs('#delayMaxMs'),
      lbe: !!qs('#longBreakEvery'),
      lbmin: !!qs('#longBreakMinMs'),
      lbmax: !!qs('#longBreakMaxMs'),
      hard: !!qs('#hardStopOutsideWindow'),
      btn: !!qs('#saveSendPlanBtn'),
    };

    if (!exists.ws) box.appendChild(mkRow('Janela início (HH:MM)', '<input id="planWindowStart" class="form-control" placeholder="08:00" style="max-width:220px;">'));
    if (!exists.we) box.appendChild(mkRow('Janela fim (HH:MM)', '<input id="planWindowEnd" class="form-control" placeholder="19:00" style="max-width:220px;">'));
    if (!exists.dmin) box.appendChild(mkRow('Delay mínimo (ms)', '<input id="delayMinMs" class="form-control" type="number" min="0" step="1000" placeholder="45000" style="max-width:220px;">'));
    if (!exists.dmax) box.appendChild(mkRow('Delay máximo (ms)', '<input id="delayMaxMs" class="form-control" type="number" min="0" step="1000" placeholder="110000" style="max-width:220px;">'));
    if (!exists.lbe) box.appendChild(mkRow('Pausa longa a cada X msgs', '<input id="longBreakEvery" class="form-control" type="number" min="0" step="1" placeholder="25" style="max-width:220px;">'));
    if (!exists.lbmin) box.appendChild(mkRow('Pausa longa mín (ms)', '<input id="longBreakMinMs" class="form-control" type="number" min="0" step="1000" placeholder="600000" style="max-width:220px;">'));
    if (!exists.lbmax) box.appendChild(mkRow('Pausa longa máx (ms)', '<input id="longBreakMaxMs" class="form-control" type="number" min="0" step="1000" placeholder="1200000" style="max-width:220px;">'));
    if (!exists.hard) {
      box.appendChild(mkRow('Hard stop fora da janela', '<div style="display:flex;align-items:center;gap:8px;"><input id="hardStopOutsideWindow" type="checkbox"><label for="hardStopOutsideWindow" style="opacity:.9;">Parar ao sair da janela (não esperar até amanhã)</label></div>'));
    }

    // botão salvar
    if (!exists.btn) {
      const btnRow = makeEl('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap;' });
      const btn = makeEl('button', { id: 'saveSendPlanBtn', type: 'button', class: 'btn btn-success' }, 'Salvar configuração');
      const hint = makeEl('div', { style: 'opacity:.75;font-size:12px;' }, 'Salva no servidor (send_plan.json) e vira padrão para os próximos envios.');
      btnRow.appendChild(btn);
      btnRow.appendChild(hint);
      box.appendChild(btnRow);
    }

    return adv;
  }

  async function initAdvancedPlanUI() {
    const adv = ensureAdvancedUI();
    if (!adv) return;

    const plan = await apiGetPlan();
    if (plan) {
      window.__SEND_PLAN_DEFAULT__ = plan;
      fillInputsFromPlan(plan);
    }

    const btn = qs('#saveSendPlanBtn');
    if (!btn) return;

    if (btn.__bound__) return;
    btn.__bound__ = true;

    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        btn.innerText = 'Salvando...';

        const planToSave = collectPlanFromInputs();
        const saved = await apiSavePlan(planToSave);

        window.__SEND_PLAN_DEFAULT__ = saved;
        fillInputsFromPlan(saved);

        toast('Configuração salva com sucesso!', true);
      } catch (e) {
        toast('Falha ao salvar: ' + (e?.message || String(e)), false);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Salvar configuração';
      }
    });
  }

  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(() => { initAdvancedPlanUI().catch(() => {}); });
})();`;

  res.send(js);
});

// ===== API: ler/salvar config de envio
app.get('/api/send-config', (req, res) => {
  try {
    return res.json({
      status: 'success',
      plan: getDefaultPlanObject(),
      source: persistedSendPlan ? 'disk' : 'env',
    });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: 'Falha ao ler configuração.', error: e?.message || String(e) });
  }
});

app.post('/api/send-config', (req, res) => {
  try {
    const body = req.body || {};
    const planRaw = (body.plan && typeof body.plan === 'object') ? body.plan : body;

    const sanitized = sanitizePlanInput(planRaw);

    persistedSendPlan = { ...sanitized };
    writeJsonAtomic(SEND_PLAN_FILE, persistedSendPlan);

    broadcast({ type: 'send_plan_saved', plan: persistedSendPlan });
    console.log('[CFG] send_plan salvo em disco:', persistedSendPlan);

    return res.json({ status: 'success', message: 'Configuração salva.', plan: persistedSendPlan });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: 'Falha ao salvar configuração.', error: e?.message || String(e) });
  }
});

// ===== Rotas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/qr', async (req, res) => {
  try {
    if (waState.authenticated && waState.client) return res.json({ status: 'connected', message: 'Cliente já está conectado' });
    if (!waState.qrCodeData) return res.json({ status: 'waiting', message: 'QR Code ainda não foi gerado, tente novamente em alguns segundos' });

    const qrCodeImage = await QRCode.toDataURL(waState.qrCodeData, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 10,
      type: 'image/png',
    });
    const base64Data = qrCodeImage.replace(/^data:image\/png;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': imgBuffer.length,
      'Cache-Control': 'no-store',
    });
    return res.end(imgBuffer);
  } catch (err) {
    console.log('[ERR] /api/qr:', err?.message || err);
    return res.status(500).json({ status: 'error', message: 'Erro ao gerar QR Code', error: err?.message || String(err) });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    if (!waState.client) return res.json({ status: 'disconnected' });

    let state = waState.lastKnownState || 'UNKNOWN';
    try { state = await waState.client.getState(); } catch {}

    const number = waState.client?.info?.wid?.user || null;

    if (state === 'CONNECTED') return res.json({ status: 'connected', number, state, authenticated: true });
    return res.json({ status: 'connecting', number, state, authenticated: false });
  } catch (err) {
    console.log('[ERR] /api/status:', err?.message || err);
    return res.status(500).json({ status: 'error', message: 'Erro ao consultar status', error: err?.message || String(err) });
  }
});

app.get('/api/disconnect', async (req, res) => {
  try {
    broadcast({ type: 'manual_disconnect' });
    await restartClient({ reason: 'manual_disconnect', wipeSession: false, doLogout: true });
    return res.send('Desconectado e reinicializado com sucesso!');
  } catch (err) {
    console.log('[ERR] /api/disconnect:', err?.message || err);
    return res.status(500).json({ status: 'error', message: 'Erro ao desconectar.', error: err?.message || String(err) });
  }
});

app.get('/api/reset', async (req, res) => {
  try {
    broadcast({ type: 'manual_reset' });
    await restartClient({ reason: 'manual_reset', wipeSession: true, doLogout: true });
    return res.send('Sessão limpa e reinicializada! Gere novo QR.');
  } catch (err) {
    console.log('[ERR] /api/reset:', err?.message || err);
    return res.status(500).json({ status: 'error', message: 'Erro ao resetar sessão.', error: err?.message || String(err) });
  }
});

async function assertConnectedOrThrow() {
  const c = waState.client;
  if (!c) throw new Error('Cliente não inicializado.');

  const st = await c.getState();
  if (st !== 'CONNECTED') throw new Error(`Cliente não conectado (state=${st}).`);

  if (!waState.authenticated) waState.authenticated = true;
}

function normalizeNewlines(s) {
  let t = String(s ?? '');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\u2028|\u2029/g, '\n');
  t = t.replace(/\u00A0/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n');
  return t;
}

// ✅ template $variavel -> valor
function applyTemplateVars(text, vars) {
  const src = normalizeNewlines(text);

  const dict = {};
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      const key = String(k || '').trim().toLowerCase();
      if (!key) continue;
      if (v === null || v === undefined) continue;
      dict[key] = (typeof v === 'string') ? v : String(v);
    }
  }

  return src.replace(/\$([a-zA-Z0-9_]+)/g, (m, k) => {
    const key = String(k).toLowerCase();
    return (dict[key] !== undefined) ? dict[key] : m;
  });
}

const sendMessageWithTimeout = async (chatId, message, file, timeout = 25000) => {
  const c = waState.client;
  if (!c) throw new Error('Cliente não inicializado.');

  return await withTimeout(
    (async () => {
      const imageRegex = /\[img\s*=\s*(https?:\/\/[^\s]+)\]/i;
      const pdfRegex = /\[pdf\s*=\s*(https?:\/\/[^\s]+)\]/i;

      const msg = normalizeNewlines(message);

      let match = (msg || '').match(imageRegex);
      if (match) {
        const imageUrl = match[1];
        const media = await MessageMedia.fromUrl(imageUrl);
        const caption = (msg || '').replace(imageRegex, '');
        await c.sendMessage(chatId, media, { caption: caption });
        return;
      }

      match = (msg || '').match(pdfRegex);
      if (match) {
        const pdfUrl = match[1];
        const media = await MessageMedia.fromUrl(pdfUrl);
        const caption = (msg || '').replace(pdfRegex, '');
        await c.sendMessage(chatId, media, { caption: caption });
        return;
      }

      if (file) {
        const tmpName = `${Date.now()}_${Math.random().toString(16).slice(2)}_${file.name}`;
        const filePath = path.join('/tmp', tmpName);
        await file.mv(filePath);

        try {
          const media = MessageMedia.fromFilePath(filePath);
          await c.sendMessage(chatId, media, { caption: msg || '' });
        } finally {
          fs.unlink(filePath, () => {});
        }
        return;
      }

      await c.sendMessage(chatId, msg || '');
    })(),
    timeout,
    'sendMessageWithTimeout'
  );
};

// =========================
// ✅ BR: NORMALIZAÇÃO CORRETA + FALLBACK COM 9
// =========================
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Retorna E.164 "55DDxxxxxxxx" ou "55DD9xxxxxxxx" (somente dígitos),
 * sem tentar adivinhar se é fixo/móvel.
 */
function formatPhoneNumberBrazil(phone) {
  let d = onlyDigits(phone);

  // remove zeros à esquerda comuns (ex: 0DD..., 00...)
  d = d.replace(/^0+/, '');

  // se veio com 55, mantém
  if (d.startsWith('55')) return d;

  // se veio com 10/11 dígitos (DD + num), prefixa 55
  if (d.length === 10 || d.length === 11) return '55' + d;

  // se veio com 8/9 dígitos sem DDD, não dá pra inferir com segurança
  return d;
}

/**
 * Validação “leve”: checa se parece BR com DDI 55 + DDD.
 * NÃO decide fixo/móvel.
 */
function isValidBrazilianFormat(phone) {
  const d = formatPhoneNumberBrazil(phone);

  if (!d.startsWith('55')) return false;
  if (!(d.length === 12 || d.length === 13)) return false;

  const ddd = d.substring(2, 4);
  if (ddd < '10' || ddd > '99') return false;

  return true;
}

/**
 * Resolve WID real via getNumberId com fallback:
 * - tenta como veio
 * - se for 12 dígitos (55 + DD + 8), tenta inserir 9 após DDD (55DD9 + 8)
 */
async function resolveNumberToWid(recipientRaw) {
  const c = waState.client;
  if (!c) throw new Error('Cliente não inicializado.');

  const e164 = formatPhoneNumberBrazil(recipientRaw);

  if (!isValidBrazilianFormat(e164)) {
    throw new Error(`Número BR inválido: "${recipientRaw}" -> "${e164}"`);
  }

  const candidates = [];
  candidates.push(e164);

  if (e164.startsWith('55') && e164.length === 12) {
    const ddd = e164.substring(2, 4);
    const local8 = e164.substring(4); // 8 dígitos
    const with9 = `55${ddd}9${local8}`;
    candidates.push(with9);
  }

  let lastErr = null;

  for (const cand of candidates) {
    console.log(`[RESOLVE] raw="${recipientRaw}" -> try="${cand}"`);
    try {
      const numberId = await withTimeout(c.getNumberId(cand), 15000, `client.getNumberId(${cand})`);
      if (numberId && numberId._serialized) {
        console.log(`[RESOLVE] try="${cand}" -> wid="${numberId._serialized}"`);
        return numberId._serialized;
      }
      lastErr = new Error(`Número não encontrado/registrado no WhatsApp: ${cand}`);
      console.log(`[RESOLVE] try="${cand}" -> NOT FOUND`);
    } catch (e) {
      lastErr = e;
      console.log(`[RESOLVE] try="${cand}" -> ERROR:`, e?.message || String(e));
    }
  }

  throw new Error(lastErr?.message || `Falha ao resolver número: ${recipientRaw}`);
}

function normalizeRecipientToTarget(raw) {
  const recipientTrimmed = (raw || '').trim();
  if (!recipientTrimmed) return null;

  // número
  if (/^\+?\d+$/.test(recipientTrimmed.replace(/\D/g, ''))) {
    const number = recipientTrimmed.replace(/\D/g, '');
    return { type: 'number', raw: number };
  }

  // grupo
  return { type: 'group', groupName: recipientTrimmed };
}

function parseRecipientsField(recipientsField) {
  if (recipientsField === undefined || recipientsField === null) return [];

  if (Array.isArray(recipientsField)) return recipientsField;

  const s = String(recipientsField).trim();
  if (!s) return [];

  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch {}
  }

  return s.split(',').map(x => x.trim()).filter(Boolean);
}

// ============================================================
// ✅ DISPATCH SCHEDULER (08:00–19:00 + random delays + breaks)
// ============================================================

function nowLocalMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function msUntilLocalMinute(targetMinute) {
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  const curSec = now.getSeconds();
  const curMs = now.getMilliseconds();

  let diffMin = targetMinute - curMin;
  if (diffMin < 0) diffMin += 24 * 60;

  // até o início do minuto alvo (com segundos/ms zerados)
  const msToNextMinBoundary = (60 - curSec) * 1000 - curMs;
  const msToTarget = (diffMin === 0) ? 0 : (diffMin - 1) * 60 * 1000 + msToNextMinBoundary;

  return Math.max(0, msToTarget);
}

function randInt(min, max) {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  if (b <= a) return a;
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function pickDelayMs(plan) {
  // delay curto “humano” entre mensagens
  const minMs = Math.max(0, Number(plan.delay_min_ms || 45000));
  const maxMs = Math.max(minMs, Number(plan.delay_max_ms || 110000));
  return randInt(minMs, maxMs);
}

function shouldTakeLongBreak(i1based, plan) {
  const every = Math.max(0, Number(plan.long_break_every || 25));
  if (!every) return false;
  return (i1based % every) === 0;
}

function pickLongBreakMs(plan) {
  const minMs = Math.max(0, Number(plan.long_break_min_ms || 10 * 60 * 1000));
  const maxMs = Math.max(minMs, Number(plan.long_break_max_ms || 20 * 60 * 1000));
  return randInt(minMs, maxMs);
}

function isWithinWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true; // janela 24h
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  // janela cruza meia-noite
  return nowMin >= startMin || nowMin < endMin;
}

function normalizeSendPlanFromBody(body) {
  const base = getDefaultPlanObject();
  const p = (body && body.plan && typeof body.plan === 'object') ? body.plan : {};

  // window: body -> base -> env/padrão
  const startMin = parseHHMM(p.window_start || body?.window_start || base.window_start, parseHHMM(base.window_start || '08:00', 8 * 60));
  const endMin = parseHHMM(p.window_end || body?.window_end || base.window_end, parseHHMM(base.window_end || '19:00', 19 * 60));

  // random delay seconds (fallback usando seu delayInput antigo)
  const delaySecLegacy = (body && body.delay !== undefined) ? Number(body.delay) : 1.2;
  const legacyMs = clamp(Math.floor(delaySecLegacy * 1000), 0, 60000);

  const hasCustomDelay = (p.delay_min_ms !== undefined || p.delay_max_ms !== undefined);

  const delay_min_ms = hasCustomDelay
    ? Number(p.delay_min_ms ?? base.delay_min_ms ?? 45000)
    : (legacyMs >= 2000 ? legacyMs : Number(base.delay_min_ms ?? 45000));

  const delay_max_ms = hasCustomDelay
    ? Number(p.delay_max_ms ?? base.delay_max_ms ?? 110000)
    : (legacyMs >= 2000 ? legacyMs : Number(base.delay_max_ms ?? 110000));

  const long_break_every = Number(p.long_break_every ?? base.long_break_every ?? 25);
  const long_break_min_ms = Number(p.long_break_min_ms ?? base.long_break_min_ms ?? (10 * 60 * 1000));
  const long_break_max_ms = Number(p.long_break_max_ms ?? base.long_break_max_ms ?? (20 * 60 * 1000));

  const hard_stop_outside_window = String(p.hard_stop_outside_window ?? base.hard_stop_outside_window ?? 'false').toLowerCase() === 'true';

  return {
    window_start_min: startMin,
    window_end_min: endMin,
    delay_min_ms: clamp(delay_min_ms, 0, 10 * 60 * 1000),
    delay_max_ms: clamp(delay_max_ms, 0, 10 * 60 * 1000),
    long_break_every: clamp(long_break_every, 0, 5000),
    long_break_min_ms: clamp(long_break_min_ms, 0, 6 * 60 * 60 * 1000),
    long_break_max_ms: clamp(long_break_max_ms, 0, 6 * 60 * 60 * 1000),
    hard_stop_outside_window,
  };
}

async function enforceWindowOrWait(plan) {
  const startMin = plan.window_start_min;
  const endMin = plan.window_end_min;
  const nowMin = nowLocalMinutes();

  if (isWithinWindow(nowMin, startMin, endMin)) return;

  // fora da janela: esperar até próxima abertura
  const waitMs = msUntilLocalMinute(startMin);
  const startHH = String(Math.floor(startMin / 60)).padStart(2, '0');
  const startMM = String(startMin % 60).padStart(2, '0');
  const endHH = String(Math.floor(endMin / 60)).padStart(2, '0');
  const endMM = String(endMin % 60).padStart(2, '0');

  broadcast({
    type: 'send_pause_window',
    message: `Fora da janela (${startHH}:${startMM}–${endHH}:${endMM}). Aguardando abertura...`,
    waitMs
  });

  console.log(`[PLAN] fora da janela ${startHH}:${startMM}–${endHH}:${endMM}. wait=${waitMs}ms`);
  await sleep(waitMs);
}

function nowHHMM() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

app.post('/api/send', async (req, res) => {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] [HTTP] /api/send - Iniciando envio`);

  try {
    const country = (req.body && req.body.country) ? String(req.body.country) : 'BR';

    const messageRaw = normalizeNewlines(req.body?.message ?? '');
    const recipientsRaw = parseRecipientsField(req.body?.recipients);

    const file = req.files ? (req.files.file || null) : null;

    if (!recipientsRaw.length || !messageRaw) {
      return res.status(400).json({ status: 'error', message: 'Campos obrigatórios: recipients, message' });
    }

    await assertConnectedOrThrow();

    const recipientList = recipientsRaw.map((it) => {
      if (typeof it === 'string') {
        return { raw: it.trim(), vars: {} };
      }
      if (it && typeof it === 'object') {
        if (it.raw) return { raw: String(it.raw).trim(), vars: (it.vars && typeof it.vars === 'object') ? it.vars : {} };
        if (it.telefone) {
          const vars = { ...it };
          return { raw: String(it.telefone).trim(), vars };
        }
      }
      return null;
    }).filter(Boolean);

    if (!recipientList.length) {
      return res.status(400).json({ status: 'error', message: 'Nenhum destinatário válido.' });
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // ✅ BR: só normaliza, NÃO remove recipient cedo
    if (country === 'BR') {
      for (let i = 0; i < recipientList.length; i++) {
        const r = recipientList[i];
        const original = r.raw;

        const digits = onlyDigits(original);
        if (digits.length >= 10) {
          const formatted = formatPhoneNumberBrazil(original);
          if (!r.vars) r.vars = {};
          if (!r.vars.telefone) r.vars.telefone = original;
          r.vars.telefone_formatado = formatted;
          r.raw = formatted;
          console.log(`[FORMAT] ${original} -> ${formatted}`);
        }
      }
    }

    // ✅ Plano de envio (agora com padrão salvo)
    const plan = normalizeSendPlanFromBody(req.body);
    const baseForUi = getDefaultPlanObject();

    broadcast({
      type: 'send_plan',
      plan: {
        window_start: req.body?.plan?.window_start || req.body?.window_start || baseForUi.window_start || process.env.SEND_WINDOW_START || '08:00',
        window_end: req.body?.plan?.window_end || req.body?.window_end || baseForUi.window_end || process.env.SEND_WINDOW_END || '19:00',
        delay_min_ms: plan.delay_min_ms,
        delay_max_ms: plan.delay_max_ms,
        long_break_every: plan.long_break_every,
        long_break_min_ms: plan.long_break_min_ms,
        long_break_max_ms: plan.long_break_max_ms,
        hard_stop_outside_window: plan.hard_stop_outside_window,
      }
    });

    let chatsCache = null;
    async function getChatsCached() {
      if (!chatsCache) chatsCache = await waState.client.getChats();
      return chatsCache;
    }

    broadcast({ type: 'send_progress', total: recipientList.length, current: 0, step: 'starting' });

    // ✅ Enfileira (não trava a API em concorrência)
    enqueueSend(async () => {
      broadcast({ type: 'send_progress', total: recipientList.length, current: 0, step: 'sending' });

      for (let i = 0; i < recipientList.length; i++) {
        const entry = recipientList[i];
        const recipient = entry.raw;
        const progressCurrent = i + 1;

        // 1) Janela (default salvo / env / body)
        await enforceWindowOrWait(plan);

        // opcional: hard stop ao sair da janela (em vez de esperar até amanhã)
        const nowMin = nowLocalMinutes();
        if (plan.hard_stop_outside_window && !isWithinWindow(nowMin, plan.window_start_min, plan.window_end_min)) {
          const msg = `Envio pausado: fora da janela em ${nowHHMM()}.`;
          console.log('[PLAN]', msg);
          broadcast({ type: 'send_progress', total: recipientList.length, current: i, step: 'paused', message: msg });
          break;
        }

        broadcast({ type: 'send_progress', total: recipientList.length, current: progressCurrent, recipient });

        try {
          const parsed = normalizeRecipientToTarget(recipient);
          if (!parsed) {
            errorCount++;
            errors.push({ recipient, error: 'Destinatário inválido' });
            continue;
          }

          const vars = entry.vars || {};
          const mergedVars = { ...vars };

          if (!mergedVars.telefone) mergedVars.telefone = recipient;

          let finalMessage = messageRaw;

          if (parsed.type === 'number') {
            finalMessage = applyTemplateVars(finalMessage, mergedVars);

            // ✅ resolve WID
            const wid = await resolveNumberToWid(recipient);

            console.log(`[SEND] number raw="${recipient}" -> wid="${wid}"`);
            await sendMessageWithTimeout(wid, finalMessage, file);
            successCount++;
          } else {
            const chats = await getChatsCached();
            const group = chats.find(chat => chat.isGroup && chat.name === parsed.groupName);
            if (!group) {
              errorCount++;
              errors.push({ recipient, error: `Grupo não encontrado: ${parsed.groupName}` });
            } else {
              mergedVars.grupo = parsed.groupName;
              finalMessage = applyTemplateVars(finalMessage, mergedVars);
              await sendMessageWithTimeout(group.id._serialized, finalMessage, file);
              successCount++;
            }
          }

        } catch (sendError) {
          const errorMsg = sendError?.message || String(sendError);
          errorCount++;
          errors.push({ recipient, error: errorMsg });
        }

        // 2) Delay humano entre envios + pausa longa por lote
        const isLast = i >= recipientList.length - 1;
        if (!isLast) {
          // pausa longa a cada X mensagens (ex: 25)
          if (shouldTakeLongBreak(progressCurrent, plan)) {
            const longBreak = pickLongBreakMs(plan);
            console.log(`[PLAN] long break after ${progressCurrent} msgs -> ${longBreak}ms`);
            broadcast({
              type: 'send_break',
              kind: 'long',
              after: progressCurrent,
              waitMs: longBreak
            });
            await sleep(longBreak);
          } else {
            const dms = pickDelayMs(plan);
            broadcast({
              type: 'send_break',
              kind: 'short',
              after: progressCurrent,
              waitMs: dms
            });
            await sleep(dms);
          }
        }
      }

      broadcast({
        type: 'send_progress',
        total: recipientList.length,
        current: recipientList.length,
        step: 'completed',
        success: successCount,
        errors: errorCount
      });
    });

    // ✅ responde imediatamente (o envio continua na fila)
    const endTime = new Date();
    const duration = endTime - startTime;

    return res.status(200).json({
      status: 'success',
      message: `Envio enfileirado! Sucesso (até agora): ${successCount}, Erros (até agora): ${errorCount}`,
      stats: { success: successCount, errors: errorCount, duration },
      plan,
      errors: errors.slice(0, 10)
    });

  } catch (err) {
    const msg = err?.message || String(err);
    console.log('[ERR] /api/send:', msg);

    const low = msg.toLowerCase();
    if (low.includes('session closed') || low.includes('target closed') || low.includes('browser') || low.includes('protocol error')) {
      restartClient({ reason: 'send_failure_browser', wipeSession: false, doLogout: false }).catch(() => {});
    }

    return res.status(500).json({ status: 'error', message: 'Erro ao processar o envio.', error: msg });
  }
});

app.get('/api/sendMessage/:recipient/:message', async (req, res) => {
  try {
    await assertConnectedOrThrow();

    const recipientParam = (req.params.recipient || '').trim();
    const message = normalizeNewlines(decodeURIComponent(req.params.message || ''));

    if (!recipientParam) return res.status(400).json({ status: 'error', message: 'recipient obrigatório' });

    let target = normalizeRecipientToTarget(recipientParam);
    if (!target) return res.status(400).json({ status: 'error', message: 'recipient inválido' });

    let chatId = null;

    if (target.type === 'number') {
      chatId = await resolveNumberToWid(recipientParam);
    } else {
      const chats = await waState.client.getChats();
      const group = chats.find(chat => chat.isGroup && chat.name === target.groupName);
      if (!group) return res.status(404).json({ status: 'error', message: `Grupo "${target.groupName}" não encontrado.` });
      chatId = group.id._serialized;
    }

    await enqueueSend(async () => { await sendMessageWithTimeout(chatId, message, null); });

    return res.status(200).json({ status: 'success', message: 'Mensagem enfileirada/enviada!' });
  } catch (err) {
    const msg = err?.message || String(err);
    console.log('[ERR] /api/sendMessage:', msg);

    const low = msg.toLowerCase();
    if (low.includes('session closed') || low.includes('target closed') || low.includes('browser') || low.includes('protocol error')) {
      restartClient({ reason: 'sendMessage_failure_browser', wipeSession: false, doLogout: false }).catch(() => {});
    }

    return res.status(500).json({ status: 'error', message: 'Erro ao enviar mensagem.', error: msg });
  }
});

app.listen(port, () => {
  console.log(`[HTTP] API rodando na porta ${port}`);
  console.log(`[WS] WS rodando na porta ${wsPort}`);
});

async function shutdown(sig) {
  console.log(`[SYS] shutdown (${sig})`);
  stopWatchdog();

  try { broadcast({ type: 'shutdown', sig }); } catch {}

  try { await stopClient({ reason: `shutdown:${sig}`, doLogout: false, wipeSession: false }); } catch {}
  try { wss.close(() => {}); } catch {}

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.log('[SYS] uncaughtException:', err?.message || err);
  restartClient({ reason: 'uncaughtException', wipeSession: false, doLogout: false }).catch(() => {});
});

process.on('unhandledRejection', (err) => {
  console.log('[SYS] unhandledRejection:', err?.message || err);
  restartClient({ reason: 'unhandledRejection', wipeSession: false, doLogout: false }).catch(() => {});
});
