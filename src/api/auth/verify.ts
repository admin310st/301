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

