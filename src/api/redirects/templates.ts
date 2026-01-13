// src/api/redirects/templates.ts

/**
 * Redirect Templates (T1-T7)
 * 
 * Фиксированные CF expressions для Single Redirects API.
 * Хранятся в коде — изменение = деплой.
 * 
 * Phase: http_request_dynamic_redirect
 * Лимит: 10 правил/зона (Free Plan)
 */

// ============================================================
// TYPES
// ============================================================

export type TemplateId = "T1" | "T3" | "T4" | "T5" | "T6" | "T7";

export type TemplateCategory = "domain" | "canonical" | "path" | "temporary";

export interface TemplateParam {
  name: string;
  type: "string" | "boolean";
  required: boolean;
  default?: string | boolean;
  description: string;
  placeholder?: string;
  validation?: {
    pattern?: string;
    minLength?: number;
    maxLength?: number;
  };
}

export interface Template {
  id: TemplateId;
  name: string;
  description: string;
  category: TemplateCategory;
  
  // CF Expression builders
  expression: (params: TemplateParams) => string;
  target: (params: TemplateParams) => string;
  
  // Defaults
  preservePath: boolean;
  preserveQuery: boolean;
  defaultStatusCode: 301 | 302;
  
  // UI params
  params: TemplateParam[];
  
  // Validation
  validate: (params: TemplateParams) => ValidationResult;
}

export interface TemplateParams {
  source_domain: string;      // Домен-источник (из domain_name)
  target_url?: string;        // URL назначения (T1, T7)
  target_domain?: string;     // Домен назначения (извлекается из target_url)
  source_path?: string;       // Путь-источник (T5, T6)
  target_path?: string;       // Путь назначения (T5)
  preserve_path?: boolean;    // Сохранять путь
  preserve_query?: boolean;   // Сохранять query string
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Извлечь домен из URL
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url;
  }
}

/**
 * Валидация URL
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Валидация пути
 */
function isValidPath(path: string): boolean {
  return path.startsWith("/") && !path.includes(" ");
}

/**
 * Экранирование для CF expression
 */
function escapeExpression(str: string): string {
  return str.replace(/"/g, '\\"');
}

// ============================================================
// TEMPLATES
// ============================================================

/**
 * T1: Domain → Domain
 * Основной кейс — редирект всего домена на другой
 */
const T1: Template = {
  id: "T1",
  name: "Domain → Domain",
  description: "Редирект всего домена на другой (донор → лендинг)",
  category: "domain",
  
  expression: (p) => `(http.host eq "${escapeExpression(p.source_domain)}")`,
  
  target: (p) => {
    const targetDomain = p.target_domain || extractDomain(p.target_url || "");
    const path = p.preserve_path !== false ? "http.request.uri.path" : '""';
    const query = p.preserve_query !== false ? "true" : "false";
    
    // Dynamic expression для CF
    return `concat("https://${escapeExpression(targetDomain)}", ${path})`;
  },
  
  preservePath: true,
  preserveQuery: true,
  defaultStatusCode: 301,
  
  params: [
    {
      name: "target_url",
      type: "string",
      required: true,
      description: "URL назначения (https://target.com)",
      placeholder: "https://example.com",
      validation: {
        pattern: "^https?://",
        minLength: 10,
        maxLength: 255,
      },
    },
    {
      name: "preserve_path",
      type: "boolean",
      required: false,
      default: true,
      description: "Сохранять путь (/page → /page)",
    },
    {
      name: "preserve_query",
      type: "boolean",
      required: false,
      default: true,
      description: "Сохранять query string (?utm_source=...)",
    },
  ],
  
  validate: (p) => {
    const errors: string[] = [];
    
    if (!p.target_url) {
      errors.push("target_url is required");
    } else if (!isValidUrl(p.target_url)) {
      errors.push("target_url must be a valid URL (https://...)");
    }
    
    return { valid: errors.length === 0, errors };
  },
};

/**
 * T3: non-www → www
 * SEO canonical — редирект с apex на www
 */
const T3: Template = {
  id: "T3",
  name: "non-www → www",
  description: "SEO canonical: example.com → www.example.com",
  category: "canonical",
  
  expression: (p) => {
    // Только apex домен (без www)
    const apex = p.source_domain.replace(/^www\./, "");
    return `(http.host eq "${escapeExpression(apex)}")`;
  },
  
  target: (p) => {
    const apex = p.source_domain.replace(/^www\./, "");
    return `concat("https://www.${escapeExpression(apex)}", http.request.uri.path)`;
  },
  
  preservePath: true,
  preserveQuery: true,
  defaultStatusCode: 301,
  
  params: [], // Нет настраиваемых параметров
  
  validate: (p) => {
    const errors: string[] = [];
    
    if (p.source_domain.startsWith("www.")) {
      errors.push("Source domain should be apex (without www)");
    }
    
    return { valid: errors.length === 0, errors };
  },
};

/**
 * T4: www → non-www
 * SEO canonical — редирект с www на apex
 */
const T4: Template = {
  id: "T4",
  name: "www → non-www",
  description: "SEO canonical: www.example.com → example.com",
  category: "canonical",
  
  expression: (p) => {
    const apex = p.source_domain.replace(/^www\./, "");
    return `(http.host eq "www.${escapeExpression(apex)}")`;
  },
  
  target: (p) => {
    const apex = p.source_domain.replace(/^www\./, "");
    return `concat("https://${escapeExpression(apex)}", http.request.uri.path)`;
  },
  
  preservePath: true,
  preserveQuery: true,
  defaultStatusCode: 301,
  
  params: [], // Нет настраиваемых параметров
  
  validate: () => ({ valid: true, errors: [] }),
};

/**
 * T5: Path prefix → Path
 * Редирект по префиксу пути: /old/* → /new/
 */
const T5: Template = {
  id: "T5",
  name: "Path prefix → Path",
  description: "Редирект по префиксу пути: /old/* → /new/",
  category: "path",
  
  expression: (p) => {
    const path = p.source_path || "/old/";
    return `(http.host eq "${escapeExpression(p.source_domain)}") and (starts_with(http.request.uri.path, "${escapeExpression(path)}"))`;
  },
  
  target: (p) => {
    const targetPath = p.target_path || "/new/";
    return `"https://${escapeExpression(p.source_domain)}${escapeExpression(targetPath)}"`;
  },
  
  preservePath: false, // Путь заменяется
  preserveQuery: true,
  defaultStatusCode: 301,
  
  params: [
    {
      name: "source_path",
      type: "string",
      required: true,
      description: "Префикс пути для перехвата",
      placeholder: "/old/",
      validation: {
        pattern: "^/",
        minLength: 2,
        maxLength: 100,
      },
    },
    {
      name: "target_path",
      type: "string",
      required: true,
      description: "Новый путь",
      placeholder: "/new/",
      validation: {
        pattern: "^/",
        minLength: 1,
        maxLength: 100,
      },
    },
  ],
  
  validate: (p) => {
    const errors: string[] = [];
    
    if (!p.source_path) {
      errors.push("source_path is required");
    } else if (!isValidPath(p.source_path)) {
      errors.push("source_path must start with /");
    }
    
    if (!p.target_path) {
      errors.push("target_path is required");
    } else if (!isValidPath(p.target_path)) {
      errors.push("target_path must start with /");
    }
    
    return { valid: errors.length === 0, errors };
  },
};

/**
 * T6: Exact path → URL
 * Точный редирект одной страницы
 */
const T6: Template = {
  id: "T6",
  name: "Exact path → URL",
  description: "Редирект конкретной страницы на URL",
  category: "path",
  
  expression: (p) => {
    const path = p.source_path || "/old-page";
    return `(http.host eq "${escapeExpression(p.source_domain)}") and (http.request.uri.path eq "${escapeExpression(path)}")`;
  },
  
  target: (p) => {
    return `"${escapeExpression(p.target_url || "")}"`;
  },
  
  preservePath: false,
  preserveQuery: true,
  defaultStatusCode: 301,
  
  params: [
    {
      name: "source_path",
      type: "string",
      required: true,
      description: "Точный путь страницы",
      placeholder: "/old-page",
      validation: {
        pattern: "^/",
        minLength: 2,
        maxLength: 255,
      },
    },
    {
      name: "target_url",
      type: "string",
      required: true,
      description: "URL назначения",
      placeholder: "https://example.com/new-page",
      validation: {
        pattern: "^https?://",
        minLength: 10,
        maxLength: 255,
      },
    },
  ],
  
  validate: (p) => {
    const errors: string[] = [];
    
    if (!p.source_path) {
      errors.push("source_path is required");
    } else if (!isValidPath(p.source_path)) {
      errors.push("source_path must start with /");
    }
    
    if (!p.target_url) {
      errors.push("target_url is required");
    } else if (!isValidUrl(p.target_url)) {
      errors.push("target_url must be a valid URL");
    }
    
    return { valid: errors.length === 0, errors };
  },
};

/**
 * T7: Maintenance redirect
 * Временный редирект на страницу обслуживания
 */
const T7: Template = {
  id: "T7",
  name: "Maintenance",
  description: "Временный редирект на страницу обслуживания",
  category: "temporary",
  
  expression: (p) => `(http.host eq "${escapeExpression(p.source_domain)}")`,
  
  target: (p) => `"${escapeExpression(p.target_url || "")}"`,
  
  preservePath: false,
  preserveQuery: false, // Maintenance не сохраняет query
  defaultStatusCode: 302, // ВАЖНО: всегда 302 для временных
  
  params: [
    {
      name: "target_url",
      type: "string",
      required: true,
      description: "URL страницы обслуживания",
      placeholder: "https://status.example.com/maintenance",
      validation: {
        pattern: "^https?://",
        minLength: 10,
        maxLength: 255,
      },
    },
  ],
  
  validate: (p) => {
    const errors: string[] = [];
    
    if (!p.target_url) {
      errors.push("target_url is required");
    } else if (!isValidUrl(p.target_url)) {
      errors.push("target_url must be a valid URL");
    }
    
    return { valid: errors.length === 0, errors };
  },
};

// ============================================================
// REGISTRY
// ============================================================

export const TEMPLATES: Record<TemplateId, Template> = {
  T1,
  T3,
  T4,
  T5,
  T6,
  T7,
};

/**
 * Получить шаблон по ID
 */
export function getTemplate(id: string): Template | undefined {
  return TEMPLATES[id as TemplateId];
}

/**
 * Список всех шаблонов для UI
 */
export function listTemplates(): Array<{
  id: TemplateId;
  name: string;
  description: string;
  category: TemplateCategory;
  params: TemplateParam[];
  defaultStatusCode: 301 | 302;
}> {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    params: t.params,
    defaultStatusCode: t.defaultStatusCode,
  }));
}

/**
 * Валидировать параметры для шаблона
 */
export function validateTemplateParams(
  templateId: string,
  params: TemplateParams
): ValidationResult {
  const template = getTemplate(templateId);
  
  if (!template) {
    return { valid: false, errors: [`Unknown template: ${templateId}`] };
  }
  
  return template.validate(params);
}

/**
 * Построить CF expression для правила
 */
export function buildExpression(
  templateId: string,
  params: TemplateParams
): string | null {
  const template = getTemplate(templateId);
  if (!template) return null;
  
  return template.expression(params);
}

/**
 * Построить CF target для правила
 */
export function buildTarget(
  templateId: string,
  params: TemplateParams
): string | null {
  const template = getTemplate(templateId);
  if (!template) return null;
  
  return template.target(params);
}
