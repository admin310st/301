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
import { consumeState } from "../../../lib/oauth";
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

    // ИСПРАВЛЕНИЕ #4: Извлечение IP и UA
    const { ip, ua } = extractRequestInfo(c);

    // 1) Проверка state (CSRF) и извлечение PKCE verifier
    let verifier = await consumeState(c.env, "google", state);
    if (!verifier) {
      const fallbackKey = `oauth:google:state:${state}`;
      verifier = await c.env.KV_SESSIONS.get(fallbackKey);
      if (!verifier) return c.text("Invalid or expired state", 400);
      await c.env.KV_SESSIONS.delete(fallbackKey);
    }

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

    // 3) ИСПРАВЛЕНИЕ #1: Верификация ID token через JWKS
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

    const email: string = payload.email;
    const name: string = payload.name;
    const sub: string = payload.sub;

    // 4) Работа с D1: users / accounts
    const db = c.env.DB301;
    const now = new Date().toISOString();

    let user_id: number;
    let account_id: number;
    let role: string = "user";
    let user_type: string = "client";

    // Поиск пользователя по email или (oauth_provider, oauth_id)
    const existing = await db.prepare(`
      SELECT id, role, user_type FROM users
      WHERE email = ?1 OR (oauth_provider = 'google' AND oauth_id = ?2)
    `).bind(email, sub).first<{ id: number; role: string | null; user_type: string | null }>();

    if (!existing) {
      // Создание нового пользователя
      const userInsert = await db.prepare(`
        INSERT INTO users (email, password_hash, oauth_provider, oauth_id, tg_id, name, role, user_type, created_at, updated_at)
        VALUES (?1, NULL, 'google', ?2, NULL, ?3, 'user', 'client', ?4, ?4)
      `).bind(email, sub, name, now).run();
      // @ts-ignore
      user_id = userInsert.meta.last_row_id as number;
      role = "user";
      user_type = "client";

      // Создание аккаунта
      const accountInsert = await db.prepare(`
        INSERT INTO accounts (user_id, account_name, cf_account_id, plan, status, created_at, updated_at)
        VALUES (?1, ?2, NULL, 'free', 'active', ?3, ?3)
      `).bind(user_id, name || email.split('@')[0], now).run();
      // @ts-ignore
      account_id = accountInsert.meta.last_row_id as number;

      console.log(`New Google user created: ${email}`);
    } else {
      // Обновление существующего пользователя
      user_id = existing.id;
      role = existing.role || "user";
      user_type = existing.user_type || "client";

      await db.prepare(`
        UPDATE users
        SET oauth_provider = 'google', oauth_id = ?1, updated_at = ?2
        WHERE id = ?3
      `).bind(sub, now, user_id).run();

      // Проверка / создание аккаунта
      const acc = await db.prepare(`SELECT id FROM accounts WHERE user_id = ?1`).bind(user_id).first<{ id: number }>();
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

      console.log(`Existing Google user: ${email}`);
    }

    // 5) ИСПРАВЛЕНИЕ #2: Создание refresh session с правильным форматом
    await createRefreshSession(c, c.env, user_id, account_id, user_type);

    // 6) Запись события в audit_log
    try {
      await logAuth(c.env, 'login', user_id, account_id, ip, ua);
    } catch (logErr) {
      console.error('Audit log write error:', logErr);
    }

    // 7) ИСПРАВЛЕНИЕ #4: JWT с fingerprinting
    const jwt = await signJWT(
      { user_id, account_id, role },
      c.env,
      "15m",
      { ip, ua }  // Fingerprint
    );

    // 8) Redirect
    const redirectTo = `https://301.st/auth/success?token=${jwt}`;
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    console.error('OAuth callback error:', err);
    return c.text('OAuth callback failed', 500);
  }
});

export default app;

