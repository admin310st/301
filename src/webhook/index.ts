/**
 * 301.st Webhook Receiver
 *
 * Приём внешних событий:
 * - POST /health — данные от Client Worker (VT threats, phishing)
 * - POST /hosttracker — уведомления от HostTracker (future)
 */

import { Hono } from "hono";
import { handleHealthWebhook } from "./health";

// ============================================================
// TYPES
// ============================================================

export interface Env {
  DB301: D1Database;
  KV_SESSIONS: KVNamespace;
  MASTER_SECRET: string;
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

// 404 for unknown routes
app.all("*", (c) => {
  return c.json({ ok: false, error: "not_found" }, 404);
});

export default app;
