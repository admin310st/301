// src/api/auth/refresh.ts
/**
 * Production endpoint: POST /auth/refresh
 * Обновление access-токена по refresh_id (из cookie).
 * Использует rateLimit, KV, JWT и audit_log.
 */

import type { Context } from 'hono'
import { signJWT } from '../lib/jwt'
import { logAuth } from '../lib/logger'
import { refreshGuard } from '../lib/ratelimit'

export async function refresh(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env
    const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
    const ua = c.req.header('User-Agent') || 'unknown'

    const blocked = await refreshGuard(c)
    if (blocked) return blocked

    const cookieHeader = c.req.header('Cookie') || ''
    const refreshMatch = cookieHeader.match(/refresh_id=([^;]+)/)
    if (!refreshMatch) {
      return c.json({ error: 'missing_refresh_cookie' }, 401)
    }
    const refresh_id = refreshMatch[1]

    const userIdStr = await env.KV_SESSIONS.get(`refresh:${refresh_id}`)
    if (!userIdStr) {
      await logAuth(env, 'revoke', 0, undefined, ip, ua)
      return c.json({ error: 'invalid_refresh' }, 401)
    }
    const user_id = Number(userIdStr)

    const user = await env.DB301
      .prepare('SELECT email, role FROM users WHERE id=?')
      .bind(user_id)
      .first()

    if (!user) {
      await env.KV_SESSIONS.delete(`refresh:${refresh_id}`)
      return c.json({ error: 'user_not_found' }, 401)
    }

    const account = await env.DB301
      .prepare('SELECT id FROM accounts WHERE user_id=? AND status=\"active\" LIMIT 1')
      .bind(user_id)
      .first()
    const account_id = account ? Number(account.id) : null

    const access_token = await signJWT(
      {
        user_id,
        account_id,
        role: user.role ?? 'user'
      },
      env
    )

    const new_refresh_id = crypto.randomUUID()
    await env.KV_SESSIONS.put(`refresh:${new_refresh_id}`, String(user_id), {
      expirationTtl: 60 * 60 * 24 * 7
    })
    await env.KV_SESSIONS.delete(`refresh:${refresh_id}`)

    const cookie = `refresh_id=${new_refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
    c.header('Set-Cookie', cookie)

    await logAuth(env, 'refresh', user_id, account_id ?? undefined, ip, ua)

    return c.json(
      {
        access_token,
        user: {
          id: user_id,
          email: user.email,
          account_id,
          role: user.role ?? 'user'
        }
      },
      200
    )
  } catch (err) {
    console.error('[REFRESH ERROR]', err)
    return c.json({ error: 'internal_error' }, 500)
  }
}
