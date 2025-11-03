// src/api/auth/register.ts
/**
 * Production endpoint: POST /auth/register
 * Регистрация нового пользователя.
 * Безопасная реализация с rate limiting, Turnstile, D1, JWT и audit_log.
 */

import type { Context } from 'hono'
import { hash } from 'bcrypt-ts'
import { signJWT } from '../lib/jwt'
import { logAuth } from '../lib/logger'
import { registerGuard } from '../lib/ratelimit'
import { z } from 'zod'

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  turnstile_token: z.string().optional()
})

export async function register(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env
    const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
    const ua = c.req.header('User-Agent') || 'unknown'

    const body = await c.req.json()
    const parsed = RegisterSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400)
    }
    const { email, password, name, turnstile_token } = parsed.data

    const blocked = await registerGuard(c, email)
    if (blocked) return blocked

    if (env.TURNSTILE_SECRET && turnstile_token) {
      const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: turnstile_token,
          remoteip: ip
        })
      }).then(r => r.json())

      if (!verify.success) {
        await logAuth(env, 'revoke', 0, undefined, ip, ua)
        return c.json({ error: 'turnstile_failed' }, 403)
      }
    }

    const exists = await env.DB301
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first()
    if (exists) {
      return c.json({ error: 'email_exists' }, 409)
    }

    const password_hash = await hash(password, 10)
    const userInsert = await env.DB301
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .bind(email, password_hash, name ?? null)
      .run()
    const user_id = userInsert.meta.last_row_id

    const account_name = name || email.split('@')[0]
    const accountInsert = await env.DB301
      .prepare('INSERT INTO accounts (user_id, account_name, plan, status) VALUES (?, ?, ?, ?)')
      .bind(user_id, account_name, 'free', 'active')
      .run()
    const account_id = accountInsert.meta.last_row_id

    const refresh_id = crypto.randomUUID()
    await env.KV_SESSIONS.put(`refresh:${refresh_id}`, String(user_id), {
      expirationTtl: 60 * 60 * 24 * 7
    })

    const access_token = await signJWT(
      {
        user_id,
        account_id,
        role: 'user'
      },
      env
    )

    const cookie = `refresh_id=${refresh_id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
    c.header('Set-Cookie', cookie)

    await logAuth(env, 'register', user_id, account_id, ip, ua)

    return c.json(
      {
        access_token,
        user: {
          id: user_id,
          email,
          name: name ?? null,
          account_id,
          role: 'user'
        }
      },
      201
    )
  } catch (err) {
    console.error('[REGISTER ERROR]', err)
    return c.json({ error: 'internal_error' }, 500)
  }
}
