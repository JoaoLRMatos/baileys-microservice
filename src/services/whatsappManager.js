// Gerencia múltiplas conexões WhatsApp (um socket por cliente)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");

const clients = {};
const qrCodes = {}; // último QR por clientId
const connectionStatus = {}; // raw status
const friendlyStatus = {}; // connected / disconnected / connecting
const initPromises = {}; // evita corrida de inicialização
const lastActivity = {}; // timestamp

// Grupo alvo do webhook (configurável em runtime)
let webhookGroupName = (process.env.WEBHOOK_GROUP_NAME || "").trim().toLowerCase();
const resolvedGroupJids = {}; // cache: groupJid -> boolean

function devLog(...args) {
  if (process.env.NODE_ENV !== "production") console.log(...args);
}

function mapFriendly(raw) {
  switch (raw) {
    case "open":
      return "connected";
    case "close":
    case "disconnected":
    case "none":
      return "disconnected";
    default:
      return "connecting";
  }
}

async function getClient(clientId) {
  if (clients[clientId]) {
    lastActivity[clientId] = Date.now();
    return clients[clientId];
  }
  if (initPromises[clientId]) return initPromises[clientId];

  initPromises[clientId] = (async () => {
    const authFolder = path.join(__dirname, "../../baileys_auth", clientId);
    devLog(
      `[WhatsAppManager] Inicializando cliente ${clientId} com authFolder: ${authFolder}`
    );
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: "silent" })
        ),
      },
    });

    connectionStatus[clientId] = "initializing";
    friendlyStatus[clientId] = mapFriendly("initializing");

    sock.ev.on("creds.update", () => {
      devLog(`[WhatsAppManager] Credenciais atualizadas para ${clientId}`);
      saveCreds();
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (update.qr) {
        qrCodes[clientId] = update.qr;
        // Se temos um QR, a sessão NÃO está conectada; ajuste o status amigável
        friendlyStatus[clientId] = "disconnected";
        devLog(
          `[WhatsAppManager] Novo QR gerado para ${clientId} (status=disconnected)`
        );
      }
      if (connection) {
        connectionStatus[clientId] = connection;
        friendlyStatus[clientId] = mapFriendly(connection);
        devLog(
          `[WhatsAppManager] connection.update -> ${clientId} status=${connection} friendly=${friendlyStatus[clientId]}`
        );
      }
      if (lastDisconnect?.error) {
        const err = lastDisconnect.error;
        const sc = err?.output?.statusCode;
        devLog(
          `[WhatsAppManager] lastDisconnect erro para ${clientId}: ${
            err?.message || err
          } code=${sc || "?"}`
        );
        if (connection === "close") {
          delete clients[clientId];
          if (sc === 401) {
            // logout -> apaga credenciais para forçar novo pareamento
            try {
              const fs = require("fs");
              if (fs.existsSync(authFolder)) {
                fs.rmSync(authFolder, { recursive: true, force: true });
                devLog(
                  `[WhatsAppManager] Credenciais removidas (401) para ${clientId}`
                );
              }
            } catch (e) {
              devLog("Falha ao remover credenciais", e);
            }
          }
          if (sc === 401 || sc === 428) {
            qrCodes[clientId] = null;
            friendlyStatus[clientId] = "disconnected";
          } else if (sc !== 401) {
            // tentativa de reconectar em erros não definitivos
            setTimeout(() => {
              if (!clients[clientId]) {
                devLog(
                  `[WhatsAppManager] Re-attempt auto reconnect ${clientId}`
                );
                getClient(clientId).catch(() => {});
              }
            }, 5000);
          }
        }
      }
      if (connection === "open") {
        qrCodes[clientId] = null;
        devLog(`[WhatsAppManager] Cliente ${clientId} conectado!`);
      }
      lastActivity[clientId] = Date.now();
    });

    // ── Webhook: encaminha mensagens recebidas (opt-in via WEBHOOK_URL) ──
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      devLog(`[WhatsAppManager] Webhook ATIVO para ${clientId} -> ${webhookUrl}`);
      if (webhookGroupName) {
        devLog(`[WhatsAppManager] Filtrando apenas grupo com nome: "${webhookGroupName}"`);
      }

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        devLog(`[WhatsAppManager] messages.upsert event: type=${type}, count=${messages.length}`);
        if (type !== "notify") return;
        for (const msg of messages) {
          try {
            const remoteJid = msg.key.remoteJid || "";
            devLog(`[WhatsAppManager] Msg recebida:`, JSON.stringify({
              fromMe: msg.key.fromMe,
              remoteJid,
              hasConversation: !!msg.message?.conversation,
              hasExtended: !!msg.message?.extendedTextMessage?.text,
              messageKeys: Object.keys(msg.message || {}),
            }));

            // Ignora broadcasts e newsletters
            if (remoteJid === "status@broadcast") continue;
            if (remoteJid.endsWith("@newsletter")) continue;

            // ── Modo grupo específico (webhookGroupName configurado) ──
            if (webhookGroupName) {
              if (!remoteJid.endsWith("@g.us")) {
                devLog(`[WhatsAppManager] Ignorado (não é grupo): ${remoteJid}`);
                continue;
              }
              if (!(remoteJid in resolvedGroupJids)) {
                try {
                  const meta = await sock.groupMetadata(remoteJid);
                  const match = meta.subject.toLowerCase().includes(webhookGroupName);
                  resolvedGroupJids[remoteJid] = match;
                  devLog(`[WhatsAppManager] Grupo "${meta.subject}" (${remoteJid}) -> ${match ? "MATCH" : "ignorado"}`);
                } catch (e) {
                  devLog(`[WhatsAppManager] Falha metadata grupo ${remoteJid}:`, e?.message);
                  continue;
                }
              }
              if (!resolvedGroupJids[remoteJid]) continue;
            } else {
              // ── Modo DM/self-chat (sem webhookGroupName) ──
              if (remoteJid.endsWith("@g.us")) continue;
              if (msg.key.fromMe && !remoteJid.endsWith("@lid")) {
                const ownNumber = (sock.user?.id || "").split(":")[0].split("@")[0];
                const remoteNumber = remoteJid.split("@")[0];
                if (ownNumber !== remoteNumber) continue;
              }
            }

            // Extrai texto (conversa normal ou citação)
            const text =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              null;
            if (!text) continue;

            // Extrai identificador do remetente
            const from = remoteJid.replace(/@.*$/, "");
            const payload = {
              clientId,
              from,
              text,
              messageId: msg.key.id || undefined,
              timestamp: msg.messageTimestamp
                ? Number(msg.messageTimestamp)
                : undefined,
            };

            devLog(
              `[WhatsAppManager] Webhook -> ${webhookUrl}`,
              JSON.stringify({ clientId, from: from.slice(-4).padStart(from.length, "*") })
            );

            const secret = process.env.WEBHOOK_SECRET || "";
            await fetch(webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(secret ? { "x-webhook-secret": secret } : {}),
              },
              body: JSON.stringify(payload),
            });
          } catch (err) {
            devLog(
              `[WhatsAppManager] Webhook falhou para ${clientId}:`,
              err?.message || err
            );
          }
        }
      });
    } else {
      devLog(`[WhatsAppManager] Webhook DESATIVADO para ${clientId} (WEBHOOK_URL não definida)`);
    }

    clients[clientId] = sock;
    return sock;
  })();

  try {
    return await initPromises[clientId];
  } finally {
    delete initPromises[clientId];
  }
}

function getQrCode(clientId) {
  return qrCodes[clientId] || null;
}

function getConnectionStatus(clientId) {
  // Se há QR pendente, consideramos desconectado para forçar novo pareamento
  if (qrCodes[clientId]) return "disconnected";
  if (friendlyStatus[clientId]) return friendlyStatus[clientId];
  if (connectionStatus[clientId])
    return mapFriendly(connectionStatus[clientId]);
  return clients[clientId] ? "connecting" : "disconnected";
}

function listClients() {
  return Object.keys({ ...qrCodes, ...clients }).map((id) => ({
    clientId: id,
    status: getConnectionStatus(id),
    statusRaw: connectionStatus[id] || null,
    hasQr: !!qrCodes[id],
    lastActivity: lastActivity[id] || null,
  }));
}

async function disconnectClient(clientId, { forgetAuth = false } = {}) {
  const sock = clients[clientId];
  if (!sock) return false;
  try {
    await sock.logout?.();
  } catch (_) {}
  try {
    sock.end?.();
  } catch (_) {}
  delete clients[clientId];
  connectionStatus[clientId] = "close";
  friendlyStatus[clientId] = "disconnected";
  qrCodes[clientId] = null;
  if (forgetAuth) {
    const fs = require("fs");
    const authFolder = path.join(__dirname, "../../baileys_auth", clientId);
    if (fs.existsSync(authFolder)) {
      fs.rmSync(authFolder, { recursive: true, force: true });
    }
  }
  return true;
}

function cleanupInactive({ maxIdleMs = 1000 * 60 * 30 } = {}) {
  const now = Date.now();
  const removed = [];
  for (const id of Object.keys(clients)) {
    const idle = now - (lastActivity[id] || 0);
    if (idle > maxIdleMs) {
      disconnectClient(id, { forgetAuth: false });
      removed.push(id);
    }
  }
  return removed;
}

function getWebhookGroupName() {
  return webhookGroupName;
}

function setWebhookGroupName(name) {
  webhookGroupName = (name || "").trim().toLowerCase();
  // Limpa cache de grupos resolvidos para reavaliar
  for (const key of Object.keys(resolvedGroupJids)) {
    delete resolvedGroupJids[key];
  }
  devLog(`[WhatsAppManager] webhookGroupName atualizado para: "${webhookGroupName}"`);
  return webhookGroupName;
}

module.exports = {
  getClient: getClient,
  getQrCode: getQrCode,
  getConnectionStatus: getConnectionStatus,
  listClients: listClients,
  disconnectClient: disconnectClient,
  cleanupInactive: cleanupInactive,
  getWebhookGroupName: getWebhookGroupName,
  setWebhookGroupName: setWebhookGroupName,
};
