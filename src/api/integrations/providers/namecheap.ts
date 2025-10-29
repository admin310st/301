/**
 * namecheap.ts
 * Заглушка тестового вызова для API Namecheap
 */
export async function test(accountId: string, getSecret: () => Promise<Record<string, string>>) {
  const creds = await getSecret();
  console.log(`[Namecheap] Testing for account ${accountId}`, creds);

  // Имитируем успешный отклик от API Namecheap
  return { ok: true, details: "Mocked response: Namecheap API reachable" };
}

