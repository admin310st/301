// src/api/lib/turnstile.ts

import type { Context } from "hono";
import type { Env } from "../types/worker";

/**
 * verifyTurnstile()
 * Проверка Cloudflare Turnstile из Hono Context.
 *
 * Используется в endpoint handlers где есть доступ к Context.
 *
 * Поведение:
 *  - В dev-режиме ВСЕГДА возвращает true.
 *  - В prod выполняет реальную проверку токена.
 *  - Токен может быть передан через:
 *      • заголовок "cf-turnstile-token"
 *      • поле JSON: { turnstile_token: "..." }
 */
export async function verifyTurnstile(
  c: Context,
  env: Env
): Promise<boolean> {
  try {
    // --- 1. dev-режим → пропуск ---
    const isDev = env.ENVIRONMENT === "dev";

    if (isDev) {
      console.log("[Turnstile] Dev mode - bypassing verification");
      return true;
    }

    // --- 2. Читаем токен из заголовка ---
    let token = c.req.header("cf-turnstile-token") || null;

    // --- 3. Если нет в заголовке - пробуем из body ---
    if (!token) {
      try {
        const body = await c.req.json();
        if (body && typeof body.turnstile_token === "string") {
          token = body.turnstile_token;
        }
      } catch {
        // Body не JSON или уже прочитан - игнорируем
      }
    }

    if (!token) {
      console.warn("[Turnstile] No token provided in request");
      return false;
    }

    // --- 4. Проверяем через API ---
    const ip = c.req.header("CF-Connecting-IP") || "";

    return await verifyTurnstileToken(env, token, ip);
  } catch (err) {
    console.error("[Turnstile ERROR]", err);
    return false;
  }
}

/**
 * verifyTurnstileToken()
 * Прямая проверка токена без Hono Context.
 * 
 * Используется в библиотечных функциях (start.ts, startOmniFlow)
 * где нет доступа к Context, но есть token и ip напрямую.
 *
 * @param env - Cloudflare Env
 * @param token - Turnstile response token
 * @param ip - IP адрес клиента
 * @returns true если проверка успешна, false если нет
 */
export async function verifyTurnstileToken(
  env: Env,
  token: string | null | undefined,
  ip: string
): Promise<boolean> {
  try {
    // --- 1. dev-режим → пропуск ---
    const isDev = env.ENVIRONMENT === "dev";

    if (isDev) {
      console.log("[Turnstile Token] Dev mode - bypassing verification");
      return true;
    }

    // --- 2. Проверка наличия токена ---
    if (!token) {
      console.warn("[Turnstile Token] No token provided");
      return false;
    }

    // --- 3. Проверка наличия секрета ---
    if (!env.TURNSTILE_SECRET) {
      console.error("[Turnstile Token] TURNSTILE_SECRET not configured");
      return false;
    }

    // --- 4. Вызов Cloudflare Turnstile API ---
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
          remoteip: ip || "",
        }),
      }
    );

    // --- 5. Парсим ответ ---
    if (!res.ok) {
      console.error("[Turnstile Token] API request failed:", res.status);
      return false;
    }

    const data: { 
      success?: boolean;
      "error-codes"?: string[];
      challenge_ts?: string;
      hostname?: string;
    } = await res.json().catch(() => ({}));

    // --- 6. Проверяем результат ---
    if (!data.success) {
      console.warn("[Turnstile Token] Verification failed:", {
        errors: data["error-codes"],
        hostname: data.hostname,
      });
      return false;
    }

    console.log("[Turnstile Token] Verification success:", {
      challenge_ts: data.challenge_ts,
      hostname: data.hostname,
    });

    return true;
  } catch (err) {
    console.error("[Turnstile Token ERROR]", err);
    return false;
  }
}

