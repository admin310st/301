// src/api/auth/change_password.ts

/**
 * POST /auth/change_password
 * Authenticated password change for logged-in users.
 * Requires current password verification before setting new one.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "../lib/auth";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../lib/password";
import { logEvent } from "../lib/logger";
import { extractRequestInfo } from "../lib/fingerprint";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const env = c.env;
  const { ip, ua } = extractRequestInfo(c);

  // 1) Auth check
  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  // 2) Parse body
  const body = await c.req.json().catch(() => ({} as any));
  const currentPassword = body.current_password?.trim();
  const newPassword = body.new_password?.trim();

  if (!currentPassword || !newPassword) {
    throw new HTTPException(400, { message: "current_password_and_new_password_required" });
  }

  // 3) Fetch user from DB
  const user = await env.DB301
    .prepare("SELECT id, password_hash, oauth_provider FROM users WHERE id = ?")
    .bind(auth.user_id)
    .first<{
      id: number;
      password_hash: string | null;
      oauth_provider: string | null;
    }>();

  if (!user) {
    throw new HTTPException(404, { message: "user_not_found" });
  }

  // 4) OAuth-only guard
  if (user.oauth_provider && !user.password_hash) {
    throw new HTTPException(400, {
      message: "oauth_only",
      provider: user.oauth_provider,
    } as any);
  }

  // 5) Verify current password
  const currentValid = await verifyPassword(currentPassword, user.password_hash);
  if (!currentValid) {
    throw new HTTPException(400, { message: "wrong_password" });
  }

  // 6) Validate new password strength
  const validationError = validatePasswordStrength(newPassword);
  if (validationError) {
    throw new HTTPException(400, validationError as any);
  }

  // 7) New password must differ from current
  const same = await verifyPassword(newPassword, user.password_hash);
  if (same) {
    throw new HTTPException(400, { message: "same_password" });
  }

  // 8) Hash and save new password
  const hash = await hashPassword(newPassword);

  await env.DB301
    .prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(hash, user.id)
    .run();

  // 9) Invalidate all refresh tokens
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

  // 10) Audit log
  try {
    await logEvent(env, {
      user_id: user.id,
      event_type: "update",
      ip,
      ua,
      user_type: "client:none",
      details: {
        action: "change_password",
      },
    });
  } catch (err) {
    console.error("[AUDIT_LOG ERROR change_password]", err);
  }

  // 11) Response
  return c.json({ ok: true, message: "password_changed" }, 200);
});

export default app;
