// src/api/lib/auth.ts

/**
 * Хелперы авторизации для защищённых endpoints.
 * Используется внутри handlers для проверки JWT и получения данных пользователя.
 */

import { Context } from "hono";
import { verifyJWT } from "./jwt";
import { extractRequestInfo } from "./fingerprint";
import type { Env } from "../types/worker";

// TYPES

export interface AuthPayload {
  user_id: number;
  account_id: number;
  session_id?: number;
}

export interface AuthWithRole extends AuthPayload {
  role: "owner" | "editor" | "viewer";
}

// HELPERS

/**
 * Проверяет JWT и возвращает payload с user_id и account_id.
 * Возвращает null если токен невалидный или отсутствует.
 * 
 * @example
 * const auth = await requireAuth(c, c.env);
 * if (!auth) {
 *   return c.json({ ok: false, error: "unauthorized" }, 401);
 * }
 * const { user_id, account_id } = auth;
 */
export async function requireAuth(
  c: Context,
  env: Env
): Promise<AuthPayload | null> {
  const authHeader = c.req.header("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7);
  const { ip, ua } = extractRequestInfo(c);

  const payload = await verifyJWT(token, env, { ip, ua });
  
  if (!payload || !payload.user_id || !payload.account_id) {
    return null;
  }

  return {
    user_id: payload.user_id,
    account_id: payload.account_id,
    session_id: payload.session_id,
  };
}

/**
 * Проверяет JWT и загружает роль пользователя в аккаунте.
 * Возвращает null если токен невалидный или пользователь не в аккаунте.
 * 
 * @example
 * const auth = await requireAuthWithRole(c, c.env);
 * if (!auth) {
 *   return c.json({ ok: false, error: "unauthorized" }, 401);
 * }
 * if (auth.role !== "owner") {
 *   return c.json({ ok: false, error: "forbidden" }, 403);
 * }
 */
export async function requireAuthWithRole(
  c: Context,
  env: Env
): Promise<AuthWithRole | null> {
  const auth = await requireAuth(c, env);
  
  if (!auth) {
    return null;
  }

  // Загружаем роль из D1
  const member = await env.DB301.prepare(
    `SELECT role FROM account_members 
     WHERE user_id = ? AND account_id = ? AND status = 'active'`
  )
    .bind(auth.user_id, auth.account_id)
    .first<{ role: "owner" | "editor" | "viewer" }>();

  if (!member) {
    return null;
  }

  return {
    ...auth,
    role: member.role,
  };
}

/**
 * Проверяет что пользователь — owner аккаунта.
 * 
 * @example
 * const auth = await requireOwner(c, c.env);
 * if (!auth) {
 *   return c.json({ ok: false, error: "owner_required" }, 403);
 * }
 */
export async function requireOwner(
  c: Context,
  env: Env
): Promise<AuthWithRole | null> {
  const auth = await requireAuthWithRole(c, env);
  
  if (!auth || auth.role !== "owner") {
    return null;
  }

  return auth;
}

/**
 * Проверяет что пользователь — owner или editor.
 * 
 * @example
 * const auth = await requireEditor(c, c.env);
 * if (!auth) {
 *   return c.json({ ok: false, error: "editor_required" }, 403);
 * }
 */
export async function requireEditor(
  c: Context,
  env: Env
): Promise<AuthWithRole | null> {
  const auth = await requireAuthWithRole(c, env);
  
  if (!auth || (auth.role !== "owner" && auth.role !== "editor")) {
    return null;
  }

  return auth;
}

