// src/api/auth/me.ts
import type { Context } from "hono";
import { verifyJWT } from "../lib/jwt";

export async function me(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // Проверка секретов в production
  const isProduction = env.ENVIRONMENT === 'production';

  if (isProduction && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production. Run: wrangler secret put JWT_SECRET');
  }

  if (isProduction && !env.MASTER_SECRET) {
    throw new Error('MASTER_SECRET is required in production. Run: wrangler secret put MASTER_SECRET');
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    // Разделение ключей - JWT_SECRET для токенов, MASTER_SECRET для шифрования данных
    const jwtSecret = env.JWT_SECRET || "dev-jwt-secret-min-32-chars-for-local-development-only";

    if (!env.JWT_SECRET) {
      console.warn("JWT_SECRET not set! Using dev fallback. Run: wrangler secret put JWT_SECRET");
    }

    const payload = await verifyJWT(token, jwtSecret);
    const { user_id, account_id } = payload;

    // Строгая валидация JWT - требуем обязательное наличие account_id
    if (!user_id || !account_id) {
      return c.json({ error: "invalid_token_payload" }, 401);
    }

    const user = await env.DB301.prepare(
      "SELECT id, email, name, role FROM users WHERE id=?"
    ).bind(user_id).first();

    if (!user) {
      return c.json({ error: "user_not_found" }, 404);
    }

    //  Убран fallback - только прямой запрос по account_id из JWT
    const account = await env.DB301.prepare(
      "SELECT id, account_name, plan, status FROM accounts WHERE id=?"
    ).bind(account_id).first();

    if (!account) {
      return c.json({ error: "account_not_found" }, 404);
    }

    return c.json({
      user: {
        id: Number(user.id),
        email: user.email,
        name: user.name ?? null,
        role: user.role || "user",
        account_id: Number(account.id),
        account_name: account.account_name,
        plan: account.plan,
        status: account.status,
      },
    });
  } catch (error: any) {
    return c.json({ error: "invalid_or_expired_token", details: error.message }, 401);
  }
}
