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
// remotePath com {version} é o formato esperado pelo RemoteWebCache :contentReference[oaicite:2]{index=2}
const WA_WEB_REMOTE_PATH =
  (process.env.WA_WEB_REMOTE_PATH || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html').trim();

console.log('[BOOT] WA_WEB_VERSION:', WA_WEB_VERSION || '(auto/default)');
console.log('[BOOT] WA_WEB_REMOTE_PATH:', WA_WEB_REMOTE_PATH);

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
    // docs: Client options webVersion / webVersionCache :contentReference[oaicite:3]{index=3}
    webVersionCache: {
      type: 'remote',
      remotePath: WA_WEB_REMOTE_PATH,
      strict: false,
    },
  };

  if (WA_WEB_VERSION) {
    opts.webVersion = WA_WEB_VERSION;
  }

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

// ===== Public config
app.get('/config.js', (req, res) => {
  const wsPort = process.env.WS_PORT || 8080;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__WS_PORT__ = ${JSON.stringify(wsPort)};`);
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

function normalizeRecipientToChatId(raw) {
  const recipientTrimmed = (raw || '').trim();
  if (!recipientTrimmed) return null;

  if (/^\+?\d+$/.test(recipientTrimmed.replace(/\D/g,''))) {
    let number = recipientTrimmed.replace(/\D/g, '');

    // Removed the code that removes the 9 digit for Brazilian mobile numbers
    // to accommodate modern 9-digit mobile plans introduced in 2016

    return number + '@c.us';
  }

  return { groupName: recipientTrimmed };
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatPhoneNumberBrazil(phone) {
  if (!phone) return '';

  let cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.startsWith('55') && cleanPhone.length > 2) cleanPhone = cleanPhone.substring(2);

  cleanPhone = '55' + cleanPhone;

  // Removed the code that removes the 9 digit for Brazilian mobile numbers
  // to accommodate modern 9-digit mobile plans introduced in 2016

  return cleanPhone;
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

app.post('/api/send', async (req, res) => {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] [HTTP] /api/send - Iniciando envio`);

  try {
    const delaySec = (req.body && req.body.delay !== undefined) ? req.body.delay : 1.2;
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

    if (country === 'BR') {
      for (const r of recipientList) {
        const digits = String(r.raw || '').replace(/\D/g,'');
        if (digits.length >= 8) {
          const formatted = formatPhoneNumberBrazil(r.raw);
          if (!r.vars) r.vars = {};
          if (!r.vars.telefone) r.vars.telefone = r.raw;
          r.vars.telefone_formatado = formatted;
          r.raw = formatted;
        }
      }
    }

    const delayMs = Math.max(0, Math.min(Number(delaySec) * 1000, 60000));

    let chatsCache = null;
    async function getChatsCached() {
      if (!chatsCache) chatsCache = await waState.client.getChats();
      return chatsCache;
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    broadcast({ type: 'send_progress', total: recipientList.length, current: 0, step: 'starting' });

    await enqueueSend(async () => {
      broadcast({ type: 'send_progress', total: recipientList.length, current: 0, step: 'sending' });

      for (let i = 0; i < recipientList.length; i++) {
        const entry = recipientList[i];
        const recipient = entry.raw;
        const progressCurrent = i + 1;

        broadcast({ type: 'send_progress', total: recipientList.length, current: progressCurrent, recipient });

        try {
          const parsed = normalizeRecipientToChatId(recipient);
          if (!parsed) {
            errorCount++;
            errors.push({ recipient, error: 'Destinatário inválido' });
            continue;
          }

          const vars = entry.vars || {};
          const mergedVars = { ...vars };

          if (!mergedVars.telefone) mergedVars.telefone = recipient;

          let finalMessage = messageRaw;

          if (typeof parsed === 'string') {
            finalMessage = applyTemplateVars(finalMessage, mergedVars);
            await sendMessageWithTimeout(parsed, finalMessage, file);
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

          if (i < recipientList.length - 1 && delayMs > 0) await delay(delayMs);

        } catch (sendError) {
          const errorMsg = sendError?.message || String(sendError);
          errorCount++;
          errors.push({ recipient, error: errorMsg });
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

    const endTime = new Date();
    const duration = endTime - startTime;

    return res.status(200).json({
      status: 'success',
      message: `Mensagens enviadas! Sucesso: ${successCount}, Erros: ${errorCount}`,
      stats: { success: successCount, errors: errorCount, duration },
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

    let chatIdOrGroup = normalizeRecipientToChatId(recipientParam);
    if (!chatIdOrGroup) return res.status(400).json({ status: 'error', message: 'recipient inválido' });

    if (typeof chatIdOrGroup !== 'string') {
      const chats = await waState.client.getChats();
      const group = chats.find(chat => chat.isGroup && chat.name === chatIdOrGroup.groupName);
      if (!group) return res.status(404).json({ status: 'error', message: `Grupo "${chatIdOrGroup.groupName}" não encontrado.` });
      chatIdOrGroup = group.id._serialized;
    }

    await enqueueSend(async () => { await sendMessageWithTimeout(chatIdOrGroup, message, null); });

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
