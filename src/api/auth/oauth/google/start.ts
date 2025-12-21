/**
 * Endpoint:
 *   GET /auth/oauth/google/start?redirect_host=app.301.st
 *
 * Flow:
 * 1. Получение и валидация redirect_host из query
 * 2. Генерация state (CSRF protection)
 * 3. Генерация PKCE (verifier + challenge)
 * 4. Сохранение verifier + redirect_host в KV
 * 5. Формирование URL авторизации Google и редирект пользователя
 */

import { Hono } from "hono";
import { 
  generatePKCE, 
  storeState, 
  buildOAuthUrl, 
  validateRedirectHost 
} from "../../../lib/oauth";

const app = new Hono();

app.get("/", async (c) => {
  const client_id = c.env.GOOGLE_CLIENT_ID;
  const redirect_base = c.env.OAUTH_REDIRECT_BASE || "https://api.301.st";

  if (!client_id) {
    return c.text("OAuth misconfigured: missing GOOGLE_CLIENT_ID", 500);
  }

  // 1. Получение и валидация redirect_host
  const rawRedirectHost = c.req.query("redirect_host");
  const redirectHost = validateRedirectHost(rawRedirectHost);

  // 2. Генерация state (CSRF protection)
  const state = crypto.randomUUID();

  // 3. Генерация PKCE параметров
  const { verifier, challenge } = await generatePKCE();

  // 4. Сохранение verifier + redirect_host в KV
  await storeState(c.env, "google", state, verifier, redirectHost);

  // 5. Формирование redirect URL
  const redirect_uri = `${redirect_base}/auth/oauth/google/callback`;
  const authUrl = buildOAuthUrl("https://accounts.google.com/o/oauth2/v2/auth", {
    client_id,
    redirect_uri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return Response.redirect(authUrl, 302);
});

export default app;

