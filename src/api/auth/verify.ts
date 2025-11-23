// src/api/auth/verify.ts

/**
 * POST /auth/verify
 * 
 * Endpoint-обёртка для библиотечной функции verifyOmniFlow().
 * Фронтенд вызывает этот метод для подтверждения:
 * - email регистрации
 * - login-кода
 * - reset-кода (возвращает CSRF token)
 * - приглашений (invite)
 * - действий (action)
 * - oauth verify
 * 
 * Без изменений - только передаёт управление в lib/verify.ts
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyOmniFlow } from "../lib/verify";

const app = new Hono();

/**
 * GET /auth/verify?token=xxx&code=xxx
 * Используется при клике на email ссылки
 */
// src/api/auth/verify.ts

app.get("/", async (c) => {
  const token = c.req.query("token");
  const code = c.req.query("code") || undefined;
  const originParam = c.req.query("origin") || undefined; // Читаем из query

  if (!token) {
    throw new HTTPException(400, { message: "missing_token" });
  }

  const ip = c.req.header("CF-Connecting-IP") || c.req.header("x-real-ip") || "0.0.0.0";
  const ua = c.req.header("User-Agent") || "unknown";

  const result = await verifyOmniFlow(c.env, { token, code, ip, ua }, c);

  if (result.type === "reset") {
    return c.json(result);
  }

  // Определяем origin в порядке приоритета:
  // 1. Query параметр (из email ссылки)
  // 2. Payload (из omni token)
  // 3. Referer header (если есть)
  // 4. Fallback
  
  let baseUrl = originParam; // Из query параметра

  if (!baseUrl) {
    // Пробуем из payload (session уже есть в result)
    const session = result._session; // Нужно добавить в result
    baseUrl = session?.payload?.origin;
  }

  if (!baseUrl) {
    // Пробуем Referer
    const referer = c.req.header("Referer") || c.req.header("Origin");
    if (referer) {
      try {
        const url = new URL(referer);
        baseUrl = url.origin;
      } catch {}
    }
  }

  if (!baseUrl) {
    // Fallback
    baseUrl = "https://301.st";
  }

  return c.redirect(`${baseUrl}/signin?verified=true`, 302);
});

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

