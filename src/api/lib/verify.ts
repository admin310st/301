// src/api/lib/verify.ts

/**
 * Универсальная библиотека завершения OmniFlow.
 * НЕ endpoint - экспортирует функцию verifyOmniFlow().
 * Вызывается из endpoint /auth/verify.
 */

import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env } from "../types/worker";
import { verifyOmniToken } from "./omni_tokens";
import { logAuth } from "./logger";
import { signJWT } from "./jwt";
import { createRefreshSession } from "./session";

interface VerifyOmniFlowInput {
  token: string;
  code?: string | null;
  ip: string;
  ua: string;
}

interface VerifyOmniFlowResult {
  ok: boolean;
  type?: string;
  user?: {
    id: number;
    email: string;
    phone?: string | null;
    tg_id?: string | null;
    name?: string | null;
    user_type: string;
  };
  accounts?: any[];
  active_account_id?: number | null;
  access_token?: string;
  expires_in?: number;
  user_id?: number;
  csrf_token?: string;
  message?: string;
}

/**
 * Создаёт безопасный объект user без sensitive данных
 */
function sanitizeUser(user: any): VerifyOmniFlowResult["user"] {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || null,
    tg_id: user.tg_id || null,
    name: user.name || null,
    user_type: user.user_type || "client",
  };
}

/**
 * Универсальная функция завершения OmniFlow.
 * Обрабатывает: register, login, reset, invite, action, oauth.
 */
export async function verifyOmniFlow(
  env: Env,
  input: VerifyOmniFlowInput,
  context?: Context
): Promise<VerifyOmniFlowResult> {
  const { token, code, ip, ua } = input;

  if (!token) {
    throw new HTTPException(400, { message: "token_required" });
  }

  // 1. Проверяем omni-token
  const session = await verifyOmniToken(env, token, code);
  if (!session) {
    throw new HTTPException(400, { message: "invalid_or_expired_token" });
  }

  const { identifier, type } = session;

  if (!identifier) {
    throw new HTTPException(400, { message: "identifier_missing" });
  }

  // 2. Проверяем/создаём пользователя
  let user = await env.DB301
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(identifier)
    .first();

  if (!user) {
    // User не существует
    if (type !== "register") {
      // Для login/reset/etc требуется существующий пользователь
      throw new HTTPException(404, { message: "user_not_found" });
    }

    // Создаём нового пользователя (только для register)
    const password_hash = session.payload?.password_hash || null;

    const res = await env.DB301
      .prepare(
        `INSERT INTO users (email, password_hash, user_type, created_at, updated_at)
         VALUES (?, ?, 'client', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(identifier, password_hash)
      .run();

    user = {
      id: res.meta?.last_row_id || res.lastInsertRowId,
      email: identifier,
      password_hash,
      user_type: "client",
    };
  } else if (type === "register") {
    // User существует — проверяем есть ли у него owner аккаунт
    const ownerAccount = await env.DB301
      .prepare(
        "SELECT id FROM account_members WHERE user_id = ? AND role = 'owner'"
      )
      .bind(user.id)
      .first();

    if (ownerAccount) {
      // Уже есть owner аккаунт — нельзя регистрироваться повторно
      throw new HTTPException(409, { message: "user_already_registered" });
    }
    // Пользователь был invited (editor/viewer) — разрешаем создать owner аккаунт
  }

  const userId = user.id;
  let accountId: number | null = null;
  let accountRole: "owner" | "editor" | "viewer" | "none" = "none";

  // 3. Создание аккаунта (register) или выбор (reset/login)
  if (type === "register") {
    const acc = await env.DB301
      .prepare(
        `INSERT INTO accounts (user_id, account_name, created_at, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(userId, identifier.split('@')[0] || 'Account')
      .run();

    accountId = acc.meta?.last_row_id || acc.lastInsertRowId;

    await env.DB301
      .prepare(
        `INSERT INTO account_members (account_id, user_id, role)
         VALUES (?, ?, 'owner')`
      )
      .bind(accountId, userId)
      .run();

    accountRole = "owner";
  } else {
    const am = await env.DB301
      .prepare(
        `SELECT account_id, role FROM account_members
         WHERE user_id = ?
         ORDER BY account_id ASC LIMIT 1`
      )
      .bind(userId)
      .first();

    if (!am) throw new HTTPException(403, { message: "no_account" });

    accountId = am.account_id;
    accountRole = am.role;
  }

  // 4. Создаём session в БД
  const sess = await env.DB301
    .prepare(
      `INSERT INTO sessions (user_id, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .bind(userId, ip, ua)
    .run();

  const sessionId = sess.meta?.last_row_id || sess.lastInsertRowId;

  // 5. Reset flow — CSRF-защищённая reset_session
  if (type === "reset") {
    const resetSessionId = crypto.randomUUID();
    const csrfToken = crypto.randomUUID();

    await env.KV_SESSIONS.put(
      `reset:${resetSessionId}`,
      JSON.stringify({
        user_id: userId,
        channel: session.channel || "email",
        identifier,
        csrf_token: csrfToken,
      }),
      { expirationTtl: 900 }
    );

    if (context) {
      context.header(
        "Set-Cookie",
        `reset_session=${resetSessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`
      );
    }

    try {
      await logAuth(env, "login", userId, accountId, ip, ua, user.user_type || "client", accountRole);
    } catch (err) {
      console.error("[AUDIT_LOG ERROR verify reset]", err);
    }

    return {
      ok: true,
      type: "reset",
      user_id: userId,
      csrf_token: csrfToken,
      message: "reset_verified_proceed_to_confirm",
    };
  }

  // 6. Register/login flow — создаём refresh session
  if (context) {
    await createRefreshSession(context, env, userId, accountId, user.user_type || "client");
  }

  // 7. Создаём access_token с fingerprint
  const accessToken = await signJWT(
    {
      typ: "access",
      user_id: userId,
      account_id: accountId,
      session_id: sessionId,
      iat: Math.floor(Date.now() / 1000),
    },
    env,
    "15m",
    { ip, ua }
  );

  // 8. Загружаем аккаунты
  const accountsResult = await env.DB301
    .prepare(
      `SELECT
         am.account_id AS id,
         am.role,
         am.status,
         a.user_id
       FROM account_members am
       JOIN accounts a ON am.account_id = a.id
       WHERE am.user_id = ?
       ORDER BY am.account_id ASC`
    )
    .bind(userId)
    .all();

  const accounts = accountsResult.results || [];

  // 9. Логирование
  try {
    await logAuth(
      env,
      type === "reset" ? "login" : (type as "register" | "login" | "logout" | "refresh"),
      userId,
      accountId,
      ip,
      ua,
      user.user_type || "client",
      accountRole
    );
  } catch (err) {
    console.error("[AUDIT_LOG ERROR verify]", err);
  }

  // 10. Возвращаем ответ без password_hash
  return {
    ok: true,
    user: sanitizeUser(user),
    accounts,
    active_account_id: accountId,
    access_token: accessToken,
    expires_in: 900,
  };
}

