// src/api/lib/logger.ts

// Централизованный логгер событий.

import type { Env } from '../types/worker'

// Базовый логгер событий (insert в audit_log)
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
    user_type?: string
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
        JSON.stringify(data.details ?? {}), //  для расширений
        data.user_type ?? null
      )
      .run()
  } catch (err) {
    console.error('[AUDIT_LOG ERROR]', err)
  }
}

// Логгер событий авторизации.
 
export async function logAuth(
  env: Env,
  event_type: 'register' | 'login' | 'logout' | 'refresh',
  user_id: number,
  account_id?: number,
  ip?: string,
  ua?: string,
  user_type: 'admin' | 'client' = 'client',
  account_role: 'owner' | 'editor' | 'viewer' | 'none' = 'none'
): Promise<void> {
  const combined = `${user_type}:${account_role}`

  try {
    await logEvent(env, {
      account_id,
      user_id,
      event_type,
      ip,
      ua,
      user_type: combined,
      details: {}            // для будущих расширений
    })
  } catch (err) {
    console.error('[AUTH_LOG_WRAPPER ERROR]', err)
  }
}

