/**
 * Обработка Google OAuth callback
 *
 * Endpoints:
 * - GET /auth/google/callback
 * - GET /auth/oauth/google/callback
 *
 * Flow:
 * 1. Валидация state
 * 2. Обмен code → tokens
 * 3. Декодирование id_token
 * 4. Создание/обновление пользователя
 * 5. Создание сессии
 * 6. Генерация JWT
 * 7. Редирект на фронтенд
 */

import { consumeState, exchangeToken, successRedirect } from '../../lib/oauth'
import { signJWT } from '../../../../lib/jwt'

export async function GET(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!(path.endsWith('/google/callback') || path.endsWith('/oauth/google/callback'))) {
    return new Response('Not Found', { status: 404 })
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    return new Response('Invalid OAuth callback', { status: 400 })
  }

  // 1. Проверка и удаление state из KV
  const code_verifier = await consumeState(env, 'google', state)
  if (!code_verifier) {
    return new Response('Invalid or expired state', { status: 400 })
  }

  // 2. Обмен code → tokens
  const tokens = await exchangeToken('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${env.OAUTH_REDIRECT_BASE}/auth/google/callback`,
    grant_type: 'authorization_code',
    code,
    code_verifier
  }))

  if (!tokens || !tokens.id_token) {
    return new Response('Token exchange failed', { status: 400 })
  }

  // 3. Декодирование id_token
  const [, payloadB64] = tokens.id_token.split('.')
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
  const email = payload.email
  const name = payload.name || email.split('@')[0]

  // 4. Создание или обновление пользователя
  let user = await env.DB301.prepare('SELECT id FROM users WHERE email=?').bind(email).first()
  if (!user) {
    const insert = await env.DB301
      .prepare('INSERT INTO users (email, name, google_sub, role) VALUES (?, ?, ?, ?)')
      .bind(email, name, payload.sub, 'user')
      .run()
    user = { id: insert.meta.last_row_id }
    await env.DB301
      .prepare('INSERT INTO accounts (user_id, account_name, plan, status) VALUES (?, ?, ?, ?)')
      .bind(user.id, name, 'free', 'active')
      .run()
  }

  const user_id = Number(user.id)
  const acc = await env.DB301
    .prepare('SELECT id FROM accounts WHERE user_id=? AND status="active" LIMIT 1')
    .bind(user_id)
    .first()
  const account_id = acc ? Number(acc.id) : null

  // 5. Создание refresh_id и сохранение в KV
  const refresh_id = crypto.randomUUID()
  await env.KV_SESSIONS.put(`refresh:${refresh_id}`, String(user_id), { expirationTtl: 60 * 60 * 24 * 7 })

  // 6. Генерация JWT
  const access_token = await signJWT({ user_id, account_id, role: 'user' }, env)
  const cookie = `refresh_id=${refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`

  // 7. Редирект на фронтенд
  const frontendBase = `${env.OAUTH_REDIRECT_BASE}/login/success`
  const redirectResp = successRedirect(frontendBase, access_token)
  redirectResp.headers.append('Set-Cookie', cookie)

  return redirectResp
}

