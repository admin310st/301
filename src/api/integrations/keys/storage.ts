// src/api/integrations/keys/storage.ts

/**
 * Storage для ключей интеграций
 *
 * Ответственность:
 * - Шифрование secrets (AES-GCM-256) → KV_CREDENTIALS
 * - Хранение metadata → D1 account_keys
 * - CRUD операции с retry для D1
 *
 * НЕ содержит логику провайдеров — только хранение!
 * Валидация и подготовка данных — в initkey.ts каждого провайдера.
 */

import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../../lib/crypto";
import { withRetry } from "../../lib/retry";
import { isValidProvider } from "../providers/registry";
import type { Env } from "../../types/worker";
import type { ProviderId } from "../providers/registry";

// ============================================================
// TYPES
// ============================================================

/** Параметры для создания ключа */
export interface CreateKeyParams {
  /** ID аккаунта 301.st */
  account_id: number;

  /** ID провайдера (cloudflare, namecheap, ...) */
  provider: ProviderId;

  /** Название ключа для UI */
  key_alias: string;

  /** Sensitive данные для шифрования (token, apiKey, etc.) */
  secrets: Record<string, string>;

  /** ID аккаунта у провайдера (CF Account ID, etc.) */
  external_account_id?: string | null;

  /** Metadata для provider_scope (cf_token_id, cf_token_name, etc.) */
  provider_scope?: Record<string, unknown>;

  /** Срок действия ISO string */
  expires_at?: string | null;
}

/** Параметры для обновления ключа */
export interface UpdateKeyParams {
  /** ID ключа в account_keys */
  key_id: number;

  /** Новые secrets (перезаписывают полностью) */
  secrets?: Record<string, string>;

  /** Новый alias */
  key_alias?: string;

  /** Новый статус */
  status?: "active" | "expired" | "revoked";

  /** Merge в provider_scope */
  provider_scope?: Record<string, unknown>;

  /** Новый срок действия */
  expires_at?: string | null;
}

/** Запись ключа из D1 (без secrets) */
export interface KeyRecord {
  id: number;
  account_id: number;
  provider: string;
  provider_scope: string | null;
  key_alias: string | null;
  external_account_id: string | null;
  kv_key: string;
  status: string;
  expires_at: string | null;
  last_used: string | null;
  created_at: string;
}

/** Расшифрованные данные ключа */
export interface DecryptedKey {
  record: KeyRecord;
  secrets: Record<string, string>;
  scope: Record<string, unknown>;
}

// ============================================================
// CREATE
// ============================================================

/**
 * Создать новый ключ интеграции
 *
 * Порядок операций:
 * 1. Валидация
 * 2. KV_CREDENTIALS.put (encrypted secrets)
 * 3. D1 INSERT (metadata) — с retry
 *
 * При ошибке D1 — откатываем KV
 */
export async function createKey(
  env: Env,
  params: CreateKeyParams
): Promise<{ ok: true; key_id: number; kv_key: string } | { ok: false; error: string }> {
  const {
    account_id,
    provider,
    key_alias,
    secrets,
    external_account_id = null,
    provider_scope = {},
    expires_at = null,
  } = params;

  // 1. Валидация провайдера
  if (!isValidProvider(provider)) {
    return { ok: false, error: "unknown_provider" };
  }

  // 2. Проверка secrets
  if (!secrets || Object.keys(secrets).length === 0) {
    return { ok: false, error: "secrets_required" };
  }

  // 3. Генерируем ключ для KV
  const kvKey = `${provider}:${account_id}:${nanoid(12)}`;

  // 4. Шифруем secrets
  let encrypted: string;
  try {
    const encryptedData = await encrypt(secrets, env.MASTER_SECRET);
    encrypted = JSON.stringify(encryptedData);
  } catch (e) {
    console.error("Encryption failed:", e);
    return { ok: false, error: "encryption_failed" };
  }

  // 5. Сохраняем в KV_CREDENTIALS
  try {
    await env.KV_CREDENTIALS.put(kvKey, encrypted);
  } catch (e) {
    console.error("KV write failed:", e);
    return { ok: false, error: "kv_write_failed" };
  }

  // 6. Сохраняем в D1 (с retry)
  let keyId: number;
  try {
    keyId = await withRetry(async () => {
      const result = await env.DB301.prepare(
        `
        INSERT INTO account_keys (
          account_id,
          provider,
          provider_scope,
          key_alias,
          kv_key,
          status,
          expires_at,
          external_account_id
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `
      )
        .bind(
          account_id,
          provider,
          JSON.stringify(provider_scope),
          key_alias,
          kvKey,
          expires_at,
          external_account_id
        )
        .run();

      return result.meta?.last_row_id as number;
    });
  } catch (e) {
    // Rollback: удаляем из KV
    console.error("D1 insert failed, rolling back KV:", e);
    await env.KV_CREDENTIALS.delete(kvKey).catch((err) =>
      console.warn("KV rollback failed:", err)
    );
    return { ok: false, error: "db_write_failed" };
  }

  return { ok: true, key_id: keyId, kv_key: kvKey };
}

// ============================================================
// READ
// ============================================================

/**
 * Получить ключ по ID (без secrets)
 */
export async function getKey(env: Env, keyId: number): Promise<KeyRecord | null> {
  const row = await env.DB301.prepare(
    `
    SELECT 
      id, account_id, provider, provider_scope, key_alias,
      external_account_id, kv_key, status, expires_at, last_used, created_at
    FROM account_keys
    WHERE id = ?
    `
  )
    .bind(keyId)
    .first<KeyRecord>();

  return row ?? null;
}

/**
 * Получить ключ с расшифрованными secrets
 * Использовать ТОЛЬКО для выполнения API запросов!
 */
export async function getDecryptedKey(env: Env, keyId: number): Promise<DecryptedKey | null> {
  // 1. Получаем запись
  const record = await getKey(env, keyId);
  if (!record) return null;

  // 2. Проверяем статус
  if (record.status !== "active") {
    throw new Error(`key_${record.status}`);
  }

  // 3. Проверяем срок действия
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    await env.DB301.prepare(`UPDATE account_keys SET status = 'expired' WHERE id = ?`)
      .bind(keyId)
      .run();
    throw new Error("key_expired");
  }

  // 4. Получаем из KV
  const encryptedRaw = await env.KV_CREDENTIALS.get(record.kv_key);
  if (!encryptedRaw) {
    throw new Error("key_data_not_found");
  }

  // 5. Расшифровываем
  const secrets = await decrypt<Record<string, string>>(
    JSON.parse(encryptedRaw),
    env.MASTER_SECRET
  );

  // 6. Парсим scope
  const scope = record.provider_scope ? JSON.parse(record.provider_scope) : {};

  // 7. Обновляем last_used (best effort, без retry)
  await env.DB301.prepare(`UPDATE account_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(keyId)
    .run()
    .catch((e) => console.warn("Failed to update last_used:", e));

  return { record, secrets, scope };
}

/**
 * Список ключей аккаунта (без secrets)
 */
export async function listKeys(
  env: Env,
  accountId: number,
  provider?: ProviderId
): Promise<KeyRecord[]> {
  let query = `
    SELECT 
      id, account_id, provider, provider_scope, key_alias,
      external_account_id, kv_key, status, expires_at, last_used, created_at
    FROM account_keys
    WHERE account_id = ?
  `;

  const bindings: (number | string)[] = [accountId];

  if (provider) {
    query += ` AND provider = ?`;
    bindings.push(provider);
  }

  query += ` ORDER BY created_at DESC`;

  const result = await env.DB301.prepare(query).bind(...bindings).all<KeyRecord>();
  return result.results ?? [];
}

/**
 * Найти ключ по external_account_id
 */
export async function findKeyByExternalId(
  env: Env,
  accountId: number,
  provider: ProviderId,
  externalAccountId: string
): Promise<KeyRecord | null> {
  const row = await env.DB301.prepare(
    `
    SELECT 
      id, account_id, provider, provider_scope, key_alias,
      external_account_id, kv_key, status, expires_at, last_used, created_at
    FROM account_keys
    WHERE account_id = ? AND provider = ? AND external_account_id = ?
    LIMIT 1
    `
  )
    .bind(accountId, provider, externalAccountId)
    .first<KeyRecord>();

  return row ?? null;
}

// ============================================================
// UPDATE
// ============================================================

/**
 * Обновить ключ (secrets и/или metadata)
 *
 * Порядок операций:
 * 1. KV_CREDENTIALS.put (если secrets переданы)
 * 2. D1 UPDATE (metadata) — с retry
 */
export async function updateKey(
  env: Env,
  params: UpdateKeyParams
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { key_id, secrets, key_alias, status, provider_scope, expires_at } = params;

  // 1. Получаем текущую запись
  const record = await getKey(env, key_id);
  if (!record) {
    return { ok: false, error: "key_not_found" };
  }

  // 2. Обновляем secrets в KV если переданы
  if (secrets && Object.keys(secrets).length > 0) {
    try {
      const encryptedData = await encrypt(secrets, env.MASTER_SECRET);
      await env.KV_CREDENTIALS.put(record.kv_key, JSON.stringify(encryptedData));
    } catch (e) {
      console.error("KV update failed:", e);
      return { ok: false, error: "kv_write_failed" };
    }
  }

  // 3. Собираем UPDATE для D1
  const updates: string[] = [];
  const bindings: (string | number | null)[] = [];

  if (key_alias !== undefined) {
    updates.push("key_alias = ?");
    bindings.push(key_alias);
  }

  if (status !== undefined) {
    updates.push("status = ?");
    bindings.push(status);
  }

  if (expires_at !== undefined) {
    updates.push("expires_at = ?");
    bindings.push(expires_at);
  }

  if (provider_scope !== undefined) {
    const currentScope = record.provider_scope ? JSON.parse(record.provider_scope) : {};
    const mergedScope = { ...currentScope, ...provider_scope };
    updates.push("provider_scope = ?");
    bindings.push(JSON.stringify(mergedScope));
  }

  // 4. Выполняем UPDATE (с retry)
  if (updates.length > 0) {
    bindings.push(key_id);
    try {
      await withRetry(async () => {
        await env.DB301.prepare(`UPDATE account_keys SET ${updates.join(", ")} WHERE id = ?`)
          .bind(...bindings)
          .run();
      });
    } catch (e) {
      console.error("D1 update failed:", e);
      return { ok: false, error: "db_write_failed" };
    }
  }

  return { ok: true };
}

// ============================================================
// DELETE
// ============================================================

/**
 * Удалить ключ полностью (D1 + KV)
 *
 * Порядок операций:
 * 1. Получаем запись (нужен kv_key)
 * 2. D1 DELETE (с retry)
 * 3. KV_CREDENTIALS.delete (best effort)
 */
export async function deleteKey(
  env: Env,
  keyId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 1. Получаем запись (нужен kv_key)
  const record = await getKey(env, keyId);
  if (!record) {
    return { ok: false, error: "key_not_found" };
  }

  // 2. D1 DELETE (с retry)
  try {
    await withRetry(async () => {
      await env.DB301.prepare(`DELETE FROM account_keys WHERE id = ?`).bind(keyId).run();
    });
  } catch (e) {
    console.error("D1 delete failed:", e);
    return { ok: false, error: "db_delete_failed" };
  }

  // 3. KV DELETE (best effort)
  await env.KV_CREDENTIALS.delete(record.kv_key).catch((e) =>
    console.warn("KV delete failed (best effort):", e)
  );

  return { ok: true };
}

/**
 * Отозвать ключ (soft delete)
 */
export async function revokeKey(
  env: Env,
  keyId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withRetry(async () => {
      await env.DB301.prepare(`UPDATE account_keys SET status = 'revoked' WHERE id = ?`)
        .bind(keyId)
        .run();
    });
  } catch (e) {
    console.error("D1 revoke failed:", e);
    return { ok: false, error: "db_write_failed" };
  }

  return { ok: true };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Проверить владение ключом
 */
export async function verifyKeyOwnership(
  env: Env,
  keyId: number,
  accountId: number
): Promise<boolean> {
  const row = await env.DB301.prepare(
    `SELECT 1 FROM account_keys WHERE id = ? AND account_id = ?`
  )
    .bind(keyId, accountId)
    .first();

  return row !== null;
}

/**
 * Есть ли активный ключ для провайдера
 */
export async function hasActiveKey(
  env: Env,
  accountId: number,
  provider: ProviderId
): Promise<boolean> {
  const row = await env.DB301.prepare(
    `
    SELECT 1 FROM account_keys 
    WHERE account_id = ? AND provider = ? AND status = 'active'
    LIMIT 1
    `
  )
    .bind(accountId, provider)
    .first();

  return row !== null;
}
