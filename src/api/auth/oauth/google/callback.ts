/**
 * Endpoint:
 *   GET /auth/oauth/google/callback
 *
 * Flow:
 * 1) Проверка state (CSRF) и извлечение PKCE verifier из KV
 * 2) Обмен code → tokens (access_token + id_token)
 * 3) ИСПРАВЛЕНО #1: Верификация id_token через JWKS
 * 4) D1: поиск пользователя по email или (oauth_provider, oauth_id), создание / обновление
 * 5) ИСПРАВЛЕНО #2: Создание refresh session с правильным форматом
 * 6) Запись события в audit_log через logAuth()
 * 7) ИСПРАВЛЕНИЕ #4: JWT с fingerprinting (IP + UA)
 * 8) Redirect → https://301.st/auth/success?token=...
 */

import { Hono } from "hono";
import { consumeState, buildSuccessRedirectUrl } from "../../../lib/oauth";
import { signJWT } from "../../../lib/jwt";
import { logAuth } from "../../../lib/logger";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createRefreshSession } from "../../../lib/session";
import { extractRequestInfo } from "../../../lib/fingerprint";

const app = new Hono();

app.get("/", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return c.text("Missing OAuth parameters", 400);

    const { ip, ua } = extractRequestInfo(c);

    // 1) Проверка state (CSRF) и извлечение PKCE verifier
    const stateData = await consumeState(c.env, "google", state);
    if (!stateData) {
      return c.text("Invalid or expired state", 400);
    }
    const { verifier, redirectHost } = stateData;

    const client_id = c.env.GOOGLE_CLIENT_ID;
    const client_secret = c.env.GOOGLE_CLIENT_SECRET;
    const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";
    const redirect_uri = `${redirect_base}/auth/oauth/google/callback`;

    // 2) Обмен code → tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        client_secret,
        code,
        redirect_uri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Google token exchange failed:", tokenRes.status, errText);
      return c.text(`Token exchange failed: ${tokenRes.status} ${errText}`, 500);
    }

    const tokenData = await tokenRes.json();
    const idToken = tokenData.id_token;
    if (!idToken) return c.text("Missing id_token", 500);

    // 3) Верификация ID token через JWKS
    let payload: any;
    try {
      const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
      
      const { payload: verifiedPayload } = await jwtVerify(idToken, JWKS, {
        issuer: "https://accounts.google.com",
        audience: client_id,
      });
      
      payload = verifiedPayload;
    } catch (verifyError) {
      console.error("ID token verification failed:", verifyError);
      return c.text("Invalid ID token", 403);
    }

    const email: string = payload.email?.toLowerCase();
    const name: string = payload.name || "";
    const sub: string = payload.sub;

    if (!email) {
      return c.text("Email not provided by Google", 400);
    }

    // 4) Работа с D1: users / accounts / account_members
    const db = c.env.DB301;
    const now = new Date().toISOString();

    let user_id: number;
    let account_id: number;
    let user_type: string = "client";
    let accountRole: "owner" | "editor" | "viewer" = "owner";

    // Поиск пользователя по email или (oauth_provider, oauth_id)
    const existing = await db.prepare(`
      SELECT id, user_type FROM users
      WHERE email = ?1 OR (oauth_provider = 'google' AND oauth_id = ?2)
    `).bind(email, sub).first<{ id: number; user_type: string | null }>();

    if (!existing) {
      // Создание нового пользователя
      const userInsert = await db.prepare(`
        INSERT INTO users (email, email_verified, password_hash, oauth_provider, oauth_id, name, user_type, created_at, updated_at)
        VALUES (?1, 1, NULL, 'google', ?2, ?3, 'client', ?4, ?4)
      `).bind(email, sub, name, now).run();

      user_id = userInsert.meta?.last_row_id as number;
      user_type = "client";

      // Создание аккаунта
      const accountInsert = await db.prepare(`
        INSERT INTO accounts (user_id, account_name, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?3)
      `).bind(user_id, name || email.split('@')[0], now).run();

      account_id = accountInsert.meta?.last_row_id as number;

      // Создание membership с ролью owner
      await db.prepare(`
        INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
        VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
      `).bind(account_id, user_id, now).run();

      accountRole = "owner";
      console.log(`[OAuth Google] New user created: ${email}`);

    } else {
      // Существующий пользователь
      user_id = existing.id;
      user_type = existing.user_type || "client";

      // Обновляем OAuth данные
      await db.prepare(`
        UPDATE users
        SET oauth_provider = 'google', oauth_id = ?1, email_verified = 1, updated_at = ?2
        WHERE id = ?3
      `).bind(sub, now, user_id).run();

      // Проверяем есть ли owner аккаунт
      const ownerMembership = await db.prepare(`
        SELECT am.account_id, am.role 
        FROM account_members am
        WHERE am.user_id = ?1 AND am.role = 'owner'
        LIMIT 1
      `).bind(user_id).first<{ account_id: number; role: string }>();

      if (ownerMembership) {
        // Уже есть owner аккаунт — используем его
        account_id = ownerMembership.account_id;
        accountRole = "owner";
        console.log(`[OAuth Google] Existing owner: ${email}`);
      } else {
        // Был invited — создаём owner аккаунт
        const accountInsert = await db.prepare(`
          INSERT INTO accounts (user_id, account_name, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?3)
        `).bind(user_id, name || email.split('@')[0], now).run();

        account_id = accountInsert.meta?.last_row_id as number;

        await db.prepare(`
          INSERT INTO account_members (account_id, user_id, role, status, created_at, updated_at)
          VALUES (?1, ?2, 'owner', 'active', ?3, ?3)
        `).bind(account_id, user_id, now).run();

        accountRole = "owner";
        console.log(`[OAuth Google] Created owner account for invited user: ${email}`);
      }
    }

    // 5) Создание refresh session
    await createRefreshSession(c, c.env, user_id, account_id, user_type);

    // 6) Запись события в audit_log
    try {
      await logAuth(c.env, 'login', user_id, account_id, ip, ua, user_type, accountRole);
    } catch (logErr) {
      console.error('Audit log write error:', logErr);
    }

    // 7) JWT с fingerprinting
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

    // 8) Redirect на исходный хост
    const redirectTo = buildSuccessRedirectUrl(redirectHost, jwt);
    return Response.redirect(redirectTo, 302);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return c.text('OAuth callback failed', 500);
  }
});

export default app;

