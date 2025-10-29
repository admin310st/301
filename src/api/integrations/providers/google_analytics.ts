/**
 * google_analytics.ts
 * Заглушка проверки API Google Analytics
 */
export async function test(accountId: string, getSecret: () => Promise<Record<string, string>>) {
  const creds = await getSecret();
  console.log(`[Google Analytics] Testing for account ${accountId}`, creds);

  return { ok: true, details: "Mocked response: Google Analytics token valid" };
}

