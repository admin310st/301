// src/api/auth/login.ts
/**
 * Production endpoint: POST /auth/login
 * Авторизация пользователя по email и паролю.
 * Включает rate-limit (IP + email), JWT, KV-сессии и аудит.
 */

import type { Context } from 'hono'
import { compare } from 'bcrypt-ts'
import { signJWT } from '../lib/jwt'
import { logAuth } from '../lib/logger'
import { loginGuard } from '../lib/ratelimit'
import { z } from 'zod'

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
})

export async function login(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env
    const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
    const ua = c.req.header('User-Agent') || 'unknown'

    const body = await c.req.json()
    const parsed = LoginSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400)
    }
    const { email, password } = parsed.data

    const blocked = await loginGuard(c, email)
    if (blocked) return blocked

    const user = await env.DB301
      .prepare('SELECT id, password_hash, role FROM users WHERE email=?')
      .bind(email)
      .first()

    if (!user) {
      await logAuth(env, 'revoke', 0, undefined, ip, ua)
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    const valid = await compare(password, user.password_hash)
    if (!valid) {
      await logAuth(env, 'revoke', user.id, undefined, ip, ua)
      return c.json({ error: 'invalid_credentials' }, 401)
    }

    const user_id = Number(user.id)

    const account = await env.DB301
      .prepare('SELECT id FROM accounts WHERE user_id=? AND status="active" LIMIT 1')
      .bind(user_id)
      .first()
    const account_id = account ? Number(account.id) : null

    const refresh_id = crypto.randomUUID()
    await env.KV_SESSIONS.put(`refresh:${refresh_id}`, String(user_id), {
      expirationTtl: 60 * 60 * 24 * 7
    })

    const access_token = await signJWT(
      {
        user_id,
        account_id,
        role: user.role || 'user'
      },
      env
    )

    const cookie = `refresh_id=${refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
    c.header('Set-Cookie', cookie)

    await logAuth(env, 'login', user_id, account_id ?? undefined, ip, ua)

    return c.json(
      {
        access_token,
        user: {
          id: user_id,
          email,
          account_id,
          role: user.role || 'user'
        }
      },
      200
    )
  } catch (err) {
    console.error('[LOGIN ERROR]', err)
    return c.json({ error: 'internal_error' }, 500)
  }
}
