// src/api/integrations/providers/cloudflare/responses.ts

/**
 * CF-специфичные ответы для UI
 *
 * Принцип:
 * - Back анализирует CF API response
 * - Back классифицирует ошибку
 * - Back формирует понятный ответ для UI
 *
 * UI НЕ получает сырые CF ошибки — только типизированные коды.
 */

import type { Context } from "hono";

// ============================================================
// TYPES
// ============================================================

/** Успешный ответ initkey */
export interface InitKeySuccessData {
  key_id: number;
  is_rotation?: boolean;
  sync?: {
    zones: number;
    domains: number;
  };
}

/** CF API response structure */
export interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result: T;
}

/** Parsed CF error */
interface ParsedCFError {
  error: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

// ============================================================
// CF ERROR MAPPING
// ============================================================

/**
 * Маппинг CF error codes → UI error codes
 *
 * Документация CF: https://developers.cloudflare.com/fundamentals/api/reference/errors/
 */
const CF_ERROR_MAP: Record<number, { error: string; recoverable: boolean }> = {
  // Token errors
  1000: { error: "bootstrap_invalid", recoverable: false },
  1001: { error: "bootstrap_invalid", recoverable: false },
  1003: { error: "bootstrap_expired", recoverable: false },

  // Auth errors
  9109: { error: "cf_rejected", recoverable: false },
  10000: { error: "cf_rejected", recoverable: false },

  // Permission errors
  9106: { error: "permissions_missing", recoverable: false },

  // Rate limit
  429: { error: "cf_unavailable", recoverable: true },

  // Server errors
  500: { error: "cf_unavailable", recoverable: true },
  502: { error: "cf_unavailable", recoverable: true },
  503: { error: "cf_unavailable", recoverable: true },
};

/**
 * Анализ CF API ошибки → UI error
 */
export function parseCFError(cfResponse: CFApiResponse<unknown>): ParsedCFError {
  const firstError = cfResponse.errors?.[0];

  if (!firstError) {
    return {
      error: "cf_unknown_error",
      recoverable: true,
      context: { cf_response: cfResponse },
    };
  }

  const mapped = CF_ERROR_MAP[firstError.code];

  if (mapped) {
    return {
      error: mapped.error,
      recoverable: mapped.recoverable,
      context: {
        cf_code: firstError.code,
        cf_message: firstError.message,
      },
    };
  }

  // Unknown CF error — передаём как есть
  return {
    error: "cf_rejected",
    recoverable: false,
    context: {
      cf_code: firstError.code,
      cf_message: firstError.message,
    },
  };
}

/**
 * Анализ HTTP/network ошибки
 */
export function parseNetworkError(error: unknown): ParsedCFError {
  const message = error instanceof Error ? error.message : String(error);

  // Timeout или network error — recoverable
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("ECONNREFUSED") ||
    message.includes("fetch failed")
  ) {
    return {
      error: "cf_unavailable",
      recoverable: true,
      context: { network_error: message },
    };
  }

  return {
    error: "cf_unavailable",
    recoverable: true,
    context: { error: message },
  };
}

// ============================================================
// RESPONSE BUILDERS
// ============================================================

/**
 * Успешный ответ
 */
export function success(c: Context, data: InitKeySuccessData): Response {
  return c.json(
    {
      ok: true,
      key_id: data.key_id,
      ...(data.is_rotation !== undefined && { is_rotation: data.is_rotation }),
      ...(data.sync && { sync: data.sync }),
    },
    200
  );
}

/**
 * Ответ с ошибкой
 */
export function error(
  c: Context,
  code: string,
  status: number,
  recoverable: boolean,
  context?: Record<string, unknown>
): Response {
  return c.json(
    {
      ok: false,
      error: code,
      recoverable,
      ...(context && { context }),
    },
    status
  );
}

// ============================================================
// ERROR PRESETS
// ============================================================

export const Errors = {
  // ─────────────────────────────────────────────────────────
  // Input errors (400)
  // ─────────────────────────────────────────────────────────

  invalidJson: (c: Context) => error(c, "invalid_json", 400, false),

  missingFields: (c: Context, fields: string[]) =>
    error(c, "missing_fields", 400, false, { fields }),

  // ─────────────────────────────────────────────────────────
  // Auth errors (401, 403)
  // ─────────────────────────────────────────────────────────

  unauthorized: (c: Context) => error(c, "unauthorized", 401, false),

  ownerRequired: (c: Context) => error(c, "owner_required", 403, false),

  quotaExceeded: (c: Context, limit: number, current: number, plan: string) =>
    error(c, "quota_exceeded", 403, false, { limit, current, plan }),

  // ─────────────────────────────────────────────────────────
  // Bootstrap errors (400)
  // ─────────────────────────────────────────────────────────

  bootstrapInvalid: (c: Context, cfMessage?: string) =>
    error(c, "bootstrap_invalid", 400, false, cfMessage ? { cf_message: cfMessage } : undefined),

  bootstrapExpired: (c: Context) => error(c, "bootstrap_expired", 400, false),

  bootstrapNotActive: (c: Context, status: string) =>
    error(c, "bootstrap_not_active", 400, false, { status }),

  permissionsMissing: (c: Context, missing: string[]) =>
    error(c, "permissions_missing", 400, false, { missing }),

  // ─────────────────────────────────────────────────────────
  // CF API errors (400, 502)
  // ─────────────────────────────────────────────────────────

  cfUnavailable: (c: Context, details?: string) =>
    error(c, "cf_unavailable", 502, true, details ? { details } : undefined),

  cfRejected: (c: Context, cfCode: number, cfMessage: string) =>
    error(c, "cf_rejected", 400, false, { cf_code: cfCode, cf_message: cfMessage }),

  /** Ошибка из parseCFError */
  cfError: (c: Context, parsed: ParsedCFError) => {
    const status = parsed.recoverable ? 502 : 400;
    return error(c, parsed.error, status, parsed.recoverable, parsed.context);
  },

  // ─────────────────────────────────────────────────────────
  // Internal errors (500)
  // ─────────────────────────────────────────────────────────

  storageFailed: (c: Context, cfTokenId: string, cfAccountId: string) =>
    error(c, "storage_failed", 500, true, {
      cf_token_id: cfTokenId,
      cf_account_id: cfAccountId,
    }),

  cleanupFailed: (c: Context, details?: string) =>
    error(c, "cleanup_failed", 500, true, details ? { details } : undefined),

  // ─────────────────────────────────────────────────────────
  // Conflict errors (409)
  // ─────────────────────────────────────────────────────────

  keyAlreadyExists: (c: Context, existingKeyId: number) =>
    error(c, "key_already_exists", 409, false, { existing_key_id: existingKeyId }),

  cfAccountConflict: (
    c: Context,
    existingAccountId: string,
    existingKeyId: number,
    newAccountId: string
  ) =>
    error(c, "cf_account_conflict", 409, false, {
      existing_account_id: existingAccountId,
      existing_key_id: existingKeyId,
      new_account_id: newAccountId,
      resolution: "confirm_replace",
    }),
};
