// src/api/auth/confirm_password.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashPassword } from "../lib/password";
import { logEvent } from "../lib/logger";
import { compare } from "bcrypt-ts";

const app = new Hono();

/**
 * FINISH PASSWORD RESET FLOW:
 * /auth/reset_password  → старт
 * /auth/verify?type=reset → подтверждение
 * /auth/confirm_password → установка нового пароля
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

  // 1) Извлекаем reset_session
  const cookieHeader = c.req.header("Cookie") || "";
  const resetMatch = cookieHeader.match(/reset_session=([^;]+)/);

  if (!resetMatch) {
    throw new HTTPException(401, { message: "reset_session_required" });
  }

  const resetSessionId = resetMatch[1];
  const resetKey = `reset:${resetSessionId}`;

  // 2) Читаем KV
  const raw = await env.KV_SESSIONS.get(resetKey);
  if (!raw) {
    throw new HTTPException(401, { message: "reset_session_expired" });
  }

  let resetData: { user_id: number; channel?: string; identifier?: string };

  try {
    resetData = JSON.parse(raw);
  } catch {
    throw new HTTPException(401, { message: "reset_session_invalid" });
  }

  const userId = Number(resetData.user_id);

  if (!userId || Number.isNaN(userId)) {
    throw new HTTPException(401, { message: "reset_session_invalid" });
  }

  // 3) Берём новый пароль
  const body = await c.req.json().catch(() => ({} as any));
  const newPassword = body.password?.trim();

  if (!newPassword || newPassword.length < 6) {
    throw new HTTPException(400, { message: "invalid_password" });
  }

  // 4) Ищем пользователя
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

  // 5) OAuth-only: пароля нет и быть не должно
  if (user.oauth_provider && !user.password_hash) {
    throw new HTTPException(400, {
      message: "oauth_only",
      provider: user.oauth_provider,
    } as any);
  }

  // 6) Новый пароль = старый?
  if (user.password_hash) {
    const same = await compare(newPassword, user.password_hash);
    if (same) {
      throw new HTTPException(400, { message: "password_reused" });
    }
  }

  // 7) Хэшируем и сохраняем
  const hash = await hashPassword(newPassword);

  await env.DB301
    .prepare(
      "UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    )
    .bind(hash, user.id)
    .run();

  // 8) Инвалидация refresh-токенов
  try {
    const list = await env.KV_SESSIONS.list({ prefix: "refresh:" });

    for (const key of list.keys) {
      const v = await env.KV_SESSIONS.get(key.name);
      if (!v) continue;

      // refresh-values: { user_id, account_id, user_type }
      try {
        const json = JSON.parse(v);
        if (json.user_id === user.id) {
          await env.KV_SESSIONS.delete(key.name);
        }
      } catch {
        // malformed entry — удаляем для безопасности
        await env.KV_SESSIONS.delete(key.name);
      }
    }
  } catch (err) {
    console.error("[REFRESH_REVOKE_ERROR]", err);
  }

  // 9) Удаляем reset-сессию и cookie
  await env.KV_SESSIONS.delete(resetKey);

  c.header(
    "Set-Cookie",
    "reset_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  );

  // 10) Аудит
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
      },
    });
  } catch (err) {
    console.error("[AUDIT_LOG ERROR confirm_password]", err);
  }

  // 11) Возвращаем успешный ответ
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

