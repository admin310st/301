// src/lib/jwt.ts
import { SignJWT, jwtVerify } from "jose";
import { encrypt, decrypt } from "./crypto";

const ACCESS_TTL = "15m";                // TTL токена
const ACTIVE_KEY_CACHE_KEY = "cache:jwt:active_key";
const ACTIVE_KEY_CACHE_TTL = 300;        // 5 минут кэш
const KEY_CREATION_LOCK = "lock:jwt:key:creation";
const KEY_CREATION_LOCK_TTL = 60;        // 60 секунд блокировка

/**
 * Подписывает access_token с kid (HS256)
 */
export async function signJWT(
  payload: Record<string, any>,
  env: Env,
  expiresIn = ACCESS_TTL
): Promise<string> {
  const keyRow = await ensureActiveKey(env);
  if (!keyRow) throw new Error("Failed to get or create active JWT key");

  const encryptedData = JSON.parse(keyRow.secret_encrypted as string);
  const jwtSecret = await decrypt<string>(encryptedData, env.MASTER_SECRET);
  const key = new TextEncoder().encode(jwtSecret);

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", kid: keyRow.kid as string })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Проверяет и декодирует JWT
 */
export async function verifyJWT<T = any>(
  token: string,
  env: Env
): Promise<T | null> {
  try {
    // Получаем активный ключ (из кэша или БД)
    const keyRow = await ensureActiveKey(env);
    if (!keyRow) return null;

    // Расшифровываем секрет
    const encryptedData = JSON.parse(keyRow.secret_encrypted as string);
    const jwtSecret = await decrypt<string>(encryptedData, env.MASTER_SECRET);
    const key = new TextEncoder().encode(jwtSecret);

    // jwtVerify СНАЧАЛА проверяет подпись, ПОТОМ возвращает payload
    // Автоматически проверяет: signature, exp, nbf, iat
    const { payload } = await jwtVerify(token, key);

    // Токен валиден!
    return payload as T;
  } catch {
    // Любая ошибка (невалидная подпись, истекший токен, etc.) → null
    return null;
  }
}

/**
 * Получает активный JWT ключ, создаёт если отсутствует (auto-init)
 * С кэшированием в KV на 5 минут
 */
async function ensureActiveKey(env: Env): Promise<any> {
  //  Проверяем кэш
  const cached = await env.KV_SESSIONS.get(ACTIVE_KEY_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch { /* ignore invalid JSON */ }
  }

  //  Проверяем наличие активного ключа в БД
  let keyRow = await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
  ).first();

  if (keyRow) {
    // Ключ найден, кэшируем и возвращаем
    await env.KV_SESSIONS.put(ACTIVE_KEY_CACHE_KEY, JSON.stringify(keyRow), {
      expirationTtl: ACTIVE_KEY_CACHE_TTL,
    });
    return keyRow;
  }

  //  Ключа нет, нужно создать
  // Проверяем, не создаёт ли его кто-то параллельно
  const lockExists = await env.KV_SESSIONS.get(KEY_CREATION_LOCK);
  if (lockExists) {
    // Кто-то уже создаёт ключ, ждём 1 секунду и проверяем снова
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Рекурсивный вызов с проверкой (максимум 3 попытки)
    keyRow = await env.DB301.prepare(
      "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
    ).first();
    
    if (keyRow) {
      await env.KV_SESSIONS.put(ACTIVE_KEY_CACHE_KEY, JSON.stringify(keyRow), {
        expirationTtl: ACTIVE_KEY_CACHE_TTL,
      });
      return keyRow;
    }
    
    // Если после ожидания всё равно нет ключа - продолжаем создание
  }

  //  Устанавливаем блокировку
  await env.KV_SESSIONS.put(KEY_CREATION_LOCK, '1', { 
    expirationTtl: KEY_CREATION_LOCK_TTL 
  });

  try {
    //  Генерируем новый JWT secret (256 бит = 32 байта)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const jwtSecret = btoa(String.fromCharCode(...randomBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Шифруем secret
    const encrypted = await encrypt(jwtSecret, env.MASTER_SECRET);

    //  Генерируем kid с unique suffix
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const randomSuffix = crypto.randomUUID().slice(0, 8);   // первые 8 символов UUID
    const kid = `v1-${dateStr}-${randomSuffix}`;

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1); // Действует 1 год

    //  Сохраняем в БД
    await env.DB301.prepare(
      `INSERT INTO jwt_keys (kid, secret_encrypted, status, expires_at) 
       VALUES (?, ?, 'active', ?)`
    ).bind(kid, JSON.stringify(encrypted), expiresAt.toISOString()).run();
    
    console.log(`✅ Created JWT key: ${kid}`);

    //  Читаем созданный ключ из БД
    keyRow = await env.DB301
      .prepare("SELECT * FROM jwt_keys WHERE kid=?")
      .bind(kid)
      .first();

    if (keyRow) {
      // Кэшируем для будущих запросов
      await env.KV_SESSIONS.put(ACTIVE_KEY_CACHE_KEY, JSON.stringify(keyRow), {
        expirationTtl: ACTIVE_KEY_CACHE_TTL,
      });
    }

    return keyRow;

  } catch (error: any) {
    // Обработка конфликта (кто-то успел создать раньше)
    if (error.message?.includes("UNIQUE constraint failed")) {
      console.log(' Key already exists (race condition), fetching...');
      
      keyRow = await env.DB301.prepare(
        "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
      ).first();
      
      if (keyRow) {
        await env.KV_SESSIONS.put(ACTIVE_KEY_CACHE_KEY, JSON.stringify(keyRow), {
          expirationTtl: ACTIVE_KEY_CACHE_TTL,
        });
        return keyRow;
      }
    }
    
    throw new Error(`Failed to create JWT key: ${error.message}`);
    
  } finally {
    //  Всегда снимаем блокировку
    await env.KV_SESSIONS.delete(KEY_CREATION_LOCK);
  }
}

/** Возвращает активный ключ */
export async function getActiveKey(env: Env): Promise<any> {
  return await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
  ).first();
}

/** Возвращает ключ по kid */
export async function getKeyByKid(kid: string, env: Env): Promise<any> {
  return await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE kid=?"
  ).bind(kid).first();
}

/** Возвращает список действующих ключей (JWKS) */
export async function getValidKeys(env: Env): Promise<any[]> {
  const result = await env.DB301.prepare(
    "SELECT kid, status, created_at, expires_at FROM jwt_keys WHERE status IN ('active', 'deprecated') ORDER BY created_at DESC"
  ).all();
  return result.results || [];
}
