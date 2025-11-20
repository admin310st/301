// src/api/auth/confirm_password.ts

/**
 * FINISH PASSWORD RESET FLOW:
 * 1. /auth/reset_password  → старт (отправка email/OTP)
 * 2. /auth/verify?type=reset → подтверждение + генерация CSRF token
 * 3. /auth/confirm_password → установка нового пароля + проверка CSRF + проверка сложности
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../lib/password";
import { logEvent } from "../lib/logger";

const app = new Hono();

app.post("/", async (c) => {
  const env = c.env;

  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  const isDev =
    env.ENV_MODE === "dev" || env.WORKERS_ENV === "dev";

  // 1) Извлекаем reset_session из cookie
  const cookieHeader = c.req.header("Cookie") || "";
  const resetMatch = cookieHeader.match(/reset_session=([^;]+)/);

  if (!resetMatch) {
    throw new HTTPException(401, { message: "reset_session_required" });
  }

  const resetSessionId = resetMatch[1];
  const resetKey = `reset:${resetSessionId}`;

  // 2) Читаем reset session из KV
  const raw = await env.KV_SESSIONS.get(resetKey);
  if (!raw) {
    throw new HTTPException(401, { message: "reset_session_expired" });
  }

  let resetData: {
    user_id: number;
    channel?: string;
    identifier?: string;
    csrf_token?: string;
  };

  try {
    resetData = JSON.parse(raw);
  } catch {
    throw new HTTPException(401, { message: "reset_session_invalid" });
  }

  const userId = Number(resetData.user_id);

  if (!userId || Number.isNaN(userId)) {
    throw new HTTPException(401, { message: "reset_session_invalid" });
  }

  // 3) Проверка CSRF token
  const body = await c.req.json().catch(() => ({} as any));
  const clientCsrfToken = body.csrf_token?.trim();

  // Проверяем CSRF (обязательно в production)
  if (!isDev) {
    if (!clientCsrfToken) {
      throw new HTTPException(403, { message: "csrf_token_required" });
    }

    if (!resetData.csrf_token) {
      throw new HTTPException(401, { message: "reset_session_invalid" });
    }

    if (clientCsrfToken !== resetData.csrf_token) {
      // Логируем попытку CSRF атаки
      try {
        await logEvent(env, {
          event_type: "revoke",
          user_id: userId,
          ip,
          ua,
          user_type: "client:none",
          details: {
            action: "csrf_attack_detected",
            endpoint: "/auth/confirm_password",
          },
        });
      } catch (err) {
        console.error("[AUDIT_LOG ERROR csrf]", err);
      }

      throw new HTTPException(403, { message: "csrf_token_invalid" });
    }
  } else {
    // В dev режиме CSRF опционален, но предупреждаем
    if (!clientCsrfToken) {
      console.warn("[DEV] confirm_password called without CSRF token");
    }
  }

  // 4) Валидируем новый пароль
  const newPassword = body.password?.trim();

  if (!newPassword) {
    throw new HTTPException(400, { message: "password_required" });
  }

  const validationError = validatePasswordStrength(newPassword);
  if (validationError) {
    throw new HTTPException(400, validationError as any);
  }

  // 5) Ищем пользователя в БД
  const user = await env.DB301
    .prepare(
      "SELECT id, email, password_hash, oauth_provider FROM users WHERE id=?"
    )
    .bind(userId)
    .first<{
      id: number;
      email: string;
      password_hash: string | null;
      oauth_provider: string | null;
    }>();

  if (!user) {
    throw new HTTPException(404, { message: "user_not_found" });
  }

  // 6) OAuth-only пользователь: пароля нет и быть не должно
  if (user.oauth_provider && !user.password_hash) {
    throw new HTTPException(400, {
      message: "oauth_only",
      provider: user.oauth_provider,
    } as any);
  }

  // 7) Проверка: новый пароль не должен совпадать со старым
  if (user.password_hash) {
    //  Используем verifyPassword из lib/password.ts (PBKDF2)
    const same = await verifyPassword(newPassword, user.password_hash);
    if (same) {
      throw new HTTPException(400, { message: "password_reused" });
    }
  }

  // 8) Хэшируем новый пароль и сохраняем в БД
  const hash = await hashPassword(newPassword);

  await env.DB301
    .prepare(
      "UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    )
    .bind(hash, user.id)
    .run();

  // 9) Инвалидация всех refresh-токенов пользователя
  try {
    const list = await env.KV_SESSIONS.list({ prefix: "refresh:" });

    for (const key of list.keys) {
      const v = await env.KV_SESSIONS.get(key.name);
      if (!v) continue;

      try {
        const json = JSON.parse(v);
        if (json.user_id === user.id) {
          await env.KV_SESSIONS.delete(key.name);
        }
      } catch {
        await env.KV_SESSIONS.delete(key.name);
      }
    }
  } catch (err) {
    console.error("[REFRESH_REVOKE_ERROR]", err);
  }

  // 10) Удаляем reset-сессию из KV и очищаем cookie
  await env.KV_SESSIONS.delete(resetKey);

  c.header(
    "Set-Cookie",
    "reset_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  );

  // 11) Логируем успешную смену пароля
  try {
    await logEvent(env, {
      account_id: undefined,
      user_id: user.id,
      event_type: "update",
      ip,
      ua,
      user_type: "client:none",
      details: {
        action: "reset_password_confirmed",
        channel: resetData.channel ?? "email",
        csrf_verified: !isDev,
        password_strength_checked: true,
      },
    });
  } catch (err) {
    console.error("[AUDIT_LOG ERROR confirm_password]", err);
  }

  // 12) Возвращаем успешный ответ
  return c.json(
    {
      status: "ok",
      user_id: user.id,
      ...(isDev && {
        channel: resetData.channel,
        identifier: resetData.identifier,
      }),
    },
    200
  );
});

export default app;

