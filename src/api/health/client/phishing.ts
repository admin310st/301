/**
 * CF Phishing Check
 *
 * Проверяет meta.phishing_detected для зоны через CF API.
 * Вызывается только по триггеру (traffic anomaly).
 */

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// TYPES
// ============================================================

interface CFZoneResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: {
    id: string;
    name: string;
    status: string;
    meta?: {
      phishing_detected?: boolean;
    };
  };
}

export interface PhishingCheckResult {
  ok: boolean;
  zone_id?: string;
  zone_name?: string;
  phishing_detected: boolean;
  error?: string;
}

// ============================================================
// API
// ============================================================

/**
 * Проверить phishing статус зоны
 *
 * @param zoneId - CF Zone ID
 * @param token - CF API Token
 */
export async function checkZonePhishing(
  zoneId: string,
  token: string
): Promise<PhishingCheckResult> {
  try {
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        phishing_detected: false,
        error: `http_${response.status}`,
      };
    }

    const data = (await response.json()) as CFZoneResponse;

    if (!data.success) {
      return {
        ok: false,
        phishing_detected: false,
        error: data.errors?.[0]?.message || "cf_api_error",
      };
    }

    return {
      ok: true,
      zone_id: data.result.id,
      zone_name: data.result.name,
      phishing_detected: data.result.meta?.phishing_detected === true,
    };
  } catch (err) {
    return {
      ok: false,
      phishing_detected: false,
      error: err instanceof Error ? err.message : "network_error",
    };
  }
}

/**
 * Проверить phishing для нескольких зон
 */
export async function checkMultipleZonesPhishing(
  zoneIds: string[],
  token: string
): Promise<PhishingCheckResult[]> {
  const results: PhishingCheckResult[] = [];

  for (const zoneId of zoneIds) {
    const result = await checkZonePhishing(zoneId, token);
    results.push(result);
  }

  return results;
}
