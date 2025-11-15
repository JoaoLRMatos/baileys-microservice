require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

// Configuração simples de CORS (permitindo origem do front-end)
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || ""; //http://localhost:5173
const FRONT_ORIGINS = (process.env.FRONT_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [FRONT_ORIGIN, ...FRONT_ORIGINS]
  .map((o) => o.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.length === 0;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (allowAllOrigins || allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", allowAllOrigins ? "*" : origin);
    }
  } else if (allowAllOrigins) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (allowedOrigins.length === 1) {
    res.header("Access-Control-Allow-Origin", allowedOrigins[0]);
  }
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

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || "0.0.0.0";
if (!process.env.WHATSAPP_ADMIN_KEY) {
  console.warn(
    "[WARN] WHATSAPP_ADMIN_KEY não definido. Endpoints admin ficarão inacessíveis."
  );
}
app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando na porta ${PORT} (host ${HOST})`);
});
