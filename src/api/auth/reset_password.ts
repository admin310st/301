// src/api/auth/reset_password.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyTurnstileToken } from "../lib/turnstile";
import { logEvent } from "../lib/logger";
import { checkRateLimit } from "../lib/ratelimit";
import { createOmniToken } from "../lib/omni_tokens";
import { sendOmniMessage } from "../lib/message_sender";

const app = new Hono();

/**
 * POST /auth/reset_password
 *
 * Отправляет reset-link (email) или OTP (tg).
 * Генерирует CSRF токен для защиты от CSRF атак.
 * 
 * OAuth-only пользователи получают информативный ответ
 * о необходимости входа через провайдера.
 */

app.post("/", async (c) => {
  const env = c.env;

  // 1. IP + UA

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  const isDev = env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";

  // 2. ОПРЕДЕЛЕНИЕ ORIGIN (откуда пришёл запрос)

  const referer = c.req.header("Referer") || c.req.header("Origin");
  let origin = "https://301.st";

  if (referer) {
    try {
      const url = new URL(referer);
      origin = url.origin;
    } catch {
      console.warn("[reset_password] Invalid Referer/Origin:", referer);
    }
  }

  // 3. Парсим body ОДИН раз

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }

  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "invalid_body" });
  }

  // 4. ✅ TURNSTILE — ПЕРВАЯ ЛИНИЯ ЗАЩИТЫ

  const turnstileValid = await verifyTurnstileToken(env, body.turnstile_token, ip);
  if (!turnstileValid) {
    throw new HTTPException(403, { message: "turnstile_failed" });
  }

  // 5. БАЗОВАЯ ВАЛИДАЦИЯ

  const type = body.type;
  const value = String(body.value || "").trim().toLowerCase();

  if (!type || !value) {
    throw new HTTPException(400, { message: "invalid_identifier" });
  }

  if (!["email", "tg", "phone"].includes(type)) {
    throw new HTTPException(400, { message: "invalid_type" });
  }

  // 6. RATE LIMITING — ВТОРАЯ ЛИНИЯ ЗАЩИТЫ

  await checkRateLimit(env, `auth:reset:ip:${ip}`, { max: 20, windowSec: 60 });
  await checkRateLimit(env, `auth:reset:id:${type}:${value}`, { max: 5, windowSec: 600 });

  // 7. ПОИСК ПОЛЬЗОВАТЕЛЯ

  let user: {
    id: number;
    email: string;
    email_verified: number;
    password_hash: string | null;
    oauth_provider: string | null;
    tg_id?: string;
  } | null = null;

  if (type === "email") {
    user = await env.DB301
      .prepare(
        "SELECT id, email, email_verified, password_hash, oauth_provider FROM users WHERE email=?"
      )
      .bind(value)
      .first();
  }

  if (type === "tg") {
    user = await env.DB301
      .prepare(
        "SELECT id, email, email_verified, password_hash, oauth_provider, tg_id FROM users WHERE tg_id=?"
      )
      .bind(value)
      .first();
  }

  if (type === "phone") {
    throw new HTTPException(400, { message: "phone_not_supported" });
  }

  // Не раскрываем факт существования пользователя
  if (!user) {
    return c.json({ status: "ok" });
  }

  // 8. OAuth-only ПОЛЬЗОВАТЕЛЬ

  if (user.oauth_provider && !user.password_hash) {
    const providerNames: Record<string, string> = {
      google: "Google",
      github: "GitHub",
      apple: "Apple",
      telegram: "Telegram",
    };

    const providerDisplay = providerNames[user.oauth_provider] || user.oauth_provider;

    try {
      await logEvent(env, {
        event_type: "update",
        user_id: user.id,
        ip,
        ua,
        user_type: "client:none",
        details: {
          action: "reset_password_oauth_only",
          provider: user.oauth_provider,
          channel: type,
        },
      });
    } catch (e) {
      console.error("[AUDIT ERROR]", e);
    }

    return c.json({
      status: "oauth_only",
      provider: user.oauth_provider,
      message: `Вход в аккаунт осуществляется через ${providerDisplay}. Сброс пароля недоступен.`,
    });
  }

  // 9. ПРОВЕРКА email_verified (prod only)

  if (type === "email" && !isDev) {
    if (!user.email_verified) {
      throw new HTTPException(400, { message: "email_not_verified" });
    }
  }

  // 10. СОЗДАНИЕ OmniToken с CSRF

  const csrfToken = crypto.randomUUID();

  const omniResult = await createOmniToken(env, {
    type: "reset",
    identifier: value,
    channel: type,
    payload: { csrf_token: csrfToken },
    otp: type !== "email",
    ttl: 900,
  });

  const token = omniResult.token;
  const code = omniResult.code;

  // 11. ОТПРАВКА СООБЩЕНИЯ (с origin!)

  await sendOmniMessage(env, {
    channel: type as "email" | "telegram" | "sms",
    identifier: value,
    token,
    code,
    template: "reset",
    origin,
  });

  // 12. AUDIT LOG

  try {
    await logEvent(env, {
      event_type: "update",
      user_id: user.id,
      ip,
      ua,
      user_type: "client:none",
      details: {
        action: "reset_password_request",
        channel: type,
        origin,
      },
    });
  } catch (e) {
    console.error("[AUDIT ERROR]", e);
  }

  // 13. ОТВЕТ

  if (isDev) {
    return c.json({
      status: "ok",
      token,
      code,
      reset_link: `${origin}/auth/verify?type=reset&token=${token}`,
      csrf_token: csrfToken,
      origin,
    });
  }

  return c.json({ status: "ok" });
});

export default app;

