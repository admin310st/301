// lib/session.ts
// Создание refresh-сессии + установка refresh-cookie
// Используется в login, verify, oauth, tg-login

export async function createRefreshSession(
  c: any,          // Hono context
  env: Env,        // Worker env с KV_SESSIONS
  userId: number,  // ID пользователя
  accountId?: number,        // ID активного аккаунта (ДОБАВЛЕНО)
  userType: string = 'client' // Тип пользователя (ДОБАВЛЕНО)
): Promise<string> {
  const refreshId = crypto.randomUUID();

  // Запоминаем в KV полный объект session
  // JSON объект с user_id, account_id, user_type
  await env.KV_SESSIONS.put(
    `refresh:${refreshId}`,
    JSON.stringify({
      user_id: userId,
      account_id: accountId ?? null,
      user_type: userType
    }),
    {
      expirationTtl: 60 * 60 * 24 * 7 // 7 дней
    }
  );

  // Устанавливаем refresh-cookie в ответ пользователю
  c.header(
    "Set-Cookie",
    `refresh_id=${refreshId}; HttpOnly; Secure; SameSite=Strict; Path=/`
  );

  return refreshId;
}

