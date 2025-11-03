// src/api/auth/logout.ts
/**
 * Production endpoint: POST /auth/logout
 * Завершает сессию пользователя.
 * - Проверяет и удаляет refresh_id из KV
 * - Использует rateLimit, JWT-аудит и безопасное удаление cookie
 */

import type { Context } from 'hono'
import { refreshGuard } from '../lib/ratelimit'
import { logAuth } from '../lib/logger'

export async function logout(c: Context<{ Bindings: Env }>) {
  try {
    const env = c.env
    const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
    const ua = c.req.header('User-Agent') || 'unknown'

    // --- 1. Проверка лимита по IP ---
    const blocked = await refreshGuard(c)
    if (blocked) return blocked

    // --- 2. Извлечение refresh_id из cookie ---
    const cookieHeader = c.req.header('Cookie') || ''
    const refreshMatch = cookieHeader.match(/refresh_id=([^;]+)/)
    if (!refreshMatch) {
      return c.json({ error: 'missing_refresh_cookie' }, 400)
    }
    const refresh_id = refreshMatch[1]

    // --- 3. Проверка refresh_id в KV ---
    const userIdStr = await env.KV_SESSIONS.get(`refresh:${refresh_id}`)
    if (!userIdStr) {
      return c.json({ error: 'invalid_refresh' }, 400)
    }
    const user_id = Number(userIdStr)

    // --- 4. Удаление refresh-токена из KV ---
    await env.KV_SESSIONS.delete(`refresh:${refresh_id}`)

    // --- 5. Получаем account_id (если есть) ---
    const account = await env.DB301
      .prepare('SELECT id FROM accounts WHERE user_id=? AND status="active" LIMIT 1')
      .bind(user_id)
      .first()
    const account_id = account ? Number(account.id) : null

    // --- 6. Аудит выхода ---
    await logAuth(env, 'logout', user_id, account_id ?? undefined, ip, ua)

    // --- 7. Удаление cookie (Set-Cookie c истёкшим временем) ---
    const cookie = `refresh_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
    c.header('Set-Cookie', cookie)

    // --- 8. Ответ клиенту ---
    return c.json({ success: true, message: 'Logged out successfully.' }, 200)
  } catch (err) {
    console.error('[LOGOUT ERROR]', err)
    return c.json({ error: 'internal_error' }, 500)
  }
}

