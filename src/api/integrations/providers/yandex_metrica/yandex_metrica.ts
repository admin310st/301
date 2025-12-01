/**
 * yandex_metrica.ts
 * Заглушка проверки API Yandex Metrica
 */
export async function test(accountId: string, getSecret: () => Promise<Record<string, string>>) {
  const creds = await getSecret();
  console.log(`[Yandex Metrica] Testing for account ${accountId}`, creds);

  return { ok: true, details: "Mocked response: Yandex Metrica token valid" };
}

