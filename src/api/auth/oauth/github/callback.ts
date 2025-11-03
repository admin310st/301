/**
 * Обработка GitHub OAuth callback
 *
 * Отличия от Google:
 * - Нет id_token, требуется запрос к /user API
 * - Email может быть private → запрос к /user/emails
 * - Использует access_token для всех запросов
 */

import { consumeState, exchangeToken, successRedirect } from '../../lib/oauth'
import { signJWT } from '../../../../lib/jwt'

export async function GET(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!(path.endsWith('/github/callback') || path.endsWith('/oauth/github/callback'))) {
    return new Response('Not Found', { status: 404 })
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return new Response('Invalid callback params', { status: 400 })

  // 1. Проверка state
  const code_verifier = await consumeState(env, 'github', state)
  if (!code_verifier) return new Response('Invalid or expired state', { status: 400 })

  // 2. Обмен кода на access_token
  const tokens = await exchangeToken('https://github.com/login/oauth/access_token', new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: `${env.OAUTH_REDIRECT_BASE}/auth/github/callback`,
    code_verifier
  }))
  const accessToken = tokens?.access_token
  if (!accessToken) return new Response('GitHub token exchange failed', { status: 400 })

  // 3. Получаем данные пользователя
  const userResp = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': '301.st' }
  })
  if (!userResp.ok) return new Response('GitHub user fetch failed', { status: 400 })
  const userinfo = await userResp.json() as { id: number; login: string; name?: string; email?: string }

  // 4. Email fallback
  let email = userinfo.email
  if (!email) {
    const emailResp = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': '301.st' }
    })
    if (emailResp.ok) {
      const emails = await emailResp.json() as Array<{ email: string; primary: boolean; verified: boolean }>
      const primary = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0]
      email = primary?.email
    }
  }
  if (!email) email = `${userinfo.login || userinfo.id}@users.noreply.github.com`

  // 5. Создаём/находим пользователя в D1
  let user = await env.DB301.prepare('SELECT id FROM users WHERE email=?').bind(email).first()
  if (!user) {
    const name = userinfo.name ?? userinfo.login
    const insert = await env.DB301
      .prepare('INSERT INTO users (email, name, role, user_type) VALUES (?, ?, ?, ?)')
      .bind(email, name ?? null, 'user', 'client')
      .run()
    user = { id: insert.meta.last_row_id }
    await env.DB301
      .prepare('INSERT INTO accounts (user_id, account_name, plan, status) VALUES (?, ?, ?, ?)')
      .bind(user.id, name ?? email.split('@')[0], 'free', 'active')
      .run()
  }

  const user_id = Number(user.id)
  const acc = await env.DB301
    .prepare('SELECT id FROM accounts WHERE user_id=? AND status="active" LIMIT 1')
    .bind(user_id)
    .first()
  const account_id = acc ? Number(acc.id) : null

  // 6. Создаём refresh_id + JWT
  const refresh_id = crypto.randomUUID()
  await env.KV_SESSIONS.put(`refresh:${refresh_id}`, String(user_id), { expirationTtl: 60 * 60 * 24 * 7 })

  const jwt = await signJWT({ user_id, account_id, role: 'user' }, env)
  const cookie = `refresh_id=${refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`

  // 7. Редирект на фронтенд
  const frontendBase = `${env.OAUTH_REDIRECT_BASE}/login/success`
  const redirectResp = successRedirect(frontendBase, jwt)
  redirectResp.headers.append('Set-Cookie', cookie)
  return redirectResp
}

