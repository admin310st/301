// src/api/lib/password.ts
// Модуль шифрования паролей пользователей
// PBKDF2 + соль, формат salt:hash, без pepper

const ITERATIONS = 100_000
const KEY_LENGTH = 32 // bytes
const HASH_ALGO = "SHA-256"

const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let str = ""
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i])
  }
  return btoa(str)
}

function fromBase64(b64: string): Uint8Array {
  const str = atob(b64)
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i)
  }
  return bytes
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: HASH_ALGO,
      salt,
      iterations: ITERATIONS,
    },
    keyMaterial,
    KEY_LENGTH * 8
  )

  return new Uint8Array(bits)
}

/**
 * Хэш пароля.
 * Формат хранения в БД: "<salt_base64>:<hash_base64>"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await deriveKey(password, salt)

  const saltB64 = toBase64(salt)
  const hashB64 = toBase64(hash)

  return `${saltB64}:${hashB64}`
}

/**
 * Проверка пароля.
 */
export async function verifyPassword(
  password: string,
  stored: string | null
): Promise<boolean> {
  if (!stored) return false

  const parts = stored.split(":")
  if (parts.length !== 2) return false

  const [saltB64, hashB64] = parts
  const salt = fromBase64(saltB64)
  const expected = fromBase64(hashB64)

  const actual = await deriveKey(password, salt)

  if (actual.length !== expected.length) return false

  // простое сравнение (для Workers достаточно)
  let same = 0
  for (let i = 0; i < actual.length; i++) {
    same |= actual[i] ^ expected[i]
  }
  return same === 0
}

