// src/api/auth/me.ts
/**
 * Production endpoint: GET /auth/me
 * Проверка текущего пользователя по JWT access token.
 * - Rate limiting (по IP)
 * - Проверка JWT через lib/jwt.verifyJWT()
 * - Получение пользователя из D1
 * - Аудит запроса (event_type = 'refresh')
 */

import type { Context } from 'hono'
import { refreshGuard } from '../lib/ratelimit'
import { verifyJWT } from '../lib/jwt'
import { logAuth } from '../lib/logger'

export async function me(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env
    const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
    const ua = c.req.header('User-Agent') || 'unknown'

    const blocked = await refreshGuard(c)
    if (blocked) return blocked

    const authHeader = c.req.header('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'missing_token' }, 401)
    }
    const token = authHeader.split(' ')[1]

    const payload = await verifyJWT(token, env)
    if (!payload) {
      await logAuth(env, 'revoke', 0, undefined, ip, ua)
      return c.json({ error: 'invalid_token' }, 401)
    }

    const user_id = payload.user_id
    const account_id = payload.account_id

    const user = await env.DB301
      .prepare('SELECT email, name, role FROM users WHERE id=?')
      .bind(user_id)
      .first()

    if (!user) {
      return c.json({ error: 'user_not_found' }, 404)
    }

    const account = await env.DB301
      .prepare('SELECT status FROM accounts WHERE id=? LIMIT 1')
      .bind(account_id)
      .first()

    if (account && account.status !== 'active') {
      return c.json({ error: 'account_inactive' }, 403)
    }

    await logAuth(env, 'refresh', user_id, account_id ?? undefined, ip, ua)

    return c.json(
      {
        user: {
          id: user_id,
          email: user.email,
          name: user.name ?? null,
          account_id,
          role: user.role ?? 'user'
        }
      },
      200
    )
  } catch (err) {
    console.error('[ME ERROR]', err)
    return c.json({ error: 'internal_error' }, 500)
  }
}
