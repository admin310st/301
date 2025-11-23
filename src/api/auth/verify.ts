// src/api/auth/verify.ts

/**
 * GET /auth/verify?token=xxx&code=xxx
 * POST /auth/verify
 *
 * Endpoint-обёртка для библиотечной функции verifyOmniFlow().
 *
 * GET используется при клике на email ссылки (token в query).
 * POST используется для API вызовов (token в body).
 *
 * Обрабатывает подтверждение:
 * - email регистрации
 * - login-кода
 * - reset-кода (возвращает CSRF token)
 * - приглашений (invite)
 * - действий (action)
 * - oauth verify
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyOmniFlow } from "../lib/verify";

const app = new Hono();

/**
 * GET /auth/verify?token=xxx&code=xxx
 * Используется при клике на email ссылки
 */
app.get("/", async (c) => {
  const token = c.req.query("token");
  const code = c.req.query("code") || undefined;

  if (!token) {
    throw new HTTPException(400, { message: "missing_token" });
  }

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  const result = await verifyOmniFlow(c.env, { token, code, ip, ua }, c);

  // Для reset flow возвращаем JSON (UI обработает)
  if (result.type === "reset") {
    return c.json(result);
  }

  // Для register/login — редирект на UI с токеном
  if (result.access_token) {
    const redirectUrl = `https://dev.301.st/auth/success?token=${result.access_token}`;
    return c.redirect(redirectUrl, 302);
  }

  return c.json(result);
});

/**
 * POST /auth/verify
 * Используется для API вызовов
 */
app.post("/", async (c) => {
  const env = c.env;

  // Читаем параметры из body
  const { token, code } = await c.req.json().catch(() => ({}));

  if (!token) {
    throw new HTTPException(400, { message: "missing_token" });
  }

  // Извлекаем IP и UA
  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  // Вызываем библиотечную функцию с передачей context для установки cookie
  const result = await verifyOmniFlow(env, { token, code, ip, ua }, c);

  return c.json(result);
});

export default app;

