/**
 * JWT Verification for Webhook Worker
 *
 * Упрощённая версия jwt.ts из src/api/lib/
 * Только верификация, без подписи и fingerprint.
 */

import { jwtVerify } from "jose";
import type { Env } from "./index";

// ============================================================
// CRYPTO (from src/api/lib/crypto.ts)
// ============================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getMasterKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
}

async function decrypt<T = unknown>(
  payload: { iv: string; ct: string; ver?: string },
  masterSecret: string
): Promise<T> {
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

// ============================================================
// JWT VERIFICATION
// ============================================================

export interface JWTPayload {
  sub?: string;      // user_id
  acc?: number;      // account_id
  role?: string;     // user role
  iat?: number;      // issued at
  exp?: number;      // expiration
  [key: string]: unknown;
}

/**
 * Verify JWT token
 *
 * @param token - JWT string
 * @param env - Worker env with DB301 and MASTER_SECRET
 * @returns Decoded payload or null if invalid
 */
export async function verifyJWT(
  token: string,
  env: Env
): Promise<JWTPayload | null> {
  try {
    // 1. Parse header to get kid
    let header: { kid?: string; alg?: string };
    try {
      header = JSON.parse(atob(token.split(".")[0]));
    } catch {
      console.warn("[JWT] Invalid token format");
      return null;
    }

    const kid = header.kid;

    if (!kid) {
      console.warn("[JWT] Token missing kid in header");
      return null;
    }

    // 2. Get key from DB by kid
    const keyRow = await env.DB301.prepare(
      "SELECT kid, secret_encrypted, status FROM jwt_keys WHERE kid = ?"
    )
      .bind(kid)
      .first<{
        kid: string;
        secret_encrypted: string;
        status: string;
      }>();

    if (!keyRow) {
      console.warn("[JWT] Key not found for kid:", kid);
      return null;
    }

    // 3. Check key status
    if (keyRow.status === "revoked") {
      console.warn("[JWT] Token signed with revoked key:", kid);
      return null;
    }

    if (!["active", "deprecated"].includes(keyRow.status)) {
      console.warn("[JWT] Key has invalid status:", keyRow.status);
      return null;
    }

    // 4. Decrypt the key secret
    const encryptedData = JSON.parse(keyRow.secret_encrypted);
    const jwtSecret = await decrypt<string>(encryptedData, env.MASTER_SECRET);
    const key = new TextEncoder().encode(jwtSecret);

    // 5. Verify JWT signature
    const { payload } = await jwtVerify(token, key);

    return payload as JWTPayload;
  } catch (err) {
    console.error("[JWT] Verification error:", err);
    return null;
  }
}

/**
 * Extract account_id from JWT payload
 */
export function getAccountIdFromPayload(payload: JWTPayload): number | null {
  // Try 'acc' field first (our standard)
  if (typeof payload.acc === "number") {
    return payload.acc;
  }

  // Try 'account_id' as fallback
  if (typeof payload.account_id === "number") {
    return payload.account_id;
  }

  return null;
}
