/**
 * GitHub OAuth 2.0 Callback 
 *
 * Flow:
 * 1. Проверка state (CSRF) + получение PKCE verifier
 * 2. Обмен code → access_token (PKCE)
 * 3. Получение профиля GitHub + email (fallback запрос)
 * 4. Создание / обновление user
 * 5. Создание / обновление account + account_members
 * 6. Создание refresh session
 * 7. Запись audit_log
 * 8. Генерация JWT (fingerprint IP+UA)
 * 9. Redirect → https://301.st/auth/success?token=...
 */

import { Hono } from "hono";
import { consumeState } from "../../../lib/oauth";
import { signJWT } from "../../../lib/jwt";
import { logAuth } from "../../../lib/logger";
import { createRefreshSession } from "../../../lib/session";
import { extractRequestInfo } from "../../../lib/fingerprint";

const app = new Hono();

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return c.text("Missing OAuth parameters", 400);
    }

    const { ip, ua } = extractRequestInfo(c);

    // 1. Проверка state + извлечение PKCE verifier
    const verifier = await consumeState(c.env, "github", state);
    if (!verifier) {
      return c.text("Invalid or expired state", 400);
    }

    const client_id = c.env.GITHUB_CLIENT_ID;
    const client_secret = c.env.GITHUB_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;

    // 2. Обмен code → access_token (PKCE)
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        redirect_uri,
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      console.error("GitHub token exchange failed:", t);
      return c.text("Failed to exchange token", 500);
    }

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;
    if (!access_token) {
      return c.text("Missing access_token", 500);
    }

    // 3. Получение профиля GitHub
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) {
      return c.text("Failed to fetch GitHub profile", 500);
    }

    const gh = await userRes.json();

    let email = gh.email;
    const github_id = String(gh.id);
    const name = gh.name || gh.login || `github-${github_id}`;

    // GitHub часто скрывает email — получаем отдельным запросом
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find((e: any) => e.primary && e.verified);
        if (primary?.email) email = primary.email;
      }
    }

    // fallback если email скрыт полностью
    if (!email) {
      email = `github_${github_id}@301.st`;
    }

    email = email.toLowerCase();

    // 4. D1 — создание / обновление user
    const db = c.env.DB301;
    const now = new Date().toISOString();

    let user_id: number;
    let account_id: number;
    const user_type = "client";

    const existing = await db
      .prepare(
        `
      SELECT id FROM users
      WHERE email = ?1 OR (oauth_provider = 'github' AND oauth_id = ?2)
    `
      )
      .bind(email, github_id)
      .first<{ id: number }>();

    if (!existing) {
      // новый user
      const userInsert = await db
        .prepare(
          `
        INSERT INTO users (email, email_verified, password_hash, oauth_provider, oauth_id, name, user_type, created_at, updated_at)
        VALUES (?1, 1, NULL, 'github', ?2, ?3, 'client', ?4, ?4)
      `
        )
        .bind(email, github_id, name, now)
        .run();

      user_id = userInsert.meta.last_row_id as number;

      // создание аккаунта
      const accInsert = await db
        .prepare(
          `
        INSERT INTO accounts (user_id, account_name, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?3)
      `
        )
        .bind(user_id, name, now)
        .run();

      account_id = accInsert.meta.last_row_id as number;

      // создание membership — ВАЖНО
      await db
        .prepare(
          `
        INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
        VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
      `
        )
        .bind(account_id, user_id, now)
        .run();

      console.log(`[OAuth GitHub] New user created: ${email}`);
    } else {
      user_id = existing.id;

      // обновление oauth-полей
      await db
        .prepare(
          `
        UPDATE users
        SET oauth_provider = 'github',
            oauth_id = ?1,
            email_verified = 1,
            updated_at = ?2
        WHERE id = ?3
      `
        )
        .bind(github_id, now, user_id)
        .run();

      // получаем owner account
      const acc = await db
        .prepare(
          `
        SELECT account_id, role
        FROM account_members
        WHERE user_id = ?1 AND role='owner'
        LIMIT 1
      `
        )
        .bind(user_id)
        .first<{ account_id: number; role: string }>();

      if (acc?.account_id) {
        account_id = acc.account_id;
      } else {
        // создаём новый owner account, если пользователь был invited
        const accInsert = await db
          .prepare(
            `
          INSERT INTO accounts (user_id, account_name, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?3)
        `
          )
          .bind(user_id, name, now)
          .run();

        account_id = accInsert.meta.last_row_id as number;

        await db
          .prepare(
            `
          INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
          VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
        `
          )
          .bind(account_id, user_id, now)
          .run();
      }

      console.log(`[OAuth GitHub] Existing user: ${email}`);
    }

    // 6. refresh session
    await createRefreshSession(c, c.env, user_id, account_id, user_type);

    // 7. audit_log
    try {
      await logAuth(c.env, "login", user_id, account_id, ip, ua, user_type, "owner");
    } catch (e) {
      console.error("Audit log error:", e);
    }

    // 8. JWT + fingerprint
    const jwt = await signJWT(
      {
        typ: "access",
        user_id,
        account_id,
        iat: Math.floor(Date.now() / 1000),
      },
      c.env,
      "15m",
      { ip, ua }
    );

    // 9. redirect
    return Response.redirect(`https://301.st/auth/success?token=${jwt}`, 302);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    return c.text("OAuth callback failed", 500);
  }
});

export default app;

