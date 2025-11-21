// src/api/auth/reset_password.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyTurnstile } from "../lib/turnstile";
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

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  const isDev =
    env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";

  // 1. Turnstile (prod only)
  if (!(await verifyTurnstile(c, env))) {
    throw new HTTPException(400, { message: "turnstile_failed" });
  }

  // 2. Rate-limit (IP)
  await checkRateLimit(env, `auth:reset:ip:${ip}`, { max: 20, windowSec: 60 });

  // 3. Body
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "invalid_body" });
  }

  const type = body.type;
  const value = String(body.value || "").trim().toLowerCase();

  if (!type || !value) {
    throw new HTTPException(400, { message: "invalid_identifier" });
  }

  if (!["email", "tg", "phone"].includes(type)) {
    throw new HTTPException(400, { message: "invalid_type" });
  }

  // 4. Rate-limit (identifier)
  await checkRateLimit(env, `auth:reset:id:${type}:${value}`, { max: 5, windowSec: 600 });

  // 5. Find user
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

  // 6. OAuth-only пользователь: пароля нет, вход через провайдера
  if (user.oauth_provider && !user.password_hash) {
    // Форматируем название провайдера для UI
    const providerNames: Record<string, string> = {
      google: "Google",
      github: "GitHub",
      apple: "Apple",
      telegram: "Telegram",
    };

    const providerDisplay = providerNames[user.oauth_provider] || user.oauth_provider;

    // Логируем попытку reset для OAuth-only
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

    // Возвращаем информативный ответ
    return c.json({
      status: "oauth_only",
      provider: user.oauth_provider,
      message: `Вход в аккаунт осуществляется через ${providerDisplay}. Сброс пароля недоступен.`,
    });
  }

  // 7. Проверка email_verified (только в prod)
  if (type === "email" && !isDev) {
    if (!user.email_verified) {
      throw new HTTPException(400, { message: "email_not_verified" });
    }
  }

  // 8. Создаём OmniToken для reset с CSRF в payload
  const csrfToken = crypto.randomUUID();

  const omniResult = await createOmniToken(env, {
    type: "reset",
    identifier: value,
    channel: type,
    payload: { csrf_token: csrfToken },
    otp: type !== "email",
    ttl: 900, // 15 минут
  });

  const token = omniResult.token;
  const code = omniResult.code; // OTP для tg/sms

  // 9. Отправка email/TG/SMS через универсальный sender
  await sendOmniMessage(env, {
    channel: type as "email" | "telegram" | "sms",
    identifier: value,
    token,
    code,
    template: "reset",
  });

  // 10. Audit
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
      },
    });
  } catch (e) {
    console.error("[AUDIT ERROR]", e);
  }

  // 11. DEV response (показываем токены для тестирования)
  if (isDev) {
    const resetLink =
      type === "email"
        ? `${env.OAUTH_REDIRECT_BASE}/auth/verify?type=reset&token=${token}`
        : null;

    return c.json({
      status: "ok",
      token,
      code, // OTP для tg/sms
      reset_link: resetLink,
      csrf_token: csrfToken,
    });
  }

  // 12. PROD response (не раскрываем детали)
  return c.json({ status: "ok" });
});

export default app;

