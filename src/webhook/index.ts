/**
 * 301.st Webhook Receiver
 *
 * Приём данных от клиентских воркеров:
 * - POST /deploy — self-check после деплоя
 * - POST /health — VT threats, phishing zones
 * - POST /tds — TDS статистика (TODO)
 *
 * Auth: API key (SHA-256 hash) → DB301.worker_api_keys
 */

import { Hono } from "hono";
import { handleHealthWebhook } from "./health";
import { handleDeployWebhook } from "./deploy";
import { handleTdsWebhook } from "./tds";

// ============================================================
// TYPES
// ============================================================

export interface Env {
  DB301: D1Database;
  KV_SESSIONS: KVNamespace;
}

// ============================================================
// APP
// ============================================================

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/", (c) => {
  return c.json({ ok: true, service: "webhook-301" });
});

// Health webhook from Client Worker
app.post("/health", handleHealthWebhook);

// Deploy webhook from Client Worker (self-check)
app.post("/deploy", handleDeployWebhook);

// TDS stats webhook from Client Worker
app.post("/tds", handleTdsWebhook);

// 404 for unknown routes
app.all("*", (c) => {
  return c.json({ ok: false, error: "not_found" }, 404);
});

export default app;
