require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

// Configuração simples de CORS (permitindo origem do front-end)
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "http://localhost:5173";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", FRONT_ORIGIN);
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key"
  );
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Importa rotas WhatsApp
const whatsappRoutes = require("./src/routes/whatsappRoutes");
app.use("/whatsapp", whatsappRoutes);

// Health check (Render)
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

// Health check alternative (/health)
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3030;
if (!process.env.WHATSAPP_ADMIN_KEY) {
  console.warn(
    "[WARN] WHATSAPP_ADMIN_KEY não definido. Endpoints admin ficarão inacessíveis."
  );
}
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
