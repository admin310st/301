// src/api/redirects/analytics.ts

/**
 * CF GraphQL Analytics API client
 *
 * Получение статистики 3xx редиректов из Cloudflare Analytics.
 * Free Plan: 3 дня retention — cron должен работать ежедневно.
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
  query RedirectStats($zoneTag: String!, $date: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          filter: {
            date: $date
            edgeResponseStatus_geq: 300
            edgeResponseStatus_lt: 400
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
 * Получить статистику 3xx редиректов за указанную дату
 *
 * @param cfZoneId - ID зоны в Cloudflare
 * @param token - API токен клиента
 * @param date - Дата в формате YYYY-MM-DD
 * @returns Массив {host, count} или пустой массив при ошибке
 */
export async function fetchRedirectStats(
  cfZoneId: string,
  token: string,
  date: string
): Promise<RedirectStats[]> {
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
          date,
        },
      }),
    });

    if (!response.ok) {
      console.error(`CF GraphQL HTTP error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as CFGraphQLResponse;

    if (data.errors && data.errors.length > 0) {
      console.error("CF GraphQL errors:", data.errors.map((e) => e.message).join(", "));
      return [];
    }

    const groups = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
    if (!groups || groups.length === 0) {
      return [];
    }

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
