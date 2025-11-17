// src/api/integrations/keys/storage.ts

import type { Env } from "../../types/worker";
import { encrypt } from "../../lib/crypto";
import { Providers, validateProvider } from "../providers/registry";
import type { Provider, ProviderKeyData, ProviderKeySchemas } from "./schema";


// Validate provider-specific fields
function validateProviderFields(provider: Provider, data: any) {
  switch (provider) {
    case Providers.NAMECHEAP:
      if (!data.apiKey || !data.username)
        throw new Error("namecheap_fields_required");
      return;

    case Providers.NAMESILO:
      if (!data.apiKey)
        throw new Error("namesilo_fields_required");
      return;

    case Providers.HOSTTRACKER:
      if (!data.token)
        throw new Error("hosttracker_token_required");
      return;

    case Providers.GOOGLE_ANALYTICS:
      if (!data.clientId || !data.clientSecret)
        throw new Error("ga_fields_required");
      return;

    case Providers.YANDEX_METRICA:
      if (!data.token)
        throw new Error("ym_token_required");
      return;

    default:
      throw new Error("unsupported_provider_fields");
  }
}

// CREATE
export async function createKey(
  env: Env,
  params: {
    account_id: number;
    provider: Provider;
    name: string;
    fields: ProviderKeyData;
  }
) {
  const { account_id, provider, name, fields } = params;

  if (!validateProvider(provider))
    throw new Error("unsupported_provider");

  validateProviderFields(provider, fields);

  const encrypted = await encrypt(fields, env.MASTER_SECRET);

  await env.DB301.prepare(
    `INSERT INTO account_keys 
      (account_id, provider, name, key_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(account_id, provider, name, JSON.stringify(encrypted))
    .run();

  return { ok: true };
}

// UPDATE
export async function updateKey(
  env: Env,
  params: {
    key_id: number;
    provider: Provider;
    fields: ProviderKeyData;
  }
) {
  const { key_id, provider, fields } = params;

  if (!validateProvider(provider))
    throw new Error("unsupported_provider");

  validateProviderFields(provider, fields);

  const encrypted = await encrypt(fields, env.MASTER_SECRET);

  await env.DB301.prepare(
    `UPDATE account_keys
       SET key_encrypted=?, provider=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  )
    .bind(JSON.stringify(encrypted), provider, key_id)
    .run();

  return { ok: true };
}

// DELETE
export async function deleteKey(
  env: Env,
  key_id: number
) {
  await env.DB301.prepare(
    `DELETE FROM account_keys WHERE id=?`
  )
    .bind(key_id)
    .run();

  return { ok: true };
}

// GET ONE
export async function getKey(env: Env, key_id: number) {
  const row = await env.DB301.prepare(
    `SELECT id, account_id, provider, name, created_at, updated_at 
       FROM account_keys 
      WHERE id=?`
  )
    .bind(key_id)
    .first();

  return row || null;
}

// LIST
export async function listKeys(env: Env, account_id: number) {
  const rows = await env.DB301.prepare(
    `SELECT id, account_id, provider, name, created_at, updated_at 
       FROM account_keys 
      WHERE account_id=?`
  )
    .bind(account_id)
    .all();

  return rows?.results || [];
}

