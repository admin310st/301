/**
 * crypto.ts
 * Шифрование и дешифрование пользовательских ключей интеграций (AES-GCM-256).
 * Работает на Edge (Cloudflare Workers, Pages Functions).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Версия мастер-ключа (используется для ротации)
const KEY_VERSION = (globalThis as any).KEY_VERSION || "v1";

// --- Получение мастер-ключа из секрета Workers
async function getMasterKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  // хэшируем секрет, чтобы привести к 32 байтам
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Шифрование данных
 * @param data объект или строка для шифрования
 * @param masterSecret строка MASTER_SECRET из env
 * @returns { iv, ct, tag?, ver }
 */
export async function encrypt(
  data: unknown,
  masterSecret: string
): Promise<{ iv: string; ct: string; ver: string }> {
  const plaintext =
    typeof data === "string" ? data : JSON.stringify(data);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getMasterKey(masterSecret);
  const encoded = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    ver: KEY_VERSION,
  };
}

/**
 * Дешифрование данных
 * @param payload объект с полями iv, ct, ver
 * @param masterSecret строка MASTER_SECRET из env
 */
export async function decrypt<T = unknown>(
  payload: { iv: string; ct: string; ver?: string },
  masterSecret: string
): Promise<T> {
  // --- учёт версии шифрования ---
  if (!payload.ver) {
    console.warn(
      "[crypto.decrypt] Missing encryption version, assuming v1 (current=%s)",
      KEY_VERSION
    );
  } else if (payload.ver !== KEY_VERSION) {
    console.warn(
      "[crypto.decrypt] Version mismatch: encrypted=%s, expected=%s",
      payload.ver,
      KEY_VERSION
    );
    // здесь можно будет добавить миграцию/особую обработку для старых версий
  }

  const ivBytes = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(payload.ct), (c) => c.charCodeAt(0));

  const key = await getMasterKey(masterSecret);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    ctBytes
  );

  const text = decoder.decode(decrypted);
  try {
    return JSON.parse(text);
  } catch {
    return text as unknown as T;
  }
}

