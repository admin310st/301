// src/lib/jwt.ts

import { SignJWT, jwtVerify } from "jose";
import { encrypt, decrypt } from "./crypto";
import { createFingerprint, verifyFingerprint } from "./fingerprint";
import type { Env } from "../types/worker";

const ACCESS_TTL = "15m";                // TTL access_token
const ACTIVE_KEY_CACHE_KEY = "cache:jwt:active_key";
const ACTIVE_KEY_CACHE_TTL = 300;        // 5 минут
const KEY_CREATION_LOCK = "lock:jwt:key:creation";
const KEY_CREATION_LOCK_TTL = 60;        // 60 секунд

/**
 * Подписывает Access Token с использованием активного HS256-ключа
 * ИСПРАВЛЕНИЕ #4: Добавлен fingerprinting (IP + UA)
 */
export async function signJWT(
  payload: Record<string, any>,
  env: Env,
  expiresIn = ACCESS_TTL,
  fingerprint?: { ip: string; ua: string }  // ДОБАВЛЕНО: fingerprint опциональный
): Promise<string> {
  const keyRow = await ensureActiveKey(env);
  if (!keyRow) throw new Error("Failed to get or create active JWT key");

  const encryptedData = JSON.parse(keyRow.secret_encrypted as string);
  const jwtSecret = await decrypt<string>(encryptedData, env.MASTER_SECRET);

  const key = new TextEncoder().encode(jwtSecret);

  // ИСПРАВЛЕНИЕ #4: Добавляем fingerprint в payload если передан
  if (fingerprint) {
    const fp = await createFingerprint(fingerprint.ip, fingerprint.ua);
    payload.fp = fp;
  }

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", kid: keyRow.kid as string })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Проверяет и декодирует JWT
 * ИСПРАВЛЕНИЕ #4: Добавлена проверка fingerprint
 */
export async function verifyJWT<T = any>(
  token: string,
  env: Env,
  fingerprint?: { ip: string; ua: string }  // ДОБАВЛЕНО: fingerprint для проверки
): Promise<T | null> {
  try {
    const keyRow = await ensureActiveKey(env);
    if (!keyRow) return null;

    const encryptedData = JSON.parse(keyRow.secret_encrypted as string);
    const jwtSecret = await decrypt<string>(encryptedData, env.MASTER_SECRET);
    const key = new TextEncoder().encode(jwtSecret);

    const { payload } = await jwtVerify(token, key);

    // ИСПРАВЛЕНИЕ #4: Проверка fingerprint если есть в токене
    if (payload.fp && fingerprint) {
      const valid = await verifyFingerprint(
        payload.fp as string,
        fingerprint.ip,
        fingerprint.ua
      );
      
      if (!valid) {
        console.warn('[JWT] Fingerprint mismatch - possible token theft');
        return null;
      }
    }

    return payload as T;
  } catch {
    return null;
  }
}

/**
 * Получает активный JWT ключ.
 * Если отсутствует — создаёт автоматически (Auto-Init).
 * С кэшированием в KV и защитой от гонок.
 */
async function ensureActiveKey(env: Env): Promise<any> {
  // 1) Проверяем KV-кэш
  const cached = await env.KV_SESSIONS.get(ACTIVE_KEY_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {}
  }

  // 2) Пробуем взять активный ключ из БД
  let keyRow = await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
  ).first();

  if (keyRow) {
    await env.KV_SESSIONS.put(
      ACTIVE_KEY_CACHE_KEY,
      JSON.stringify(keyRow),
      { expirationTtl: ACTIVE_KEY_CACHE_TTL }
    );
    return keyRow;
  }

  // 3) Ключ не найден → проверяем LOCK
  const lockExists = await env.KV_SESSIONS.get(KEY_CREATION_LOCK);
  if (lockExists) {
    // Ждём 1 секунду → проверяем ещё раз
    await new Promise((r) => setTimeout(r, 1000));

    keyRow = await env.DB301.prepare(
      "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
    ).first();

    if (keyRow) {
      await env.KV_SESSIONS.put(
        ACTIVE_KEY_CACHE_KEY,
        JSON.stringify(keyRow),
        { expirationTtl: ACTIVE_KEY_CACHE_TTL }
      );
      return keyRow;
    }
  }

  // 4) Ставим LOCK
  await env.KV_SESSIONS.put(KEY_CREATION_LOCK, "1", {
    expirationTtl: KEY_CREATION_LOCK_TTL,
  });

  try {
    // 5) Генерируем 256-bit секрет
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    const jwtSecret = btoa(String.fromCharCode(...randomBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // Шифруем мастер-ключом
    const encrypted = await encrypt(jwtSecret, env.MASTER_SECRET);

    // Генерируем kid
    const dateStr = new Date().toISOString().slice(0, 10);
    const kid = `v1-${dateStr}-${crypto.randomUUID().slice(0, 8)}`;

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // 6) Пишем новый ключ в БД
    await env.DB301.prepare(
      `INSERT INTO jwt_keys (kid, secret_encrypted, status, expires_at)
       VALUES (?, ?, 'active', ?)`
    )
      .bind(kid, JSON.stringify(encrypted), expiresAt.toISOString())
      .run();

    // 7) Читаем обратно
    keyRow = await env.DB301.prepare(
      "SELECT * FROM jwt_keys WHERE kid=?"
    )
      .bind(kid)
      .first();

    if (keyRow) {
      await env.KV_SESSIONS.put(
        ACTIVE_KEY_CACHE_KEY,
        JSON.stringify(keyRow),
        { expirationTtl: ACTIVE_KEY_CACHE_TTL }
      );
    }

    return keyRow;
  } catch (error: any) {
    // Гонка — кто-то создал ключ раньше
    if (error.message?.includes("UNIQUE")) {
      keyRow = await env.DB301.prepare(
        "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
      ).first();

      if (keyRow) {
        await env.KV_SESSIONS.put(
          ACTIVE_KEY_CACHE_KEY,
          JSON.stringify(keyRow),
          { expirationTtl: ACTIVE_KEY_CACHE_TTL }
        );
        return keyRow;
      }
    }

    throw new Error("Failed to create JWT key: " + error.message);
  } finally {
    // 8) Снимаем LOCK
    await env.KV_SESSIONS.delete(KEY_CREATION_LOCK);
  }
}

/** Возвращает активный JWT ключ */
export async function getActiveKey(env: Env): Promise<any> {
  return await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE status='active' LIMIT 1"
  ).first();
}

/** Возвращает ключ по kid */
export async function getKeyByKid(kid: string, env: Env): Promise<any> {
  return await env.DB301.prepare(
    "SELECT * FROM jwt_keys WHERE kid=?"
  )
    .bind(kid)
    .first();
}

/** Возвращает список ключей (JWKS) */
export async function getValidKeys(env: Env): Promise<any[]> {
  const result = await env.DB301.prepare(
    "SELECT kid, status, created_at, expires_at FROM jwt_keys WHERE status IN ('active','deprecated') ORDER BY created_at DESC"
  ).all();

  return result.results || [];
}

