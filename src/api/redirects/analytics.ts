// src/api/redirects/analytics.ts

/**
 * CF GraphQL Analytics API client
 *
 * Получение статистики 3xx редиректов из Cloudflare Analytics.
 * Использует httpRequestsAdaptiveGroups (near real-time, адаптивное семплирование).
 *
 * Фильтрация: datetime_geq/datetime_lt + edgeResponseStatus 301/302/307/308.
 * Группировка: по clientRequestHTTPHost → count per domain.
 */

// ============================================================
// TYPES
// ============================================================

export interface RedirectStats {
  host: string;
  count: number;
}

interface CFGraphQLResponse {
  data?: {
    viewer?: {
      zones?: Array<{
        httpRequestsAdaptiveGroups?: Array<{
          dimensions: {
            clientRequestHTTPHost: string;
          };
          count: number;
        }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// ============================================================
// GRAPHQL QUERY
// ============================================================

const REDIRECT_STATS_QUERY = `
  query RedirectStats($zoneTag: String!, $datetimeStart: DateTime!, $datetimeEnd: DateTime!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          filter: {
            datetime_geq: $datetimeStart
            datetime_lt: $datetimeEnd
            edgeResponseStatus_in: [301, 302, 307, 308]
          }
          limit: 1000
          orderBy: [count_DESC]
        ) {
          dimensions {
            clientRequestHTTPHost
          }
          count
        }
      }
    }
  }
`;

// ============================================================
// API
// ============================================================

/**
 * Получить статистику редиректов за указанную дату
 *
 * @param cfZoneId - ID зоны в Cloudflare
 * @param token - API токен клиента
 * @param date - Дата в формате YYYY-MM-DD (запрашивает полные сутки 00:00–24:00 UTC)
 * @returns Массив {host, count} или пустой массив при ошибке
 */
export async function fetchRedirectStats(
  cfZoneId: string,
  token: string,
  date: string
): Promise<RedirectStats[]> {
  const datetimeStart = `${date}T00:00:00Z`;
  const datetimeEnd = `${date}T23:59:59Z`;

  try {
    const response = await fetch(CF_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: REDIRECT_STATS_QUERY,
        variables: {
          zoneTag: cfZoneId,
          datetimeStart,
          datetimeEnd,
        },
      }),
    });

    if (!response.ok) {
      console.error(`[STATS] CF GraphQL HTTP ${response.status} for zone ${cfZoneId}`);
      return [];
    }

    const data = (await response.json()) as CFGraphQLResponse;

    if (data.errors && data.errors.length > 0) {
      console.error(`[STATS] CF GraphQL errors for zone ${cfZoneId}:`, data.errors.map((e) => e.message).join(", "));
      return [];
    }

    const groups = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
    if (!groups || groups.length === 0) {
      console.log(`[STATS] CF GraphQL empty for zone ${cfZoneId}, date ${date}`);
      return [];
    }

    console.log(`[STATS] CF GraphQL zone ${cfZoneId}: ${groups.length} hosts, total ${groups.reduce((s, g) => s + g.count, 0)} hits`);

    return groups.map((g) => ({
      host: g.dimensions.clientRequestHTTPHost,
      count: g.count,
    }));
  } catch (e) {
    console.error("CF GraphQL fetch error:", e);
    return [];
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Получить вчерашнюю дату в формате YYYY-MM-DD
 */
export function getYesterdayDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

/**
 * Получить сегодняшнюю дату в формате YYYY-MM-DD
 */
export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}
