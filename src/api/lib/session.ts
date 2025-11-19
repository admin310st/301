// lib/session.ts
/**
 * Создание refresh-сессии + установка refresh-cookie
 * Используется в login, verify, oauth, tg-login
 * 
 * Сохраняет IP и User-Agent для защиты от session hijacking.
 * При refresh оба параметра проверяются строго.
 */

export async function createRefreshSession(
  c: any,          // Hono context
  env: Env,        // Worker env с KV_SESSIONS
  userId: number,  // ID пользователя
  accountId?: number,        // ID активного аккаунта
  userType: string = 'client' // Тип пользователя
): Promise<string> {
  const refreshId = crypto.randomUUID();

  // Извлекаем IP и User-Agent
  const ip = 
    c.req.header('CF-Connecting-IP') || 
    c.req.header('x-real-ip') || 
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0';
  
  const ua = c.req.header('User-Agent') || 'unknown';

  // Запоминаем в KV полный объект session с IP и UA
  await env.KV_SESSIONS.put(
    `refresh:${refreshId}`,
    JSON.stringify({
      user_id: userId,
      account_id: accountId ?? null,
      user_type: userType,
      ip: ip,                          
      ua: ua,                         
      created_at: Date.now()         
    }),
    {
      expirationTtl: 60 * 60 * 24 * 7 // 7 дней
    }
  );

  // Устанавливаем refresh-cookie в ответ пользователю
  c.header(
    "Set-Cookie",
    `refresh_id=${refreshId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
  );

  return refreshId;
}
