// src/api/lib/turnstile.ts

import type { Context } from "hono";
import type { Env } from "../types/worker";

/**
 * verifyTurnstile()
 * Универсальная проверка Cloudflare Turnstile.
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
    const isDev =
      env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";

    if (isDev) {
      return true;
    }

    // --- 2. Читаем токен ---
    let token =
      c.req.header("cf-turnstile-token") || null;

    if (!token) {
      // Может быть в теле
      const body = await c.req.json().catch(() => null);
      if (body && typeof body.turnstile_token === "string") {
        token = body.turnstile_token;
      }
    }

    if (!token) {
      return false;
    }

    // --- 3. Проверяем Turnstile API ---
    const ip = c.req.header("CF-Connecting-IP") || "";

    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: token,
          remoteip: ip
        })
      }
    );

    const data = await res.json().catch(() => null);

    if (!data || !data.success) {
      return false;
    }

    return true;
  } catch (err) {
    console.error("[Turnstile ERROR]", err);
    return false;
  }
}

