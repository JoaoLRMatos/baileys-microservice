# Microserviço WhatsApp

Serviço responsável por conexão e envio de mensagens via WhatsApp utilizando a biblioteca Baileys.

## Stack

- Node.js + Express (CommonJS)
- @whiskeysockets/baileys
- qrcode (geração de QR)
- pino (logs)

## Execução

```powershell
cd WhatsApp
npm install
node index.js
```

Servidor padrão: http://localhost:3030

## Variáveis de Ambiente (.env)

| Chave              | Descrição                                                |
| ------------------ | -------------------------------------------------------- |
| FRONT_ORIGIN       | Origem permitida (CORS) (default: http://localhost:5173) |
| WHATSAPP_ADMIN_KEY | Chave usada nos endpoints admin (header X-Admin-Key)     |
| NODE_ENV           | production / development (controla logs)                 |

## Conceitos

- ClientId: identificação lógica da sessão (ex: slug do tenant). Cada clientId gera diretório em `baileys_auth/<clientId>` contendo estado.
- QR Code: necessário inicialmente ou após expiração/desconexão para reautenticar o número.

## Rotas

Prefixo: /whatsapp

| Método | Rota               | Descrição                                            |
| ------ | ------------------ | ---------------------------------------------------- |
| GET    | /qr/:clientId      | Página HTML com QR ou status                         |
| GET    | /qr-json/:clientId | JSON (status + dataURL do QR)                        |
| GET    | /status/:clientId  | Status atual (connected / connecting / qr / unknown) |
| POST   | /send              | Envia mensagem (body: clientId, number, message)     |

### Admin (Header: X-Admin-Key=<WHATSAPP_ADMIN_KEY>)

| Método | Rota              | Descrição                                  |
| ------ | ----------------- | ------------------------------------------ |
| GET    | /admin/clients    | Lista sessões ativas                       |
| POST   | /admin/disconnect | Desconecta (body: clientId, forgetAuth?)   |
| POST   | /admin/cleanup    | Remove sessões inativas (body: maxIdleMs?) |

## Integração com Backend

Backend formata texto (templates + placeholders) e faz POST para /whatsapp/send com:

```json
{
  "clientId": "tenantSlug",
  "number": "+5511999999999",
  "message": "Olá {{name}}..."
}
```

## Persistência de Sessão

Baileys grava chaves de autenticação em `baileys_auth/<clientId>/`. Mantenha esta pasta em volume persistente em produção.

## Observabilidade (Sugestões)

- Adicionar endpoint /metrics (Prometheus)
- Log rotating (pino + pino-pretty em dev)

## Recuperação de Erros Comuns

| Erro                     | Causa                    | Ação                         |
| ------------------------ | ------------------------ | ---------------------------- |
| Invalid QR / Expired     | QR não escaneado a tempo | Recarregar / gerar novamente |
| 401 Admin key            | Header incorreto         | Enviar X-Admin-Key correto   |
| Falha ao enviar mensagem | Sessão desconectada      | Obter novo QR e reconectar   |

## Futuro

- Fila (RabbitMQ / Redis) para desacoplar disparos.
- Template message store local (fallback se backend offline).
- Notificações de status para frontend via WebSocket/SSE.

## Licença

Definir (MIT / Proprietária).
