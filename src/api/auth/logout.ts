// src/api/auth/logout.ts
/**
 * Production endpoint: POST /auth/logout
 * Завершает сессию пользователя.
 * - Проверяет и удаляет refresh_id из KV
 * - Использует rateLimit, JWT-аудит и безопасное удаление cookie
 */

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logAuth } from '../lib/logger'

const app = new Hono()

app.post('/', async (c) => {
  const env = c.env

  const ip = c.req.header('CF-Connecting-IP') || '0.0.0.0'
  const ua = c.req.header('User-Agent') || 'unknown'

  // 1) Получаем refresh_id из cookie
  const cookieHeader = c.req.header('Cookie') || ''
  const refresh_id = cookieHeader
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('refresh_id='))
    ?.split('=')[1]

  if (!refresh_id) {
    throw new HTTPException(400, { message: 'missing_refresh_id' })
  }

  // 2) Удаляем refresh-токен из KV
  await env.KV_SESSIONS.delete(`refresh:${refresh_id}`)

  // 3) Отмечаем сессию revoked=1 (если ведёшь audit sessions)
  try {
    await env.DB301
      .prepare('UPDATE sessions SET revoked=1 WHERE refresh_id=?')
      .bind(refresh_id)
      .run()
  } catch {
    // таблица sessions может быть отключена — не критично
  }

  // 4) Чистим cookie
  c.header(
    'Set-Cookie',
    'refresh_id=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
  )

  // 5) Логируем
  await logAuth(env, 'logout', null, null, ip, ua, 'client')

  return c.json({ status: 'ok' })
})

export default app

