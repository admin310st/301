// src/api/auth/register.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { startOmniFlow } from "../lib/start";
import { hashPassword, validatePasswordStrength } from "../lib/password";

const app = new Hono();

/**
 * Classic Sign-Up → OmniAuth START
 * Email + Password регистрация
 */

app.post("/", async (c) => {
  const env = c.env;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password?.trim();
  const turnstile_token = body.turnstile_token;

  // Валидация email
  if (!email) {
    throw new HTTPException(400, { message: "email_required" });
  }

  // Валидация пароля
  if (!password) {
    throw new HTTPException(400, { message: "password_required" });
  }

  // Проверка сложности пароля
  const validationError = validatePasswordStrength(password);
  if (validationError) {
    throw new HTTPException(400, validationError as any);
  }

  // Ранняя проверка: существует ли user + owner аккаунт
  // Экономит отправку email если пользователь уже зарегистрирован
  const existingOwner = await env.DB301
    .prepare(`
      SELECT u.id FROM users u
      JOIN account_members am ON u.id = am.user_id
      WHERE u.email = ? AND am.role = 'owner'
    `)
    .bind(email)
    .first();

  if (existingOwner) {
    throw new HTTPException(409, { message: "user_already_registered" });
  }

  // Хэшируем пароль
  const password_hash = await hashPassword(password);

  // IP + UA
  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  // Определяем origin из Referer или Origin header
  const referer = c.req.header("Referer") || c.req.header("Origin");
  let origin = "https://301.st"; // fallback на production

  if (referer) {
    try {
      const url = new URL(referer);
      origin = url.origin; // https://dev.301.st или https://301.st
    } catch (err) {
      // Невалидный referer - используем fallback
      console.warn("[register] Invalid Referer/Origin header:", referer);
    }
  }

  //  origin в payload
  const result = await startOmniFlow(env, {
    identifier: email,
    mode: "register",
    payload: { 
      password_hash,
      origin // Сохраняем origin для использования в email ссылке
    },
    ip,
    ua,
    turnstileToken: turnstile_token,
  });

  // Результат
  return c.json({
    status: result.status,
    token: result.token,
    channel: result.channel,
    mode: result.mode,
  });
});

export default app;

