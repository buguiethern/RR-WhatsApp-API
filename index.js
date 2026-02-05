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

// ✅ Confie em proxy só quando faz sentido (reverse proxy / docker)
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
app.use(fileUpload());

// ===== WebSocket (QR e status)
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

  // manda o último estado atual
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
const STATE_STUCK_TIMEOUT_MS = Number(process.env.WA_STUCK_TIMEOUT_MS || 90000); // se ficar muito tempo sem state ok
const DESTROY_TIMEOUT_MS = Number(process.env.WA_DESTROY_TIMEOUT_MS || 12000);
const LOGOUT_TIMEOUT_MS = Number(process.env.WA_LOGOUT_TIMEOUT_MS || 12000);

// fila simples pra evitar concorrência de sendMessage
let sendChain = Promise.resolve();
function enqueueSend(fn) {
  sendChain = sendChain.then(fn).catch(() => {});
  return sendChain;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.log('[WARN] Falha ao remover dir:', dir, e?.message || e);
  }
}

function getPuppeteerOptions() {
  const executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  // args mais “docker-friendly”
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
  ];

  // em alguns VPS, ajuda
  if ((process.env.WA_SINGLE_PROCESS || '').toLowerCase() === 'true') args.push('--single-process');

  return {
    headless: true,
    args,
    defaultViewport: null,
    timeout: 0,
    executablePath,
  };
}

function buildClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: getPuppeteerOptions(),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 3000,
  });
  return client;
}

function setState(nextState) {
  waState.lastKnownState = nextState;
  broadcast({ type: 'state', state: nextState, authenticated: waState.authenticated });
}

function clearQr() {
  waState.qrCodeData = null;
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

    if (c) {
      try {
        c.removeAllListeners();
      } catch {}

      if (doLogout) {
        try {
          await withTimeout(c.logout(), LOGOUT_TIMEOUT_MS, 'client.logout');
        } catch (e) {
          console.log('[WARN] logout falhou:', e?.message || e);
        }
      }

      try {
        await withTimeout(c.destroy(), DESTROY_TIMEOUT_MS, 'client.destroy');
      } catch (e) {
        // há casos em que destroy fica preso depois de browser disconnect -> timeout aqui evita travar processo
        console.log('[WARN] destroy falhou/timeout:', e?.message || e);
      }
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

    // initialize pode lançar
    try {
      c.initialize();
    } catch (e) {
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
    // não marque como “ready” aqui; só quando estado estiver CONNECTED e/ou ready disparar
    broadcast({ type: 'authenticated' });
  });

  client.on('ready', async () => {
    console.log('[WA] ready!');
    clearQr();

    // respiro
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
    // CONNECTED = considerado “autenticado” para envio
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

    // auth_failure geralmente pede limpeza de sessão
    await restartClient({ reason: 'auth_failure', wipeSession: true, doLogout: false });
  });

  client.on('disconnected', async (reason) => {
    console.log('[WA] disconnected:', reason);
    waState.lastErrorAt = Date.now();
    waState.authenticated = false;
    clearQr();
    setState('DISCONNECTED');
    broadcast({ type: 'disconnected', reason });

    // alguns reasons podem ser resolvidos sem wipe, outros pedem wipe
    const r = String(reason || '').toLowerCase();
    const shouldWipe = r.includes('logout') || r.includes('unpaired') || r.includes('auth') || r.includes('banned');
    await restartClient({ reason: `disconnected:${reason}`, wipeSession: shouldWipe, doLogout: false });
  });

  // ✅ Comando de teste: mande "!ping"
  client.on('message', async (msg) => {
    try {
      if (msg.type === 'chat' && (msg.body || '').toLowerCase().trim() === '!ping') {
        await client.sendMessage(msg.from, 'PONG');
      }
    } catch (e) {
      console.log('[WARN] erro no handler message:', e?.message || e);
    }
  });

  // ✅ Recusa chamadas
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

// Watchdog: se getState começar a falhar ou ficar “travado”, reinicia
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
  watchdogTimer = setInterval(() => {
    watchdogTick().catch(() => {});
  }, STATE_WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

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
    if (waState.authenticated && waState.client) {
      return res.json({ status: 'connected', message: 'Cliente já está conectado' });
    }

    if (!waState.qrCodeData) {
      return res.json({ status: 'waiting', message: 'QR Code ainda não foi gerado, tente novamente em alguns segundos' });
    }

    const qrCodeImage = await QRCode.toDataURL(waState.qrCodeData);
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
    try {
      state = await waState.client.getState();
    } catch {}

    const number = waState.client?.info?.wid?.user || null;

    if (state === 'CONNECTED') {
      return res.json({ status: 'connected', number, state, authenticated: true });
    }

    return res.json({ status: 'connecting', number, state, authenticated: false });
  } catch (err) {
    console.log('[ERR] /api/status:', err?.message || err);
    return res.status(500).json({ status: 'error', message: 'Erro ao consultar status', error: err?.message || String(err) });
  }
});

// 🔥 Desconectar (sem wipe) e recriar
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

// 🔥 Desconectar e limpar sessão (força novo QR)
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

  // getState pode falhar quando puppeteer morreu
  const st = await c.getState();
  if (st !== 'CONNECTED') throw new Error(`Cliente não conectado (state=${st}).`);

  if (!waState.authenticated) {
    // normaliza
    waState.authenticated = true;
  }
}

const sendMessageWithTimeout = async (chatId, message, file, timeout = 25000) => {
  const c = waState.client;
  if (!c) throw new Error('Cliente não inicializado.');

  return await withTimeout(
    (async () => {
      const imageRegex = /\[img\s*=\s*(https?:\/\/[^\s]+)\]/i;
      const pdfRegex = /\[pdf\s*=\s*(https?:\/\/[^\s]+)\]/i;

      let match = (message || '').match(imageRegex);
      if (match) {
        const imageUrl = match[1];
        const media = await MessageMedia.fromUrl(imageUrl);
        await c.sendMessage(chatId, media, { caption: (message || '').replace(imageRegex, '').trim() });
        return;
      }

      match = (message || '').match(pdfRegex);
      if (match) {
        const pdfUrl = match[1];
        const media = await MessageMedia.fromUrl(pdfUrl);
        await c.sendMessage(chatId, media, { caption: (message || '').replace(pdfRegex, '').trim() });
        return;
      }

      if (file) {
        const tmpName = `${Date.now()}_${Math.random().toString(16).slice(2)}_${file.name}`;
        const filePath = path.join('/tmp', tmpName);
        await file.mv(filePath);

        try {
          const media = MessageMedia.fromFilePath(filePath);
          await c.sendMessage(chatId, media, { caption: message || '' });
        } finally {
          fs.unlink(filePath, () => {});
        }
        return;
      }

      await c.sendMessage(chatId, message || '');
    })(),
    timeout,
    'sendMessageWithTimeout'
  );
};

function normalizeRecipientToChatId(raw) {
  const recipientTrimmed = (raw || '').trim();
  if (!recipientTrimmed) return null;

  if (/^\+?\d+$/.test(recipientTrimmed)) {
    let number = recipientTrimmed.replace(/\D/g, '');

    // remove nono dígito (BR) se for 55 + DDD + 9xxxxxxxx (13)
    if (number.startsWith('55') && number.length === 13) {
      number = number.slice(0, 4) + number.slice(5);
    }

    return number + '@c.us';
  }

  return { groupName: recipientTrimmed };
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/send', async (req, res) => {
  try {
    console.log('[HTTP] /api/send');

    if (!req.body?.recipients || !req.body?.message) {
      return res.status(400).json({ status: 'error', message: 'Campos obrigatórios: recipients, message' });
    }

    // valida conectividade antes de enfileirar
    await assertConnectedOrThrow();

    const { recipients, message } = req.body;
    const file = req.files ? req.files.file : null;

    const recipientList = String(recipients).split(',').map(s => s.trim()).filter(Boolean);

    // evita buscar chats repetidamente se tiver grupo
    let chatsCache = null;
    async function getChatsCached() {
      if (!chatsCache) chatsCache = await waState.client.getChats();
      return chatsCache;
    }

    // enfileira para não disparar concorrência no pup
    await enqueueSend(async () => {
      for (const recipient of recipientList) {
        const parsed = normalizeRecipientToChatId(recipient);
        if (!parsed) continue;

        if (typeof parsed === 'string') {
          console.log('[SEND] chatId:', parsed);
          await sendMessageWithTimeout(parsed, message, file);
        } else {
          const chats = await getChatsCached();
          const group = chats.find(chat => chat.isGroup && chat.name === parsed.groupName);
          if (!group) {
            console.log(`[WARN] Grupo "${parsed.groupName}" não encontrado.`);
          } else {
            console.log('[SEND] groupId:', group.id._serialized, 'name:', parsed.groupName);
            await sendMessageWithTimeout(group.id._serialized, message, file);
          }
        }

        await delay(1200); // menor que 5s, mas ainda dá respiro
      }
    });

    return res.status(200).json({ status: 'success', message: 'Mensagens enfileiradas/enviadas!' });
  } catch (err) {
    const msg = err?.message || String(err);
    console.log('[ERR] /api/send:', msg);

    // se falhou por “page closed / browser disconnected”, tenta restart sem wipe
    const low = msg.toLowerCase();
    if (low.includes('session closed') || low.includes('target closed') || low.includes('browser') || low.includes('protocol error')) {
      restartClient({ reason: 'send_failure_browser', wipeSession: false, doLogout: false }).catch(() => {});
    }

    return res.status(500).json({ status: 'error', message: 'Erro ao processar o envio.', error: msg });
  }
});

app.get('/api/sendMessage/:recipient/:message', async (req, res) => {
  try {
    console.log('[HTTP] /api/sendMessage');

    await assertConnectedOrThrow();

    const recipientParam = (req.params.recipient || '').trim();
    const message = decodeURIComponent(req.params.message || '');

    if (!recipientParam) {
      return res.status(400).json({ status: 'error', message: 'recipient obrigatório' });
    }

    let chatIdOrGroup = normalizeRecipientToChatId(recipientParam);

    if (!chatIdOrGroup) {
      return res.status(400).json({ status: 'error', message: 'recipient inválido' });
    }

    if (typeof chatIdOrGroup !== 'string') {
      const chats = await waState.client.getChats();
      const group = chats.find(chat => chat.isGroup && chat.name === chatIdOrGroup.groupName);
      if (!group) {
        return res.status(404).json({ status: 'error', message: `Grupo "${chatIdOrGroup.groupName}" não encontrado.` });
      }
      chatIdOrGroup = group.id._serialized;
    }

    await enqueueSend(async () => {
      await sendMessageWithTimeout(chatIdOrGroup, message, null);
    });

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

// ===== server start
app.listen(port, () => {
  console.log(`[HTTP] API rodando na porta ${port}`);
  console.log(`[WS] WS rodando na porta ${wsPort}`);
});

// ===== graceful shutdown
async function shutdown(sig) {
  console.log(`[SYS] shutdown (${sig})`);
  stopWatchdog();

  try {
    broadcast({ type: 'shutdown', sig });
  } catch {}

  try {
    await stopClient({ reason: `shutdown:${sig}`, doLogout: false, wipeSession: false });
  } catch {}

  try {
    wss.close(() => {});
  } catch {}

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
