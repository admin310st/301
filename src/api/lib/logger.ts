// src/api/lib/logger.ts
import type { Env } from '../types/worker'

/**
 * logEvent()
 * Централизованная запись событий в таблицу audit_log (D1)
 * Работает на Edge, не требует Node.js API.
 *
 * @param env - окружение воркера (содержит DB301)
 * @param data - объект события
 */
export async function logEvent(
  env: Env,
  data: {
    account_id?: number
    user_id?: number
    event_type:
      | 'register'
      | 'login'
      | 'logout'
      | 'refresh'
      | 'create'
      | 'update'
      | 'delete'
      | 'deploy'
      | 'revoke'
      | 'billing'
    ip?: string
    ua?: string
    role?: string
    details?: Record<string, any>
  }
): Promise<void> {
  try {
    await env.DB301.prepare(
      `INSERT INTO audit_log 
       (account_id, user_id, event_type, ip_address, user_agent, details, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        data.account_id ?? null,
        data.user_id ?? null,
        data.event_type,
        data.ip ?? null,
        data.ua ?? null,
        JSON.stringify(data.details ?? {}),
        data.role ?? null
      )
      .run()
  } catch (err) {
    console.error('Audit log error:', err)
  }
}

/**
 * logAuth()
 * Упрощённая обёртка для auth-событий (register/login/logout/refresh)
 */
export async function logAuth(
  env: Env,
  event_type: 'register' | 'login' | 'logout' | 'refresh',
  user_id: number,
  account_id?: number,
  ip?: string,
  ua?: string
): Promise<void> {
  await logEvent(env, {
    account_id,
    user_id,
    event_type,
    ip,
    ua,
    role: 'user'
  })
}

