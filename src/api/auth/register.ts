// src/api/auth/register.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { startOmniFlow } from "../lib/start";
import { hashPassword, validatePasswordStrength } from "../lib/password";
import { verifyTurnstileToken } from "../lib/turnstile";
import { registerGuard } from "../lib/ratelimit";
import { detectLang } from "../lib/messaging/i18n";

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

  // ========================================
  // 1. IP + UA (нужны для следующих шагов)
  // ========================================

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  // ========================================
  // 2. ✅ TURNSTILE — ПЕРВАЯ ЛИНИЯ ЗАЩИТЫ!
  // ========================================

  const turnstileValid = await verifyTurnstileToken(env, turnstile_token, ip);
  if (!turnstileValid) {
    throw new HTTPException(403, { message: "turnstile_failed" });
  }

  // ========================================
  // 3. БАЗОВАЯ ВАЛИДАЦИЯ (дешевые проверки)
  // ========================================

  if (!email) {
    throw new HTTPException(400, { message: "email_required" });
  }

  if (!password) {
    throw new HTTPException(400, { message: "password_required" });
  }

  // ========================================
  // 4. ✅ RATE LIMITING — ВТОРАЯ ЛИНИЯ ЗАЩИТЫ
  // ========================================

  const rateBlock = await registerGuard(c, email);
  if (rateBlock) {
    return rateBlock; // 429 Too Many Requests
  }

  // ========================================
  // 5. ПРОВЕРКА СЛОЖНОСТИ ПАРОЛЯ
  // ========================================

  const validationError = validatePasswordStrength(password);
  if (validationError) {
    throw new HTTPException(400, validationError as any);
  }

  // ========================================
  // 6. ПРОВЕРКА СУЩЕСТВУЮЩЕГО ПОЛЬЗОВАТЕЛЯ
  // ========================================

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

  // ========================================
  // 7. ХЭШИРОВАНИЕ ПАРОЛЯ (дорогая операция)
  // ========================================

  const password_hash = await hashPassword(password);

  // ========================================
  // 8. ОПРЕДЕЛЕНИЕ ORIGIN
  // ========================================

  const referer = c.req.header("Referer") || c.req.header("Origin");
  let origin = "https://301.st"; // fallback

  if (referer) {
    try {
      const url = new URL(referer);
      origin = url.origin;
    } catch (err) {
      console.warn("[register] Invalid Referer/Origin header:", referer);
    }
  }

  // ========================================
  // 9. ОПРЕДЕЛЕНИЕ ЯЗЫКА
  // ========================================

  const acceptLang = c.req.header("Accept-Language");
  const lang = detectLang(acceptLang);

  // ========================================
  // 10. OMNIFLOW (БЕЗ ПОВТОРНОЙ ПРОВЕРКИ TURNSTILE!)
  // ========================================

  const result = await startOmniFlow(env, {
    identifier: email,
    mode: "register",
    payload: {
      password_hash,
      origin,
      lang,
    },
    ip,
    ua,
    turnstileToken: turnstile_token, // Передаём, но внутри будет dev bypass
    skipTurnstile: true, // ✅ Новый флаг - пропустить проверку внутри
  });

  // ========================================
  // 11. РЕЗУЛЬТАТ
  // ========================================

  return c.json({
    status: result.status,
    token: result.token,
    channel: result.channel,
    mode: result.mode,
  });
});

export default app;

