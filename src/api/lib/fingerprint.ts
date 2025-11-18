// src/api/lib/fingerprint.ts
/**
 * JWT Fingerprinting библиотека
 * Защита от token theft через привязку к IP и User-Agent
 * 
 * Использование:
 * - При создании JWT добавляем fingerprint в payload
 * - При проверке JWT сверяем fingerprint с текущим request
 */

const encoder = new TextEncoder();

/**
 * Создание fingerprint из IP и User-Agent
 * Возвращает SHA-256 хэш в формате hex
 */
export async function createFingerprint(ip: string, ua: string): Promise<string> {
  const input = `${ip}:${ua}`;
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Проверка fingerprint
 * Сравнивает сохранённый fingerprint с текущим request
 */
export async function verifyFingerprint(
  storedFingerprint: string,
  currentIp: string,
  currentUa: string
): Promise<boolean> {
  const currentFingerprint = await createFingerprint(currentIp, currentUa);
  return storedFingerprint === currentFingerprint;
}

/**
 * Извлечение IP и UA из Hono request
 * Helper для консистентного извлечения в разных endpoints
 */
export function extractRequestInfo(c: any): { ip: string; ua: string } {
  const ip = 
    c.req.header('CF-Connecting-IP') || 
    c.req.header('x-real-ip') || 
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0';
  
  const ua = c.req.header('User-Agent') || 'unknown';
  
  return { ip, ua };
}
