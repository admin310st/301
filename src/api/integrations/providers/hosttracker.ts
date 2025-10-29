/**
 * hosttracker.ts
 * Заглушка проверки API HostTracker
 */
export async function test(accountId: string, getSecret: () => Promise<Record<string, string>>) {
  const creds = await getSecret();
  console.log(`[HostTracker] Testing for account ${accountId}`, creds);

  return { ok: true, details: "Mocked response: HostTracker API reachable" };
}

