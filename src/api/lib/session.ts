// lib/session.ts
// Создание refresh-сессии + установка refresh-cookie
// Используется в login, verify, oauth, tg-login

export async function createRefreshSession(
  c: any,          // Hono context
  env: Env,        // Worker env с KV_SESSIONS
  userId: number   // ID пользователя
): Promise<string> {
  const refreshId = crypto.randomUUID();

  // Запоминаем в KV пользователя, которому принадлежит refresh-токен
  await env.KV_SESSIONS.put(
    `refresh:${refreshId}`,
    String(userId),
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

