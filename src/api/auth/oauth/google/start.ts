/**
 * Инициация Google OAuth 2.0 flow
 *
 * Endpoint:
 * - GET /auth/oauth/google/start
 *
 * Flow:
 * 1. Генерация state (CSRF protection)
 * 2. Сохранение state в KV (TTL 5 минут)
 * 3. Редирект на Google OAuth
 */

import { Hono } from "hono";
import { generatePKCE, storeState, buildOAuthUrl } from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GOOGLE_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GOOGLE_CLIENT_ID", 500);
  }

  // 1. Генерация state + PKCE
  const state = crypto.randomUUID();
  const { verifier, challenge } = await generatePKCE();

  // 2. Сохранение state в KV
  await storeState(c.env, 'google', state, verifier);

  // 3. Формирование redirect URL
  const redirect_uri = `${redirect_base}/auth/oauth/google/callback`;
  const authUrl = buildOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth', {
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  return Response.redirect(authUrl, 302);
});

export default app;

