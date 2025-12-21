/**
 * GitHub OAuth 2.0 Callback
 * 
 * GitHub НЕ поддерживает PKCE для OAuth Apps
 * Используем только state для CSRF protection.
 */

import { Hono } from "hono";
import { consumeState, buildSuccessRedirectUrl } from "../../../lib/oauth";
import { signJWT } from "../../../lib/jwt";
import { logAuth } from "../../../lib/logger";
import { createRefreshSession } from "../../../lib/session";
import { extractRequestInfo } from "../../../lib/fingerprint";

const app = new Hono();

// GitHub API требует User-Agent
const GITHUB_USER_AGENT = "301.st-OAuth/1.0";

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return c.text("Missing OAuth parameters", 400);
    }

    const { ip, ua } = extractRequestInfo(c);

    // 1. Проверка state (CSRF) — verifier игнорируется GitHub'ом
    const stateData = await consumeState(c.env, "github", state);
    if (!stateData) {
      return c.text("Invalid or expired state", 400);
    }
    const { redirectHost } = stateData;
    // verifier не используется для GitHub (не поддерживает PKCE)

    const client_id = c.env.GITHUB_CLIENT_ID;
    const client_secret = c.env.GITHUB_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/github/callback`;

    // 2. Обмен code → access_token (БЕЗ PKCE — GitHub не поддерживает)
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": GITHUB_USER_AGENT,
      },
      body: JSON.stringify({
        client_id,
        client_secret,
        code,
        redirect_uri,
        // НЕ передаём code_verifier — GitHub игнорирует
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("GitHub token exchange failed:", tokenRes.status, errText);
      return c.text(`Token exchange failed: ${tokenRes.status}`, 500);
    }

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;
    
    if (!access_token) {
      console.error("GitHub token response:", tokenData);
      return c.text("Missing access_token from GitHub", 500);
    }

    // 3. Получение профиля GitHub (User-Agent ОБЯЗАТЕЛЕН!)
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "User-Agent": GITHUB_USER_AGENT,
        "Accept": "application/vnd.github+json",
      },
    });

    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error("GitHub user fetch failed:", userRes.status, errText);
      return c.text(`Failed to fetch GitHub profile: ${userRes.status}`, 500);
    }

    const gh = await userRes.json();

    let email = gh.email;
    const github_id = String(gh.id);
    const name = gh.name || gh.login || `github-${github_id}`;

    // 4. GitHub часто скрывает email — запрашиваем отдельно
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          "Authorization": `Bearer ${access_token}`,
          "User-Agent": GITHUB_USER_AGENT,
          "Accept": "application/vnd.github+json",
        },
      });

      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find((e: any) => e.primary && e.verified);
        if (primary?.email) email = primary.email;
      }
    }

    // Fallback если email полностью скрыт
    if (!email) {
      email = `github_${github_id}@301.st`;
    }

    email = email.toLowerCase();

    // 5. D1 — создание / обновление user
    const db = c.env.DB301;
    const now = new Date().toISOString();

    let user_id: number;
    let account_id: number;
    const user_type = "client";

    const existing = await db
      .prepare(`
        SELECT id FROM users
        WHERE email = ?1 OR (oauth_provider = 'github' AND oauth_id = ?2)
      `)
      .bind(email, github_id)
      .first<{ id: number }>();

    if (!existing) {
      // Новый user
      const userInsert = await db
        .prepare(`
          INSERT INTO users (email, email_verified, password_hash, oauth_provider, oauth_id, name, user_type, created_at, updated_at)
          VALUES (?1, 1, NULL, 'github', ?2, ?3, 'client', ?4, ?4)
        `)
        .bind(email, github_id, name, now)
        .run();

      user_id = userInsert.meta.last_row_id as number;

      // Создание аккаунта
      const accInsert = await db
        .prepare(`
          INSERT INTO accounts (user_id, account_name, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?3)
        `)
        .bind(user_id, name, now)
        .run();

      account_id = accInsert.meta.last_row_id as number;

      // Создание membership
      await db
        .prepare(`
          INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
          VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
        `)
        .bind(account_id, user_id, now)
        .run();

      console.log(`[OAuth GitHub] New user: ${email}`);
    } else {
      user_id = existing.id;

      // Обновление oauth-полей
      await db
        .prepare(`
          UPDATE users
          SET oauth_provider = 'github', oauth_id = ?1, email_verified = 1, updated_at = ?2
          WHERE id = ?3
        `)
        .bind(github_id, now, user_id)
        .run();

      // Получаем owner account
      const acc = await db
        .prepare(`
          SELECT account_id FROM account_members
          WHERE user_id = ?1 AND role = 'owner'
          LIMIT 1
        `)
        .bind(user_id)
        .first<{ account_id: number }>();

      if (acc?.account_id) {
        account_id = acc.account_id;
      } else {
        // Создаём owner account если пользователь был invited
        const accInsert = await db
          .prepare(`
            INSERT INTO accounts (user_id, account_name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
          `)
          .bind(user_id, name, now)
          .run();

        account_id = accInsert.meta.last_row_id as number;

        await db
          .prepare(`
            INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
            VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
          `)
          .bind(account_id, user_id, now)
          .run();
      }

      console.log(`[OAuth GitHub] Existing user: ${email}`);
    }

    // 6. Refresh session
    await createRefreshSession(c, c.env, user_id, account_id, user_type);

    // 7. Audit log
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

    // 9. Redirect на исходный хост
    const redirectTo = buildSuccessRedirectUrl(redirectHost, jwt);
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    console.error("GitHub OAuth callback error:", err);
    return c.text("OAuth callback failed", 500);
  }
});

export default app;
