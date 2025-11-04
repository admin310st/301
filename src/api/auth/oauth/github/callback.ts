/**
 * GitHub OAuth 2.0 Callback — финальная продакшн версия (исправленная)
 *
 * Endpoint:
 * - GET /auth/oauth/github/callback
 *
 * Flow:
 * 1. Проверка state (CSRF)
 * 2. Обмен code → access_token
 * 3. Получение профиля пользователя GitHub
 * 4. Создание / обновление пользователя и аккаунта в D1
 * 5. Запись события в audit_log через logAuth()
 * 6. Генерация JWT (user_id, account_id, role)
 * 7. Редирект в панель управления
 */

import { Hono } from "hono";
import { consumeState } from "../../../lib/oauth";
import { signJWT } from "../../../lib/jwt";
import { logAuth } from "../../../lib/logger";

const app = new Hono();

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return c.text("Missing OAuth parameters", 400);
    }

    const stateValue = await consumeState(c.env, "github", state);
    if (stateValue === null) {
      return c.text("Invalid or expired state", 400);
    }

    const client_id = c.env.GITHUB_CLIENT_ID;
    const client_secret = c.env.GITHUB_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        redirect_uri,
        state,
      }),
    });

    if (!tokenRes.ok) {
      return c.text("Failed to exchange token", 500);
    }

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;
    if (!access_token) {
      return c.text("Missing access_token", 500);
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const user = await userRes.json();

    // GitHub может не возвращать email - запрашиваем отдельно
    let email = user.email;
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const emails = await emailRes.json();
      const primaryEmail = emails.find((e: any) => e.primary && e.verified);
      email = primaryEmail?.email || `github${user.id}@301.st`;
    }

    const name = user.name || user.login;
    const github_id = String(user.id);

    const db = c.env.DB301;
    const now = new Date().toISOString();
    const ip = c.req.header("cf-connecting-ip") || "0.0.0.0";
    const ua = c.req.header("user-agent") || "unknown";

    let user_id: number;
    let account_id: number;
    let role: string = "user";

    const existing = await db.prepare(`
      SELECT id, role FROM users 
      WHERE email = ?1 OR (oauth_provider = 'github' AND oauth_id = ?2)
    `).bind(email, github_id).first<{ id: number; role: string | null }>();

    if (!existing) {
      const userInsert = await db.prepare(`
        INSERT INTO users (email, password_hash, oauth_provider, oauth_id, tg_id, name, role, user_type, created_at, updated_at)
        VALUES (?1, NULL, 'github', ?2, NULL, ?3, 'user', 'client', ?4, ?4)
      `).bind(email, github_id, name, now).run();
      // @ts-ignore
      user_id = userInsert.meta.last_row_id as number;
      role = "user";

      const accountInsert = await db.prepare(`
        INSERT INTO accounts (user_id, account_name, cf_account_id, plan, status, created_at, updated_at)
        VALUES (?1, ?2, NULL, 'free', 'active', ?3, ?3)
      `).bind(user_id, name || email.split('@')[0], now).run();
      // @ts-ignore
      account_id = accountInsert.meta.last_row_id as number;

      console.log(`New GitHub user created: ${email}`);
    } else {
      user_id = existing.id;
      role = existing.role || "user";

      await db.prepare(`
        UPDATE users 
        SET oauth_provider = 'github', oauth_id = ?1, updated_at = ?2 
        WHERE id = ?3
      `).bind(github_id, now, user_id).run();

      const acc = await db.prepare(`SELECT id FROM accounts WHERE user_id = ?1`)
        .bind(user_id).first<{ id: number }>();

      if (acc && acc.id) {
        account_id = acc.id;
      } else {
        const accountInsert = await db.prepare(`
          INSERT INTO accounts (user_id, account_name, cf_account_id, plan, status, created_at, updated_at)
          VALUES (?1, ?2, NULL, 'free', 'active', ?3, ?3)
        `).bind(user_id, name || email.split('@')[0], now).run();
        // @ts-ignore
        account_id = accountInsert.meta.last_row_id as number;
      }

      console.log(`Existing GitHub user: ${email}`);
    }

    try {
      await logAuth(c.env, 'login', user_id, account_id, ip, ua);
    } catch (logErr) {
      console.error('Audit log write error:', logErr);
    }

    const jwt = await signJWT({ user_id, account_id, role }, c.env);

    const redirectTo = `https://301.st/auth/success?token=${jwt}`;
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    return c.text("OAuth callback failed", 500);
  }
});

export default app;

