// src/api/lib/registrar.ts
//
// Определение регистратора домена
// Порядок: RDAP → Whois → null

const RDAP_TIMEOUT = 5000;
const WHOIS_TIMEOUT = 5000;

export type RegistrarName =
  | "namecheap"
  | "godaddy"
  | "cloudflare"
  | "namesilo"
  | "porkbun"
  | "dynadot"
  | "google"
  | "name.com"
  | "hover"
  | "epik"
  | "enom"
  | "tucows"
  | "unknown";

// Нормализация названия регистратора
function normalizeRegistrar(raw: string): RegistrarName {
  const lower = raw.toLowerCase();

  if (lower.includes("namecheap")) return "namecheap";
  if (lower.includes("godaddy") || lower.includes("go daddy")) return "godaddy";
  if (lower.includes("cloudflare")) return "cloudflare";
  if (lower.includes("namesilo")) return "namesilo";
  if (lower.includes("porkbun")) return "porkbun";
  if (lower.includes("dynadot")) return "dynadot";
  if (lower.includes("google")) return "google";
  if (lower.includes("name.com")) return "name.com";
  if (lower.includes("hover")) return "hover";
  if (lower.includes("epik")) return "epik";
  if (lower.includes("enom")) return "enom";
  if (lower.includes("tucows")) return "tucows";

  return "unknown";
}

// 1) RDAP — предпочтительный метод (структурированный JSON)
async function detectViaRdap(domain: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RDAP_TIMEOUT);

    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; 301.st/1.0)",
        "Accept": "application/rdap+json, application/json",
      },
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json() as any;

    // Ищем entity с ролью "registrar"
    const entities = data.entities || [];
    for (const entity of entities) {
      const roles = entity.roles || [];
      if (roles.includes("registrar")) {
        // Извлекаем имя из vCard
        const vcard = entity.vcardArray?.[1] || [];
        for (const field of vcard) {
          if (field[0] === "fn") {
            return field[3] as string;
          }
        }
        // Fallback на handle
        if (entity.handle) {
          return entity.handle;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// 2) Whois API — fallback (api.whois.vu)
async function detectViaWhois(domain: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHOIS_TIMEOUT);

    const res = await fetch(`https://api.whois.vu/?q=${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; 301.st/1.0)",
      },
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json() as any;
    const whoisText = data.whois || "";

    // Ищем строку "Registrar: ..."
    const lines = whoisText.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^Registrar:\s*(.+)$/i);
      if (match) {
        return match[1].trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Определить регистратора домена
 * @param domain - доменное имя (например, "example.com")
 * @returns нормализованное имя регистратора или null
 */
export async function detectRegistrar(domain: string): Promise<{
  registrar: RegistrarName;
  raw: string | null;
}> {
  // 1) Пробуем RDAP
  let raw = await detectViaRdap(domain);

  // 2) Fallback на Whois
  if (!raw) {
    raw = await detectViaWhois(domain);
  }

  // 3) Нормализуем
  if (!raw) {
    return { registrar: "unknown", raw: null };
  }

  return {
    registrar: normalizeRegistrar(raw),
    raw,
  };
}
