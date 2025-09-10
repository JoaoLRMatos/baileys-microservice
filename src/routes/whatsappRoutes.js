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

// Middleware simples para proteger endpoints admin via header X-Admin-Key
const adminKey = process.env.WHATSAPP_ADMIN_KEY;
function requireAdmin(req, res, next) {
  if (!adminKey)
    return res.status(503).json({ error: "Admin key não configurada" });
  const provided = req.headers["x-admin-key"];
  if (provided && provided === adminKey) return next();
  return res.status(401).json({ error: "Não autorizado" });
}

// Retorna o último QR Code gerado para o clientId, ou status de conexão
function devLog(...args) {
  if (process.env.NODE_ENV !== "production") {
    console.log(...args);
  }
}

router.get("/qr/:clientId", async (req, res) => {
  const { clientId } = req.params;
  if (Math.random() < 0.05)
    devLog(`[whatsappRoutes] Requisição de QR para ${clientId}`);
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

// Endpoint JSON para consumo via SPA (retorna dataURL do QR se existir)
router.get("/qr-json/:clientId", async (req, res) => {
  const { clientId } = req.params;
  try {
    await getClient(clientId); // garante inicialização
    const raw = getQrCode(clientId);
    let qrImage = null;
    if (raw) {
      try {
        qrImage = await qrcode.toDataURL(raw);
      } catch (e) {
        devLog("Falha ao gerar dataURL do QR", e);
      }
    }
    const status = getConnectionStatus(clientId);
    return res.json({ clientId, status, hasQr: !!raw, qrImage });
  } catch (err) {
    console.error(`[whatsappRoutes] Erro /qr-json para ${clientId}:`, err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

router.get("/status/:clientId", async (req, res) => {
  const { clientId } = req.params;
  try {
    const status = getConnectionStatus(clientId);
    return res.json({ clientId, status, hasQr: !!getQrCode(clientId) });
  } catch (err) {
    return res.status(500).json({ error: "Erro ao obter status" });
  }
});

// Envia mensagem para um número via cliente específico
router.post("/send", async (req, res) => {
  const { clientId, number, message } = req.body;
  if (!clientId || !number || !message) {
    return res
      .status(400)
      .json({ error: "clientId, number e message são obrigatórios." });
  }
  try {
    const sock = await getClient(clientId);
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res
      .status(200)
      .json({ success: true, message: "Mensagem enviada com sucesso." });
  } catch (e) {
    res.status(500).json({ error: "Falha ao enviar a mensagem." });
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
