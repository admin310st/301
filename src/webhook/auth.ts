/**
 * Webhook Auth — API key verification via SHA-256 hash
 *
 * Shared by all webhook handlers: /deploy, /health, /tds
 * Client workers send plain API key in Authorization header.
 * We hash it and lookup in DB301.worker_api_keys.
 */

import type { Context } from "hono";
import type { Env } from "./index";

export interface AuthResult {
  account_id: number;
  cf_account_id: string;
}

async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify API key from Authorization header.
 * Returns AuthResult on success, or error Response.
 */
export async function verifyApiKey(
  c: Context<{ Bindings: Env }>
): Promise<AuthResult | Response> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ ok: false, error: "missing_authorization" }, 401);
  }

  const apiKey = authHeader.replace("Bearer ", "");
  const keyHash = await hashApiKey(apiKey);

  const keyRow = await c.env.DB301.prepare(
    "SELECT account_id, cf_account_id FROM worker_api_keys WHERE api_key_hash = ?"
  ).bind(keyHash).first<AuthResult>();

  if (!keyRow) {
    return c.json({ ok: false, error: "invalid_api_key" }, 401);
  }

  return keyRow;
}
