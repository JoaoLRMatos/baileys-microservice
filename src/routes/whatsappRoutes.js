const express = require("express");
const qrcode = require("qrcode");
const {
  getClient,
  getQrCode,
  getConnectionStatus,
  listClients,
  disconnectClient,
  cleanupInactive,
} = require("../services/whatsappManager");

const router = express.Router();

// Logger com níveis e mascaramento
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function currentLogLevel() {
  const env = (process.env.WHATSAPP_LOG_LEVEL || "").toLowerCase();
  if (env && LEVELS[env]) return env;
  return process.env.NODE_ENV === "production" ? "error" : "debug";
}
function log(level, ...args) {
  const cur = currentLogLevel();
  if (LEVELS[level] < LEVELS[cur]) return;
  const fn = level === "debug" ? console.log : console[level] || console.log;
  fn(...args);
}
function maskDigits(val) {
  if (!val) return val;
  return String(val).replace(/\d(?=(?:[^\d]*\d){4})/g, "*");
}
function maskJid(jid) {
  if (!jid) return jid;
  const [left, domain] = String(jid).split("@");
  return `${maskDigits(left)}${domain ? "@" + domain : ""}`;
}

// Middleware simples para proteger endpoints admin via header X-Admin-Key
const adminKey = process.env.WHATSAPP_ADMIN_KEY;
function requireAdmin(req, res, next) {
  if (!adminKey)
    return res.status(503).json({ error: "Admin key não configurada" });
  const provided = req.headers["x-admin-key"];
  if (provided && provided === adminKey) return next();
  return res.status(401).json({ error: "Não autorizado" });
}

// QR em HTML simples
router.get("/qr/:clientId", async (req, res) => {
  const { clientId } = req.params;
  try {
    await getClient(clientId);
    const qrCodeData = getQrCode(clientId);
    if (qrCodeData) {
      const qrCodeImage = await qrcode.toDataURL(qrCodeData);
      return res.send(`
        <html><body style='text-align:center;margin-top:50px;'>
        <h1>Escaneie o QR Code do cliente ${clientId}</h1>
        <img src='${qrCodeImage}' alt='QR Code' style='border:2px solid #333;padding:10px;border-radius:10px;'>
        </body></html>
      `);
    }
    const status = getConnectionStatus(clientId);
    return res.send(`Status: ${status}. Nenhum QR disponível.`);
  } catch (err) {
    console.error(`[whatsappRoutes] Erro /qr para ${clientId}:`, err);
    return res.status(500).send("Erro interno.");
  }
});

// QR JSON para SPA
router.get("/qr-json/:clientId", async (req, res) => {
  const { clientId } = req.params;
  try {
    await getClient(clientId);
    const raw = getQrCode(clientId);
    let qrImage = null;
    if (raw) {
      try {
        qrImage = await qrcode.toDataURL(raw);
      } catch (e) {
        log("warn", "Falha ao gerar dataURL do QR", e?.message || e);
      }
    }
    const status = getConnectionStatus(clientId);
    return res.json({ clientId, status, hasQr: !!raw, qrImage });
  } catch (err) {
    console.error(`[whatsappRoutes] Erro /qr-json para ${clientId}:`, err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// Status
router.get("/status/:clientId", async (req, res) => {
  const { clientId } = req.params;
  try {
    const status = getConnectionStatus(clientId);
    return res.json({ clientId, status, hasQr: !!getQrCode(clientId) });
  } catch (err) {
    return res.status(500).json({ error: "Erro ao obter status" });
  }
});

// Enviar mensagem
router.post("/send", async (req, res) => {
  const { clientId, number, message } = req.body;
  if (!clientId || !number || !message) {
    return res
      .status(400)
      .json({ error: "clientId, number e message são obrigatórios." });
  }
  try {
    const sock = await getClient(clientId);

    // Normalização BR (DDI 55) e variantes com/sem 9 após o DDD
    const onlyDigits = String(number).replace(/\D/g, "");
    let base = onlyDigits.startsWith("55") ? onlyDigits : `55${onlyDigits}`;
    const rest = base.slice(2);
    const variantNumbers = [];
    const pushUnique = (v) => {
      if (!variantNumbers.includes(v)) variantNumbers.push(v);
    };
    pushUnique(base);
    if (rest.length === 11 && rest[2] === "9") {
      pushUnique("55" + rest.slice(0, 2) + rest.slice(3));
    } else if (rest.length === 10) {
      pushUnique("55" + rest.slice(0, 2) + "9" + rest.slice(2));
    }
    const jids = variantNumbers.map((v) => `${v}@s.whatsapp.net`);

    // Resolver por onWhatsApp (variante por variante)
    let targetJid = null;
    const existsInfo = [];
    try {
      if (typeof sock.onWhatsApp === "function") {
        for (const v of variantNumbers) {
          try {
            const info = await sock.onWhatsApp(v);
            existsInfo.push({ variant: maskDigits(v), result: info });
            if (Array.isArray(info) && info[0]?.exists && info[0]?.jid) {
              targetJid = info[0].jid;
              break;
            }
          } catch (inner) {
            existsInfo.push({
              variant: maskDigits(v),
              error: inner?.message || String(inner),
            });
          }
        }
      }
    } catch (_) {}

    // Se confirmou, envia somente para o JID existente
    if (targetJid) {
      try {
        const resMsg = await sock.sendMessage(targetJid, { text: message });
        log("info", "[whatsapp/send] Enviado", {
          clientId,
          targetJid: maskJid(targetJid),
          id: resMsg?.key?.id || null,
        });
        return res
          .status(200)
          .json({
            success: true,
            message: "Mensagem enviada com sucesso.",
            target: targetJid,
          });
      } catch (err) {
        log("error", "[whatsapp/send] Falha ao enviar (JID verificado)", {
          clientId,
          targetJid: maskJid(targetJid),
          error: err?.message || String(err),
        });
        return res
          .status(502)
          .json({
            error: "Falha ao enviar a mensagem ao JID verificado.",
            target: targetJid,
            detail: err?.message || String(err),
          });
      }
    }

    // Sem confirmação do onWhatsApp
    const allowFallback =
      String(process.env.WHATSAPP_FALLBACK_SEND || "false").toLowerCase() ===
      "true";
    if (!allowFallback) {
      log(
        "info",
        "[whatsapp/send] Sem JID confirmado por onWhatsApp; não enviando",
        { clientId, variants: jids.map(maskJid), existsInfo }
      );
      return res
        .status(404)
        .json({
          error: "Nenhuma variante confirmada por onWhatsApp.",
          variants: jids,
          onWhatsApp: existsInfo,
        });
    }

    // Fallback opcional: tenta em ordem
    const attempts = [];
    for (const jid of jids) {
      try {
        const resMsg = await sock.sendMessage(jid, { text: message });
        attempts.push({
          jid: maskJid(jid),
          sent: true,
          id: resMsg?.key?.id || null,
        });
        log("warn", "[whatsapp/send] Enviado em fallback", {
          clientId,
          jid: maskJid(jid),
        });
        return res
          .status(200)
          .json({
            success: true,
            message: "Mensagem enviada (fallback).",
            target: jid,
            attempts,
            onWhatsApp: existsInfo,
          });
      } catch (err) {
        attempts.push({
          jid: maskJid(jid),
          sent: false,
          error: err?.message || String(err),
        });
      }
    }

    log("error", "[whatsapp/send] Todas as tentativas falharam (fallback)", {
      clientId,
      attempts,
    });
    return res
      .status(404)
      .json({
        error:
          "Nenhuma variante possui WhatsApp e todas as tentativas falharam.",
        attempts,
        onWhatsApp: existsInfo,
      });
  } catch (e) {
    log("error", "[whatsapp/send] Erro inesperado", e?.message || e);
    return res.status(500).json({ error: "Falha ao enviar a mensagem." });
  }
});

module.exports = router;

// Admin/gestão
router.get("/admin/clients", requireAdmin, (req, res) => {
  return res.json({ clients: listClients() });
});

router.post("/admin/disconnect", requireAdmin, async (req, res) => {
  const { clientId, forgetAuth } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "clientId obrigatório" });
  const ok = await disconnectClient(clientId, { forgetAuth: !!forgetAuth });
  return res.json({ success: ok });
});

router.post("/admin/cleanup", requireAdmin, (req, res) => {
  const { maxIdleMs } = req.body || {};
  const removed = cleanupInactive({ maxIdleMs: maxIdleMs || 1000 * 60 * 30 });
  return res.json({ removed, maxIdleMs: maxIdleMs || 1000 * 60 * 30 });
});
