// /opt/RR-WhatsApp-API/index.js

'use strict';

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

// ✅ Confie em proxy APENAS quando fizer sentido (Docker/Coolify/reverse proxy).
// Isso evita spoof de X-Forwarded-For quando alguém acessa direto a porta 3001.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// ✅ ALLOWED_IPS vindo do env (recomendado)
// Exemplo:
// ALLOWED_IPS=127.0.0.1,::1,10.10.10.0/24,10.10.20.0/24,10.0.2.0/24,10.0.0.0/8,172.16.0.0/12
const allowedIPs = (process.env.ALLOWED_IPS || '127.0.0.1,::1')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log('[BOOT] ALLOWED_IPS aplicado:', allowedIPs.join(', '));

function normalizeIP(ip) {
  if (!ip) return '';
  const s = ip.toString().trim();
  // remove prefixo IPv6-mapped IPv4
  return s.replace(/^::ffff:/, '');
}

function getClientIPExpress(req) {
  // req.ip já respeita trust proxy corretamente
  return normalizeIP(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '');
}

// ✅ Middleware de ACL por IP (HTTP)
app.use((req, res, next) => {
  const cleanedIP = getClientIPExpress(req);

  if (ipRangeCheck(cleanedIP, allowedIPs)) return next();

  const xff = (req.headers['x-forwarded-for'] || '').toString();
  console.log('[BLOCK]', cleanedIP, 'xff=', xff, 'path=', req.path, 'ua=', req.headers['user-agent']);
  return res.status(403).send('Acesso negado.');
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload());

// ===== WhatsApp state =====
let qrCodeData = null;
let authenticated = false;

// ✅ WebSocket server (QR e status)
const wsPort = Number(process.env.WS_PORT || 8080);
const wss = new WebSocket.Server({ port: wsPort });

function getClientIPWS(req) {
  // Para WS, não tem req.ip do Express. Pegamos XFF (se vier via proxy) ou remoteAddress.
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const first = xff.split(',')[0].trim(); // se existir, pega o primeiro
  const ip = first || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return normalizeIP(ip);
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

  if (qrCodeData) {
    ws.send(JSON.stringify({ type: 'qr', data: qrCodeData }));
  } else {
    ws.send(JSON.stringify({ type: 'status', authenticated }));
  }
});

let client;

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: null,
      timeout: 0,
    },
  });
  registerClientEvents();
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((wsClient) => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(payload);
    }
  });
}

function registerClientEvents() {
  client.removeAllListeners();

  client.on('qr', (qr) => {
    qrCodeData = qr;
    console.log('QR Code gerado.');
    broadcast({ type: 'qr', data: qr });
  });

  client.on('authenticated', () => {
    console.log('Cliente autenticado com sucesso.');
    broadcast({ type: 'authenticated' });
  });

  client.on('ready', async () => {
    console.log('WhatsApp está pronto!');
    qrCodeData = null;

    // dá um respiro pro estado estabilizar
    await new Promise(resolve => setTimeout(resolve, 3000));

    let info = null;
    try {
      info = await client.getState();
    } catch (e) {
      console.log('Não foi possível obter getState imediatamente:', e?.message || e);
    }

    console.log('Estado do cliente:', info);
    authenticated = true;
    broadcast({ type: 'ready', state: info, authenticated: true });
  });

  client.on('disconnected', (reason) => {
    console.log('Motivo da desconexão:', reason);
    authenticated = false;
    qrCodeData = null;
    broadcast({ type: 'disconnected', reason });
  });

  client.on('auth_failure', (msg) => {
    console.error('Falha na autenticação:', msg);
    authenticated = false;
    broadcast({ type: 'auth_failure', msg });
  });

  client.on('change_state', (state) => {
    console.log('Estado de conexão mudou para:', state);
    broadcast({ type: 'change_state', state });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`Carregando (${percent}%): ${message}`);
    broadcast({ type: 'loading', percent, message });
  });

  // ✅ Comando de teste: mande "!ping" pro número do WhatsApp
  client.on('message', async (msg) => {
    try {
      console.log(`Mensagem recebida de ${msg.from}: ${msg.body}`);
      if (msg.type === 'chat' && (msg.body || '').toLowerCase().trim() === '!ping') {
        await client.sendMessage(msg.from, 'PONG');
        console.log(`Resposta automática enviada para ${msg.from}`);
      }
    } catch (e) {
      console.error('Erro no handler de message:', e?.message || e);
    }
  });

  // ✅ Recusa chamadas
  client.on('call', async (call) => {
    try {
      console.log(`Recebida uma chamada de ${call.from} (Tipo: ${call.isVideo ? 'Vídeo' : 'Voz'})`);
      await call.reject();
      console.log('Chamada rejeitada.');

      const message = '*Mensagem automática!*\n\nEste número não aceita chamadas de voz ou de vídeo.';
      await client.sendMessage(call.from, message);
      console.log(`Mensagem automática enviada para ${call.from}`);
    } catch (e) {
      console.error('Erro no handler de call:', e?.message || e);
    }
  });
}

// init
createClient();
client.initialize();

app.get('/config.js', (req, res) => {
  const wsPort = process.env.WS_PORT || 8080;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__WS_PORT__ = ${JSON.stringify(wsPort)};`);
});

// ===== Rotas =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/qr', async (req, res) => {
  try {
    if (authenticated && client) {
      return res.json({ status: 'connected', message: 'Cliente já está conectado' });
    }

    if (!qrCodeData) {
      return res.json({ status: 'waiting', message: 'QR Code ainda não foi gerado, por favor tente novamente em alguns segundos' });
    }

    const qrCodeImage = await QRCode.toDataURL(qrCodeData);
    const base64Data = qrCodeImage.replace(/^data:image\/png;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': imgBuffer.length
    });
    return res.end(imgBuffer);
  } catch (err) {
    console.error('Erro ao gerar QR Code:', err);
    return res.status(500).json({ status: 'error', message: 'Erro ao gerar QR Code' });
  }
});

app.get('/api/disconnect', async (req, res) => {
  try {
    console.log('Iniciando logout...');
    if (client) {
      await client.logout().catch(() => {});
      console.log('Logout concluído.');

      console.log('Destruindo o cliente...');
      await client.destroy().catch(() => {});
      console.log('Cliente destruído.');
    }

    client = null;
    qrCodeData = null;
    authenticated = false;

    const sessionPath = path.join(__dirname, 'session');
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('Dados de autenticação removidos.');
    }

    console.log('Criando novo cliente...');
    createClient();
    console.log('Inicializando novo cliente...');
    client.initialize();

    broadcast({ type: 'disconnected', reason: 'manual_disconnect' });
    return res.send('Desconectado com sucesso!');
  } catch (err) {
    console.error('Erro ao desconectar:', err);
    return res.status(500).json({ status: 'error', message: 'Erro ao desconectar.', error: err?.message || String(err) });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    if (authenticated && client) {
      let state = 'UNKNOWN';
      try {
        state = await client.getState();
      } catch (e) {}

      if (state === 'CONNECTED') {
        return res.json({ status: 'connected', number: client?.info?.wid?.user || null, state });
      }
      return res.json({ status: 'connecting', state });
    }

    return res.json({ status: 'disconnected' });
  } catch (err) {
    console.error('Erro em /api/status:', err);
    return res.status(500).json({ status: 'error', message: 'Erro ao consultar status', error: err?.message || String(err) });
  }
});

const sendMessageWithTimeout = async (chatId, message, file, timeout = 20000) => {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout ao enviar mensagem.'));
    }, timeout);

    try {
      const imageRegex = /\[img\s*=\s*(https?:\/\/[^\s]+)\]/i;
      const pdfRegex = /\[pdf\s*=\s*(https?:\/\/[^\s]+)\]/i;

      let match = message.match(imageRegex);
      if (match) {
        const imageUrl = match[1];
        const media = await MessageMedia.fromUrl(imageUrl);
        await client.sendMessage(chatId, media, { caption: message.replace(imageRegex, '') });
        console.log(`Imagem com a mensagem enviada para ${chatId}`);
      } else {
        match = message.match(pdfRegex);
        if (match) {
          const pdfUrl = match[1];
          const media = await MessageMedia.fromUrl(pdfUrl);
          await client.sendMessage(chatId, media, { caption: message.replace(pdfRegex, '') });
          console.log(`PDF com a mensagem enviado para ${chatId}`);
        } else {
          if (file) {
            const filePath = path.join('/tmp', file.name);
            await file.mv(filePath);
            const media = MessageMedia.fromFilePath(filePath);
            await client.sendMessage(chatId, media, { caption: message });
            console.log(`Mensagem com anexo enviada para ${chatId}`);
            fs.unlink(filePath, (err) => {
              if (err) console.error(`Erro ao remover o arquivo: ${filePath}`, err);
            });
          } else {
            await client.sendMessage(chatId, message);
            console.log(`Mensagem enviada para ${chatId}`);
          }
        }
      }

      clearTimeout(timeoutId);
      resolve();
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`Erro ao enviar mensagem para ${chatId}:`, err);
      reject(err);
    }
  });
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/send', async (req, res) => {
  try {
    console.log('Recebendo requisição para enviar mensagem.');

    if (!client || !client.info || !authenticated) {
      console.log('Cliente não está pronto.');
      return res.status(500).json({ status: 'error', message: 'Cliente não está pronto. Por favor, tente novamente mais tarde.' });
    }

    const clientState = await client.getState();
    console.log('Estado atual do cliente:', clientState);

    if (clientState !== 'CONNECTED') {
      console.log('Cliente não está conectado.');
      return res.status(500).json({ status: 'error', message: 'Cliente não está conectado ao WhatsApp. Por favor, aguarde.' });
    }

    const { recipients, message } = req.body;

    if (!recipients || !message) {
      return res.status(400).json({ status: 'error', message: 'Campos obrigatórios: recipients, message' });
    }

    const recipientList = recipients.split(',');
    const file = req.files ? req.files.file : null;

    console.log('Destinatários:', recipientList);
    console.log('Mensagem:', message);

    const chats = await client.getChats();

    for (const recipient of recipientList) {
      const recipientTrimmed = recipient.trim();

      if (/^\+?\d+$/.test(recipientTrimmed)) {
        let number = recipientTrimmed.replace(/\D/g, '');

        // remove nono dígito (BR) se for 55 + DDD + 9xxxxxxxx (13 dígitos)
        if (number.startsWith('55') && number.length === 13) {
          number = number.slice(0, 4) + number.slice(5);
        }

        const chatId = number + '@c.us';
        await sendMessageWithTimeout(chatId, message, file);
      } else {
        const group = chats.find(chat => chat.isGroup && chat.name === recipientTrimmed);
        if (group) {
          await sendMessageWithTimeout(group.id._serialized, message, file);
        } else {
          console.error(`Grupo ${recipientTrimmed} não encontrado.`);
        }
      }

      await delay(5000);
    }

    return res.status(200).json({ status: 'success', message: 'Mensagem enviada!' });
  } catch (err) {
    console.error('Erro ao processar o envio:', err);
    return res.status(500).json({ status: 'error', message: 'Erro ao processar o envio.', error: err?.message || String(err) });
  }
});

app.get('/api/sendMessage/:recipient/:message', async (req, res) => {
  try {
    console.log('Recebendo requisição para enviar mensagem via GET.');

    if (!client || !client.info || !authenticated) {
      console.log('Cliente não está pronto.');
      return res.status(500).json({ status: 'error', message: 'Cliente não está pronto. Por favor, tente novamente mais tarde.' });
    }

    const clientState = await client.getState();
    console.log('Estado atual do cliente:', clientState);

    if (clientState !== 'CONNECTED') {
      console.log('Cliente não está conectado.');
      return res.status(500).json({ status: 'error', message: 'Cliente não está conectado ao WhatsApp. Por favor, aguarde.' });
    }

    const recipientParam = req.params.recipient;
    const message = decodeURIComponent(req.params.message);

    console.log('Destinatário:', recipientParam);
    console.log('Mensagem:', message);

    function processPhoneNumber(number) {
      return number.replace(/[\s()+-]/g, '');
    }

    let chatId;

    if (/^\d+$/.test(recipientParam)) {
      let number = processPhoneNumber(recipientParam);

      if (number.startsWith('55') && number.length === 13) {
        number = number.slice(0, 4) + number.slice(5);
      }

      chatId = number + '@c.us';
    } else {
      const chats = await client.getChats();
      const group = chats.find(chat => chat.isGroup && chat.name === recipientParam);
      if (group) {
        chatId = group.id._serialized;
      } else {
        console.error(`Grupo "${recipientParam}" não encontrado.`);
        return res.status(404).json({ status: 'error', message: `Grupo "${recipientParam}" não encontrado.` });
      }
    }

    await client.sendMessage(chatId, message);
    console.log(`Mensagem enviada para ${chatId}`);

    return res.status(200).json({ status: 'success', message: 'Mensagem enviada!' });
  } catch (err) {
    console.error('Erro ao enviar mensagem via GET:', err);
    return res.status(500).json({ status: 'error', message: 'Erro ao enviar mensagem.', error: err?.message || String(err) });
  }
});

app.listen(port, () => {
  console.log(`API rodando na porta ${port}`);
  console.log(`WS rodando na porta ${wsPort}`);
});
