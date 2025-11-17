// src/api/auth/verify.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyOmniFlow } from "../lib/verify";

const app = new Hono();

/**
 * POST /auth/verify
 * Фронтенд вызывает этот метод для:
 * - подтверждения email
 * - подтверждения login-кода
 * - подтверждения reset-кода
 * - приглашений (invite)
 * - подтверждения действий (action)
 * - oauth verify
 */
app.post("/", async (c) => {
  const env = c.env;

  const { token, code } = await c.req.json().catch(() => ({}));

  if (!token) {
    throw new HTTPException(400, { message: "missing_token" });
  }

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  const result = await verifyOmniFlow(env, { token, code, ip, ua });

  return c.json(result);
});

export default app;

