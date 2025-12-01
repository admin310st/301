/**
 * namesilo.ts
 * Заглушка проверки API NameSilo
 */
export async function test(accountId: string, getSecret: () => Promise<Record<string, string>>) {
  const creds = await getSecret();
  console.log(`[NameSilo] Testing for account ${accountId}`, creds);

  return { ok: true, details: "Mocked response: NameSilo API reachable" };
}

