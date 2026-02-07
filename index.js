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

// importante: pra multipart + texto vir em req.body
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

  // envia snapshot do job atual + fila (se existir)
  try {
    const snap = getSendSnapshot();
    ws.send(JSON.stringify({ type: 'send_job', event: 'snapshot', ...snap }));
  } catch {}
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

// ACK / entrega
const WA_ACK_TIMEOUT_MS = Number(process.env.WA_ACK_TIMEOUT_MS || 15000); // 15s
const WA_ACK_MIN_LEVEL = Number(process.env.WA_ACK_MIN_LEVEL || 1); // 1 = server received

// versão do WhatsApp Web
const WA_WEB_VERSION = (process.env.WA_WEB_VERSION || '').trim();
const WA_WEB_REMOTE_PATH =
  (process.env.WA_WEB_REMOTE_PATH || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html').trim();

console.log('[BOOT] WA_WEB_VERSION:', WA_WEB_VERSION || '(auto/default)');
console.log('[BOOT] WA_WEB_REMOTE_PATH:', WA_WEB_REMOTE_PATH);

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

    qrMaxRetries: Number(process.env.WA_QR_MAX_RETRIES || 10),

    takeoverOnConflict: true,
    takeoverTimeoutMs: 3000,

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

// ====== ACK tracking
// Map: messageIdSerialized -> { minLevel, resolve, reject, timer, lastAck }
const ackWaiters = new Map();

function ackKeyFromMessage(msg) {
  const id = msg?.id;
  const key = id?._serialized || id?.serialized || null;
  return key || null;
}

function waitForAck(messageIdSerialized, minLevel, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!messageIdSerialized) return reject(new Error('ACK: message id inválido'));

    // se já existe waiter, cancela o anterior
    const existing = ackWaiters.get(messageIdSerialized);
    if (existing) {
      try { clearTimeout(existing.timer); } catch {}
      ackWaiters.delete(messageIdSerialized);
    }

    const timer = setTimeout(() => {
      ackWaiters.delete(messageIdSerialized);
      reject(new Error(`SEM ACK (${timeoutMs}ms)`));
    }, Math.max(1000, Number(timeoutMs || 0)));

    ackWaiters.set(messageIdSerialized, {
      minLevel: Number.isFinite(minLevel) ? minLevel : 1,
      resolve,
      reject,
      timer,
      lastAck: 0,
    });
  });
}

function handleAckEvent(msg, ack) {
  const key = ackKeyFromMessage(msg);
  if (!key) return;

  const waiter = ackWaiters.get(key);
  if (!waiter) return;

  const level = Number(ack || 0);
  waiter.lastAck = level;

  if (level >= waiter.minLevel) {
    try { clearTimeout(waiter.timer); } catch {}
    ackWaiters.delete(key);
    waiter.resolve(level);
  }
}

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

    // limpa ack waiters
    try {
      for (const [k, w] of ackWaiters.entries()) {
        try { clearTimeout(w.timer); } catch {}
        try { w.reject(new Error('Client parou')); } catch {}
        ackWaiters.delete(k);
      }
    } catch {}

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

  // OUTGOING ACK (CONFIRMAÇÃO DE ENVIO)
  client.on('message_ack', (msg, ack) => {
    try {
      // ack: 0..3 (depende da lib/versão)
      handleAckEvent(msg, ack);
    } catch {}
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
// CONFIG PERSISTENTE DO PLANO DE ENVIO (send_plan.json)
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

// ===== Public config.js
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  const cfg = { wsPort, sendPlan: getDefaultPlanObject() };
  res.send(`
/* config.js (gerado pelo servidor) */
window.__WS_PORT__ = ${JSON.stringify(cfg.wsPort)};
window.__SEND_PLAN_DEFAULT__ = ${JSON.stringify(cfg.sendPlan)};
`);
});

// ===== API simples (para compatibilidade do seu front)
app.get('/api/plan', (req, res) => {
  return res.json(getDefaultPlanObject());
});

app.post('/api/plan', (req, res) => {
  try {
    const sanitized = sanitizePlanInput(req.body || {});
    persistedSendPlan = { ...sanitized };
    writeJsonAtomic(SEND_PLAN_FILE, persistedSendPlan);
    broadcast({ type: 'send_plan_saved', plan: persistedSendPlan });
    return res.json({ status: 'success', message: 'Configuração salva.', plan: persistedSendPlan });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: 'Falha ao salvar configuração.', error: e?.message || String(e) });
  }
});

// ============================================================
// SEND ENGINE (fila + progress + pause/resume/cancel)
// ============================================================
function nowMs() { return Date.now(); }
function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (b <= a) return a;
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const hh = clamp(parseInt(m[1], 10), 0, 23);
  const mm = clamp(parseInt(m[2], 10), 0, 59);
  return hh * 60 + mm;
}

function minutesNowLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isWithinWindowServer(plan) {
  const start = hhmmToMinutes(plan.window_start);
  const end = hhmmToMinutes(plan.window_end);
  const nowMin = minutesNowLocal();

  if (start === end) return true;
  if (start < end) return (nowMin >= start && nowMin < end);
  return (nowMin >= start || nowMin < end);
}

function msUntilNextWindowStart(plan) {
  const start = hhmmToMinutes(plan.window_start);
  const end = hhmmToMinutes(plan.window_end);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (start === end) return 0;

  // janela normal
  if (start < end) {
    if (nowMin < start) {
      const target = new Date(now.getTime());
      target.setHours(Math.floor(start / 60), start % 60, 0, 0);
      return Math.max(0, target.getTime() - now.getTime());
    }
    if (nowMin >= end) {
      const target = new Date(now.getTime());
      target.setDate(target.getDate() + 1);
      target.setHours(Math.floor(start / 60), start % 60, 0, 0);
      return Math.max(0, target.getTime() - now.getTime());
    }
    return 0;
  }

  // janela invertida (ex: 22:00–06:00)
  const inWin = (nowMin >= start || nowMin < end);
  if (inWin) return 0;

  const target = new Date(now.getTime());
  target.setHours(Math.floor(start / 60), start % 60, 0, 0);
  return Math.max(0, target.getTime() - now.getTime());
}

const TEMP_UPLOAD_DIR = path.join(__dirname, 'uploads_tmp');
function ensureDir(dir) { try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {} }
ensureDir(TEMP_UPLOAD_DIR);

function safeUnlink(filePath) { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {} }

async function saveUploadedFilesToDisk(req) {
  const out = [];
  const filesObj = req.files || {};
  const keys = Object.keys(filesObj);

  for (const key of keys) {
    const f = filesObj[key];
    if (!f) continue;

    // express-fileupload pode dar array
    if (Array.isArray(f)) {
      for (const fx of f) {
        const saved = await saveOneFile(fx);
        if (saved) out.push(saved);
      }
    } else {
      const saved = await saveOneFile(f);
      if (saved) out.push(saved);
    }
  }

  // limita
  return out.slice(0, 5);

  async function saveOneFile(file) {
    try {
      const name = String(file.name || 'file.bin').replace(/[^\w.\-() ]+/g, '_');
      const fp = path.join(TEMP_UPLOAD_DIR, `${Date.now()}_${Math.random().toString(16).slice(2)}_${name}`);
      await file.mv(fp);
      return { path: fp, name: name, mimetype: file.mimetype || '' };
    } catch (e) {
      console.log('[WARN] falha salvando arquivo:', e?.message || e);
      return null;
    }
  }
}

function normalizeRecipients(rawRecipients) {
  // rawRecipients vem como JSON string no form: [{"raw":"...","label":"...","vars":{...}}]
  let arr = [];
  try {
    if (typeof rawRecipients === 'string') arr = JSON.parse(rawRecipients);
    else if (Array.isArray(rawRecipients)) arr = rawRecipients;
  } catch { arr = []; }

  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const raw = String(r.raw || '').trim();
    if (!raw) continue;
    out.push({
      raw,
      label: String(r.label || raw),
      vars: (r.vars && typeof r.vars === 'object') ? r.vars : {},
    });
  }
  return out;
}

function normalizeMessage(str) {
  let t = String(str ?? '');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\u2028|\u2029/g, '\n');
  t = t.replace(/\u00A0/g, ' ');
  t = t.replace(/[ \t]+\n/g, '\n');
  return t;
}

function applyVarsToText(text, vars) {
  const src = normalizeMessage(text);
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

function looksLikeGroupId(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.includes('@g.us')) return true;
  // alguns grupos vêm como "1203....-...." sem @g.us
  return /^1203\d{8,}-\d+$/g.test(t) || /^(\d+)-(\d+)$/g.test(t);
}

function extractDigits(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

function normalizeNumberByCountry(digits, country) {
  const c = String(country || '').trim().toUpperCase();

  if (!digits) return '';

  // BR: se usuário mandou sem DDI e parece DDD+numero (10/11), prefixa 55
  if (c === 'BR') {
    if (digits.startsWith('55')) return digits;
    if (digits.length === 10 || digits.length === 11) return `55${digits}`;
    return digits; // já veio completo ou é algo diferente
  }

  // US: prefixa 1 quando 10 dígitos
  if (c === 'US') {
    if (digits.startsWith('1')) return digits;
    if (digits.length === 10) return `1${digits}`;
    return digits;
  }

  // OTHER: não mexe
  return digits;
}

async function resolveWaTarget(client, raw, country) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Destinatário vazio');

  // já é jid
  if (s.includes('@c.us') || s.includes('@g.us')) {
    // valida grupo se for g.us
    if (s.includes('@g.us')) {
      try {
        await client.getChatById(s);
      } catch {
        throw new Error(`Grupo inválido/inacessível: ${s}`);
      }
    }
    return s;
  }

  // grupo sem @g.us
  if (looksLikeGroupId(s)) {
    const gid = s.includes('@g.us') ? s : `${s}@g.us`;
    try {
      await client.getChatById(gid);
    } catch {
      throw new Error(`Grupo inválido/inacessível: ${gid}`);
    }
    return gid;
  }

  // número
  const digits0 = extractDigits(s);
  const digits = normalizeNumberByCountry(digits0, country);

  if (!digits || digits.length < 8) throw new Error(`Número inválido: ${s}`);

  // valida se existe no WhatsApp
  // getNumberId retorna null/undefined quando não existe
  let numberId;
  try {
    numberId = await client.getNumberId(digits);
  } catch (e) {
    // algumas versões esperam número sem +
    throw new Error(`Falha getNumberId(${digits}): ${e?.message || String(e)}`);
  }

  const jid =
    numberId?._serialized ||
    numberId?.serialized ||
    numberId?.id?._serialized ||
    numberId?.id?.serialized ||
    null;

  if (!jid) {
    throw new Error(`Número não registrado no WhatsApp: ${digits}`);
  }

  return jid;
}

function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

let sendQueue = [];
let sendProcessing = false;
let activeJob = null;

// controle global (botões do front)
let controlState = {
  paused: false,
  canceled: false,
  pauseReason: '',
};

function getSendSnapshot() {
  const q = sendQueue.map(j => ({ jobId: j.id, total: j.total, createdAt: j.createdAt, state: j.state }));
  const a = activeJob ? {
    jobId: activeJob.id,
    total: activeJob.total,
    current: activeJob.current,
    success: activeJob.success,
    failed: activeJob.failed,
    state: activeJob.state,
    label: activeJob.label || '',
    createdAt: activeJob.createdAt,
    startedAt: activeJob.startedAt || 0,
  } : null;

  return {
    jobId: a?.jobId || null,
    active: a,
    queue: q,
    paused: controlState.paused,
    canceled: controlState.canceled
  };
}

function emitJobEvent(job, event, extra = {}) {
  broadcast({
    type: 'send_job',
    event,
    jobId: job?.id || null,
    state: job?.state || null,
    total: job?.total || 0,
    current: job?.current || 0,
    success: job?.success || 0,
    failed: job?.failed || 0,
    label: job?.label || '',
    message: job?.messageHint || '',
    ...extra
  });
}

function setPaused(paused, reason) {
  controlState.paused = !!paused;
  controlState.pauseReason = reason ? String(reason) : '';
}

function setCanceled(canceled) {
  controlState.canceled = !!canceled;
}

async function waitWhilePausedOrCanceled(job) {
  while (true) {
    if (controlState.canceled || job.canceled) {
      job.canceled = true;
      job.state = 'CANCELED';
      emitJobEvent(job, 'canceled', { message: 'Cancelado pelo operador.' });
      throw new Error('JOB_CANCELED');
    }

    if (!controlState.paused && !job.paused) return;

    job.state = 'PAUSED';
    emitJobEvent(job, 'paused', { message: controlState.pauseReason || job.pauseReason || 'Pausado.' });

    await sleep(700);
  }
}

async function sleepWithControl(job, ms, kindLabel) {
  const total = Math.max(0, Number(ms || 0));
  if (!total) return;

  const step = 500;
  let waited = 0;
  while (waited < total) {
    await waitWhilePausedOrCanceled(job);
    const chunk = Math.min(step, total - waited);
    await sleep(chunk);
    waited += chunk;

    if (kindLabel && (waited % 2000 < step)) {
      emitJobEvent(job, 'tick', {
        label: kindLabel,
        state: job.state,
        message: `${kindLabel}: ${Math.ceil((total - waited) / 1000)}s`
      });
    }
  }
}

async function processQueueLoop() {
  if (sendProcessing) return;
  sendProcessing = true;

  try {
    while (sendQueue.length > 0) {
      const job = sendQueue.shift();
      activeJob = job;

      job.startedAt = nowMs();
      job.state = 'RUNNING';
      job.current = 0;
      job.success = 0;
      job.failed = 0;
      job.paused = false;
      job.canceled = false;

      setCanceled(false);

      emitJobEvent(job, 'started', { message: 'Iniciando envio...' });

      try {
        await runJob(job);
        if (!job.canceled) {
          job.state = 'DONE';
          emitJobEvent(job, 'completed', { message: 'Concluído.' });
        }
      } catch (e) {
        const msg = e?.message || String(e);

        if (msg === 'JOB_CANCELED') {
          // já emitiu canceled
        } else {
          job.state = 'ERROR';
          emitJobEvent(job, 'error', { message: msg || 'Erro no job.' });
        }
      } finally {
        try {
          for (const f of (job.files || [])) safeUnlink(f.path);
        } catch {}

        activeJob = null;
      }
    }
  } finally {
    sendProcessing = false;
  }
}

async function runJob(job) {
  const client = waState.client;
  if (!client || !waState.authenticated) throw new Error('WhatsApp não está conectado.');

  const plan = sanitizePlanInput(job.plan || {});
  const recipients = Array.isArray(job.recipients) ? job.recipients : [];
  const total = recipients.length;

  job.total = total;

  if (!total) throw new Error('Lista de destinatários vazia.');

  emitJobEvent(job, 'tick', { current: 0, total, success: 0, failed: 0, state: 'RUNNING', label: 'Preparando...' });

  // janela
  while (!isWithinWindowServer(plan)) {
    await waitWhilePausedOrCanceled(job);

    const waitMs = msUntilNextWindowStart(plan);
    if (!waitMs) break;

    job.state = 'WAIT_WINDOW';
    emitJobEvent(job, 'wait_window', {
      message: `Fora da janela (${plan.window_start}–${plan.window_end}) • aguardando ${Math.ceil(waitMs/1000)}s`,
      waitMs
    });

    if (plan.hard_stop_outside_window) {
      setPaused(true, `Fora da janela (${plan.window_start}–${plan.window_end})`);
      job.paused = true;
      job.pauseReason = `Fora da janela (${plan.window_start}–${plan.window_end})`;
      await waitWhilePausedOrCanceled(job);
    } else {
      await sleepWithControl(job, waitMs, 'FORA DA JANELA');
    }
  }

  job.state = 'RUNNING';
  emitJobEvent(job, 'resumed', { message: 'Dentro da janela. Iniciando envios.' });

  for (let i = 0; i < total; i++) {
    await waitWhilePausedOrCanceled(job);

    while (!isWithinWindowServer(plan)) {
      await waitWhilePausedOrCanceled(job);

      const waitMs = msUntilNextWindowStart(plan);
      if (!waitMs) break;

      job.state = 'WAIT_WINDOW';
      emitJobEvent(job, 'wait_window', {
        current: job.current,
        total: job.total,
        success: job.success,
        failed: job.failed,
        message: `Fora da janela (${plan.window_start}–${plan.window_end}) • aguardando ${Math.ceil(waitMs/1000)}s`,
        waitMs
      });

      if (plan.hard_stop_outside_window) {
        setPaused(true, `Fora da janela (${plan.window_start}–${plan.window_end})`);
        job.paused = true;
        job.pauseReason = `Fora da janela (${plan.window_start}–${plan.window_end})`;
        await waitWhilePausedOrCanceled(job);
      } else {
        await sleepWithControl(job, waitMs, 'FORA DA JANELA');
      }
    }

    const r = recipients[i];
    const raw = r?.raw || '';
    const label = r?.label || raw;

    const text = applyVarsToText(job.message, r?.vars || {});
    job.label = label;
    job.state = 'RUNNING';

    emitJobEvent(job, 'tick', {
      current: job.current,
      total: job.total,
      success: job.success,
      failed: job.failed,
      state: job.state,
      label: `RESOLVENDO: ${label}`
    });

    let target = null;
    try {
      target = await resolveWaTarget(client, raw, job.country || 'BR');
    } catch (e) {
      job.current += 1;
      job.failed += 1;
      emitJobEvent(job, 'tick', {
        current: job.current,
        total: job.total,
        success: job.success,
        failed: job.failed,
        state: job.state,
        label: `FALHA (DESTINO): ${label}`,
        message: e?.message || String(e)
      });
      // segue pro próximo
      continue;
    }

    emitJobEvent(job, 'tick', {
      current: job.current,
      total: job.total,
      success: job.success,
      failed: job.failed,
      state: job.state,
      label: `ENVIANDO PARA: ${label}`
    });

    try {
      // anexos
      if (job.files && job.files.length) {
        for (const file of job.files) {
          await waitWhilePausedOrCanceled(job);

          const media = MessageMedia.fromFilePath(file.path);
          const sentMediaMsg = await client.sendMessage(target, media, { caption: '' });

          const mediaId = ackKeyFromMessage(sentMediaMsg);
          if (mediaId) {
            await waitForAck(mediaId, WA_ACK_MIN_LEVEL, WA_ACK_TIMEOUT_MS);
          } else {
            // se não tem id, não dá pra esperar ack; força falha "honesta"
            throw new Error('Sem ID da mídia para aguardar ACK');
          }

          await sleepWithControl(job, 600, 'ENVIANDO MÍDIA');
        }
      }

      const sentTextMsg = await client.sendMessage(target, text);

      const msgId = ackKeyFromMessage(sentTextMsg);
      if (msgId) {
        await waitForAck(msgId, WA_ACK_MIN_LEVEL, WA_ACK_TIMEOUT_MS);
      } else {
        throw new Error('Sem ID da mensagem para aguardar ACK');
      }

      job.current += 1;
      job.success += 1;

      emitJobEvent(job, 'tick', {
        current: job.current,
        total: job.total,
        success: job.success,
        failed: job.failed,
        state: job.state,
        label: `ENVIADO (ACK): ${label}`
      });
    } catch (e) {
      job.current += 1;
      job.failed += 1;

      emitJobEvent(job, 'tick', {
        current: job.current,
        total: job.total,
        success: job.success,
        failed: job.failed,
        state: job.state,
        label: `FALHA: ${label}`,
        message: e?.message || String(e)
      });
    }

    if (i < total - 1) {
      const nextIndex = i + 1;
      const every = Math.max(0, Number(plan.long_break_every || 0));
      const doLong = (every > 0) ? (nextIndex % every === 0) : false;

      if (doLong) {
        const waitMs = randInt(plan.long_break_min_ms, plan.long_break_max_ms);
        emitJobEvent(job, 'tick', {
          current: job.current,
          total: job.total,
          success: job.success,
          failed: job.failed,
          state: job.state,
          label: `PAUSA LONGA (${Math.ceil(waitMs/1000)}s)`
        });
        await sleepWithControl(job, waitMs, 'PAUSA LONGA');
      } else {
        const waitMs = randInt(plan.delay_min_ms, plan.delay_max_ms);
        emitJobEvent(job, 'tick', {
          current: job.current,
          total: job.total,
          success: job.success,
          failed: job.failed,
          state: job.state,
          label: `DELAY (${Math.ceil(waitMs/1000)}s)`
        });
        await sleepWithControl(job, waitMs, 'DELAY');
      }
    }
  }
}

// ===== API: controle pause/resume/cancel
app.post('/api/send-control', (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const jobId = String(req.body?.jobId || '').trim();

    const job = activeJob;

    if (!job) {
      if (action === 'pause') setPaused(true, 'Pausado (sem job ativo).');
      if (action === 'resume') setPaused(false, '');
      if (action === 'cancel') setCanceled(true);
      return res.json({ status: 'success', message: 'Sem job ativo.' });
    }

    if (jobId && job.id && jobId !== job.id) {
      return res.json({ status: 'success', message: 'JobId não bateu. Controle aplicado ao job ativo.', activeJobId: job.id });
    }

    if (action === 'pause') {
      setPaused(true, 'Pausado pelo operador.');
      job.paused = true;
      job.pauseReason = 'Pausado pelo operador.';
      emitJobEvent(job, 'paused', { message: job.pauseReason });
      return res.json({ status: 'success', message: 'Pausado.' });
    }

    if (action === 'resume') {
      setPaused(false, '');
      job.paused = false;
      job.pauseReason = '';
      emitJobEvent(job, 'resumed', { message: 'Retomado.' });
      return res.json({ status: 'success', message: 'Retomado.' });
    }

    if (action === 'cancel') {
      setCanceled(true);
      job.canceled = true;
      emitJobEvent(job, 'canceled', { message: 'Cancelado pelo operador.' });
      return res.json({ status: 'success', message: 'Cancelamento solicitado.' });
    }

    return res.status(400).json({ status: 'error', message: 'Ação inválida. Use pause|resume|cancel.' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: 'Falha ao controlar envio.', error: e?.message || String(e) });
  }
});

// ===== API: criar job e enfileirar
app.post('/api/send', async (req, res) => {
  try {
    if (!waState.client || !waState.authenticated) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp não está conectado.' });
    }

    const recipientsRaw = req.body?.recipients;
    const messageRaw = req.body?.message;
    const planRaw = req.body?.plan;

    const country = String(req.body?.country || 'BR').trim().toUpperCase();

    const recipients = normalizeRecipients(recipientsRaw);
    const message = normalizeMessage(messageRaw);

    if (!message || !message.replace(/\s/g, '').length) {
      return res.status(400).json({ status: 'error', message: 'Mensagem vazia.' });
    }
    if (!recipients.length) {
      return res.status(400).json({ status: 'error', message: 'Destinatários vazios.' });
    }

    let planObj = null;
    try {
      planObj = planRaw ? JSON.parse(String(planRaw)) : null;
    } catch {
      planObj = null;
    }

    const files = await saveUploadedFilesToDisk(req);

    const job = {
      id: newJobId(),
      createdAt: nowMs(),
      startedAt: 0,
      state: 'QUEUED',
      total: recipients.length,
      current: 0,
      success: 0,
      failed: 0,
      label: '',
      messageHint: '',
      recipients,
      message,
      plan: planObj || getDefaultPlanObject(),
      files,
      paused: false,
      pauseReason: '',
      canceled: false,
      country,
    };

    sendQueue.push(job);

    emitJobEvent(job, 'queued', { message: 'Enfileirado.' });

    processQueueLoop().catch(() => {});

    return res.json({
      status: 'success',
      message: `Envio enfileirado com sucesso.`,
      jobId: job.id,
      total: job.total
    });
  } catch (e) {
    console.log('[ERR] /api/send:', e?.message || e);
    return res.status(500).json({ status: 'error', message: 'Falha ao enfileirar envio.', error: e?.message || String(e) });
  }
});

// ============================================================
// ROTAS DE QR/STATUS/RESET
// ============================================================
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

    return res.send('Desconectado. Gere um novo QR se necessário.');
  } catch (e) {
    console.log('[ERR] /api/disconnect:', e?.message || e);
    return res.status(500).send('Falha ao desconectar.');
  }
});

app.get('/api/reset', async (req, res) => {
  try {
    broadcast({ type: 'manual_reset' });

    await restartClient({ reason: 'manual_reset', wipeSession: true, doLogout: true });

    return res.send('Sessão resetada. Gere novo QR.');
  } catch (e) {
    console.log('[ERR] /api/reset:', e?.message || e);
    return res.status(500).send('Falha ao resetar sessão.');
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(port, () => {
  console.log(`[HTTP] API rodando na porta ${port}`);
  console.log(`[WS] WS rodando na porta ${wsPort}`);
});

// graceful shutdown
async function shutdown() {
  try { stopWatchdog(); } catch {}
  try {
    setCanceled(true);
    sendQueue = [];
  } catch {}

  try { await stopClient({ reason: 'shutdown', wipeSession: false, doLogout: false }); } catch {}
  try { wss.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
