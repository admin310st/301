/**
 * Инициация Google OAuth 2.0 flow
 *
 * Endpoints:
 * - GET /auth/google/start
 * - GET /auth/oauth/google/start
 *
 * Flow:
 * 1. Генерация state (CSRF protection)
 * 2. Сохранение state в KV (TTL 5 минут)
 * 3. Редирект на Google OAuth
 */

import { generatePKCE, storeState, buildOAuthUrl } from '../../lib/oauth'

export async function GET(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!(path.endsWith('/google/start') || path.endsWith('/oauth/google/start'))) {
    return new Response('Not Found', { status: 404 })
  }

  const client_id = env.GOOGLE_CLIENT_ID
  const redirect_base = env.OAUTH_REDIRECT_BASE
  if (!client_id || !redirect_base) {
    return new Response('OAuth misconfigured', { status: 500 })
  }

  // 1. Генерация state + PKCE
  const state = crypto.randomUUID()
  const { verifier, challenge } = await generatePKCE()

  // 2. Сохранение state в KV
  await storeState(env, 'google', state, verifier)

  // 3. Формирование redirect URL
  const redirect_uri = `${redirect_base}/auth/google/callback`
  const authUrl = buildOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth', {
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })

  return Response.redirect(authUrl, 302)
}

