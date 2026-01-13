// src/api/redirects/presets.ts

/**
 * Redirect Presets (P1-P5)
 * 
 * Готовые комбинации шаблонов для типовых сценариев.
 * Хранятся в коде — изменение = деплой.
 * 
 * Пресет = набор правил, применяемых вместе.
 * Каждое правило в пресете создаёт отдельную запись в redirect_rules.
 */

import type { TemplateId, TemplateParams } from "./templates";

// ============================================================
// TYPES
// ============================================================

export type PresetId = "P1" | "P2" | "P3" | "P4" | "P5";

export interface PresetRule {
  template_id: TemplateId;
  order: number;
  description: string;
  // Параметры, которые нужно запросить у пользователя
  requiredParams: string[];
  // Параметры с фиксированными значениями
  fixedParams?: Partial<TemplateParams>;
}

export interface Preset {
  id: PresetId;
  name: string;
  description: string;
  useCase: string;
  rules: PresetRule[];
  // Сколько правил CF будет создано
  rulesCount: number;
}

export interface PresetParams {
  // Общие параметры для всех правил пресета
  target_url?: string;
  source_paths?: Array<{ source: string; target: string }>;
}

export interface ExpandedPresetRule {
  template_id: TemplateId;
  order: number;
  rule_name: string;
  params: TemplateParams;
}

// ============================================================
// PRESETS
// ============================================================

/**
 * P1: SEO Canonical (www)
 * Один шаблон T3: non-www → www
 */
const P1: Preset = {
  id: "P1",
  name: "SEO Canonical (www)",
  description: "Редирект с apex на www версию",
  useCase: "Стандартная SEO-настройка для сайтов с www",
  rules: [
    {
      template_id: "T3",
      order: 1,
      description: "non-www → www",
      requiredParams: [],
    },
  ],
  rulesCount: 1,
};

/**
 * P2: SEO Canonical (non-www)
 * Один шаблон T4: www → non-www
 */
const P2: Preset = {
  id: "P2",
  name: "SEO Canonical (non-www)",
  description: "Редирект с www на apex версию",
  useCase: "Стандартная SEO-настройка для сайтов без www",
  rules: [
    {
      template_id: "T4",
      order: 1,
      description: "www → non-www",
      requiredParams: [],
    },
  ],
  rulesCount: 1,
};

/**
 * P3: Domain Migration
 * T1 (Domain → Domain) + T3 (non-www → www на новом домене)
 */
const P3: Preset = {
  id: "P3",
  name: "Domain Migration",
  description: "Полный переезд домена с www-редиректом",
  useCase: "Миграция старого домена на новый с сохранением SEO",
  rules: [
    {
      template_id: "T1",
      order: 1,
      description: "Основной редирект домена",
      requiredParams: ["target_url"],
    },
    {
      template_id: "T3",
      order: 2,
      description: "SEO canonical на новом домене",
      requiredParams: [],
    },
  ],
  rulesCount: 2,
};

/**
 * P4: Maintenance Mode
 * Один шаблон T7: Maintenance
 */
const P4: Preset = {
  id: "P4",
  name: "Maintenance Mode",
  description: "Временный редирект на страницу обслуживания",
  useCase: "Технические работы, плановое обновление",
  rules: [
    {
      template_id: "T7",
      order: 1,
      description: "Редирект на maintenance страницу",
      requiredParams: ["target_url"],
      fixedParams: {
        preserve_path: false,
        preserve_query: false,
      },
    },
  ],
  rulesCount: 1,
};

/**
 * P5: Full Migration
 * T1 + T3 + T5 (×N путей)
 * Полный переезд с редиректом отдельных путей
 */
const P5: Preset = {
  id: "P5",
  name: "Full Migration",
  description: "Полный переезд с редиректом путей",
  useCase: "Миграция сайта с изменением структуры URL",
  rules: [
    {
      template_id: "T1",
      order: 1,
      description: "Основной редирект домена",
      requiredParams: ["target_url"],
    },
    {
      template_id: "T3",
      order: 2,
      description: "SEO canonical",
      requiredParams: [],
    },
    // T5 добавляется динамически для каждого пути
    // rulesCount здесь минимальный (2), реальный = 2 + N путей
  ],
  rulesCount: 2, // Минимум, реальный подсчитывается при expand
};

// ============================================================
// REGISTRY
// ============================================================

export const PRESETS: Record<PresetId, Preset> = {
  P1,
  P2,
  P3,
  P4,
  P5,
};

/**
 * Получить пресет по ID
 */
export function getPreset(id: string): Preset | undefined {
  return PRESETS[id as PresetId];
}

/**
 * Список всех пресетов для UI
 */
export function listPresets(): Array<{
  id: PresetId;
  name: string;
  description: string;
  useCase: string;
  rulesCount: number;
  requiredParams: string[];
}> {
  return Object.values(PRESETS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    useCase: p.useCase,
    rulesCount: p.rulesCount,
    requiredParams: Array.from(
      new Set(p.rules.flatMap((r) => r.requiredParams))
    ),
  }));
}

/**
 * Развернуть пресет в список правил с параметрами
 */
export function expandPreset(
  presetId: string,
  sourceDomain: string,
  params: PresetParams
): ExpandedPresetRule[] | null {
  const preset = getPreset(presetId);
  if (!preset) return null;

  const expanded: ExpandedPresetRule[] = [];

  for (const rule of preset.rules) {
    const templateParams: TemplateParams = {
      source_domain: sourceDomain,
      ...rule.fixedParams,
    };

    // Заполняем параметры из PresetParams
    if (rule.requiredParams.includes("target_url") && params.target_url) {
      templateParams.target_url = params.target_url;
      templateParams.target_domain = extractDomain(params.target_url);
    }

    expanded.push({
      template_id: rule.template_id,
      order: rule.order,
      rule_name: `${preset.name} (${rule.order}/${preset.rules.length}): ${rule.description}`,
      params: templateParams,
    });
  }

  // P5: добавляем T5 для каждого пути
  if (presetId === "P5" && params.source_paths) {
    let order = preset.rules.length;
    
    for (const path of params.source_paths) {
      order++;
      expanded.push({
        template_id: "T5",
        order,
        rule_name: `${preset.name} (${order}): ${path.source} → ${path.target}`,
        params: {
          source_domain: sourceDomain,
          source_path: path.source,
          target_path: path.target,
        },
      });
    }
  }

  return expanded;
}

/**
 * Подсчитать реальное количество правил CF
 */
export function countPresetRules(
  presetId: string,
  params: PresetParams
): number {
  const preset = getPreset(presetId);
  if (!preset) return 0;

  let count = preset.rules.length;

  // P5: добавляем T5 для каждого пути
  if (presetId === "P5" && params.source_paths) {
    count += params.source_paths.length;
  }

  return count;
}

// ============================================================
// HELPERS
// ============================================================

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
