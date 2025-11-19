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
import { extractRequestInfo } from "./fingerprint";

interface VerifyOmniFlowInput {
  token: string;
  code?: string | null;
  ip: string;
  ua: string;
}

interface VerifyOmniFlowResult {
  ok: boolean;
  type?: string;
  user?: any;
  accounts?: any[];
  active_account_id?: number | null;
  access_token?: string;
  expires_in?: number;
  user_id?: number;
  csrf_token?: string;
  message?: string;
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
    const res = await env.DB301
      .prepare(
        `INSERT INTO users (email, user_type, created_at, updated_at)
         VALUES (?, 'client', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(identifier)
      .run();

    user = {
      id: res.meta?.last_row_id || res.lastInsertRowId,
      email: identifier,
      user_type: "client",
    };
  }

  const userId = user.id;
  let accountId: number | null = null;
  let accountRole: "owner" | "editor" | "viewer" | "none" = "none";

  // 3. Создание аккаунта (register) или выбор (reset/login)
  if (type === "register") {
    const acc = await env.DB301
      .prepare(
        `INSERT INTO accounts (owner_user_id, created_at, updated_at)
         VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(userId)
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

  // создаём CSRF-защищённую reset_session
  if (type === "reset") {
    const resetSessionId = crypto.randomUUID();
    const csrfToken = crypto.randomUUID();

    // Сохраняем reset session с CSRF token
    await env.KV_SESSIONS.put(
      `reset:${resetSessionId}`,
      JSON.stringify({
        user_id: userId,
        channel: session.channel || "email",
        identifier,
        csrf_token: csrfToken,
      }),
      { expirationTtl: 900 } // 15 минут
    );

    // Устанавливаем reset_session cookie (HttpOnly) если есть context
    if (context) {
      context.header(
        "Set-Cookie",
        `reset_session=${resetSessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`
      );
    }

    // Логируем событие reset verified
    try {
      await logAuth(
        env,
        "login",
        userId,
        accountId,
        ip,
        ua,
        user.user_type || "client",
        accountRole
      );
    } catch (err) {
      console.error("[AUDIT_LOG ERROR verify reset]", err);
    }

    // Возвращаем специальный ответ для reset flow с CSRF token
    return {
      ok: true,
      type: "reset",
      user_id: userId,
      csrf_token: csrfToken, // UI получит и отправит в confirm_password
      message: "reset_verified_proceed_to_confirm",
    };
  }

  // 5. Для register/login flow — создаём обычную refresh session
  if (context) {
    await createRefreshSession(
      context,
      env,
      userId,
      accountId,
      user.user_type || "client"
    );
  }

  // 6. Создаём access_token с fingerprint
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

  // 7. Загружаем аккаунты
  const accountsResult = await env.DB301
    .prepare(
      `SELECT
         am.account_id AS id,
         am.role,
         am.status,
         a.owner_user_id
       FROM account_members am
       JOIN accounts a ON am.account_id = a.id
       WHERE am.user_id = ?
       ORDER BY am.account_id ASC`
    )
    .bind(userId)
    .all();

  const accounts = accountsResult.results || [];

  // 8. Логирование
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

  // 9. Возвращаем успешный ответ для register/login
  return {
    ok: true,
    user,
    accounts,
    active_account_id: accountId,
    access_token: accessToken,
    expires_in: 900,
  };
}
