// src/api/lib/start.ts

import { HTTPException } from "hono/http-exception";
import type { Env } from "../types/worker";
import { createOmniToken } from "../lib/omni_tokens";
import { sendOmniMessage } from "../lib/message_sender";
import { checkRateLimit } from "../lib/ratelimit";
import { verifyTurnstile } from "../lib/turnstile";

/**
 * Универсальный запуск OmniAuth - БИБЛИОТЕКА 
 * Работает для: register, login, reset, invite, action, oauth.
 * - Rate Limit
 * - Turnstile
 * - Выбор канала (email/sms/telegram)
 */
export async function startOmniFlow(
  env: Env,
  params: {
    identifier: string;
    mode?: string;
    payload?: any;
    ip: string;
    ua?: string;
    turnstileToken?: string;
  }
) {
  const {
    identifier,
    mode = "register",
    payload = null,
    ip,
    ua = "unknown",
    turnstileToken,
  } = params;

  if (!identifier) {
    throw new HTTPException(400, { message: "identifier_required" });
  }

  // RATE LIMIT
  await checkRateLimit(env, `auth:start:ip:${ip}`, 20, 60);
  await checkRateLimit(env, `auth:start:id:${identifier}`, 5, 60);

  // TURNSTILE
  const turnstileOK = await verifyTurnstile(env, turnstileToken, ip);
  if (!turnstileOK) {
    throw new HTTPException(403, { message: "turnstile_failed" });
  }

  // ---- Выбор канала доставки: email | sms | telegram ----
  let channel: "email" | "sms" | "telegram";

  if (identifier.includes("@")) channel = "email";
  else if (identifier.startsWith("+")) channel = "sms";
  else channel = "telegram";

  // email → ссылка, sms/tg → OTP
  const otp = channel !== "email";

  // ---- Создаём OmniAuth токен (KV_SESSIONS) ----
  const { token, code } = await createOmniToken(env, {
    type: mode as any,
    identifier,
    channel,
    payload,
    otp,
  });

  // ---- Приводим режим → шаблон ----
  // register → verify (email-верификация)
  const template =
    mode === "register"
      ? "verify"
      : (mode as "login" | "reset" | "invite" | "action" | "verify");

  // ---- Отправка email / SMS / Telegram ----
  await sendOmniMessage(env, {
    channel,
    identifier,
    token,
    template,
    code, // теперь OTP реально передаётся для sms/tg
  });

  // ---- Ответ UI (NOT JSON!) ----
  return {
    status: "pending",
    mode,
    channel,
    token,
  };
}

