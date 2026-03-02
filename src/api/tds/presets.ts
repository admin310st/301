// src/api/tds/presets.ts

/**
 * TDS Presets (S1-S5, L1-L3)
 *
 * Ready-made rule templates for common TDS scenarios.
 * Each preset = one tds_rules row (unlike redirect presets which create multiple).
 *
 * SmartShield (S): Conditions based on CF metadata (geo, device, bot).
 * SmartLink (L): Conditions based on URL parameters (UTM, click IDs).
 */

import type { LogicJson, RuleConditions } from "./conditions";
import type { Lang } from "../lib/messaging/i18n";

// ============================================================
// TYPES
// ============================================================

export type TdsPresetId = "S1" | "S2" | "S3" | "S4" | "S5" | "L1" | "L2" | "L3";

interface I18nString {
  en: string;
  ru: string;
}

export interface TdsPresetParam {
  key: string;
  label: I18nString;
  type: "string" | "string[]" | "url" | "select";
  required: boolean;
  options?: string[];   // For select type
  placeholder?: I18nString;
}

export interface TdsPreset {
  id: TdsPresetId;
  name: string;
  description: I18nString;
  category: "smartshield" | "smartlink";
  tds_type: "traffic_shield" | "smartlink";
  params: TdsPresetParam[];
  fixedConditions: Partial<RuleConditions>;
  defaultAction: "redirect" | "block" | "pass";
  defaultStatusCode: number;
  defaultPriority: number;
}

export interface ExpandedTdsPreset {
  rule_name: string;
  tds_type: "traffic_shield" | "smartlink";
  logic_json: LogicJson;
  priority: number;
  preset_id: TdsPresetId;
}

// ============================================================
// SMARTSHIELD PRESETS (S1-S5)
// ============================================================

const S1: TdsPreset = {
  id: "S1",
  name: "Bot Shield",
  description: { en: "Block or redirect bots", ru: "Блокировка или редирект ботов" },
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action", label: { en: "Action", ru: "Действие" }, type: "select", required: true, options: ["redirect", "block"] },
    { key: "action_url", label: { en: "Redirect URL", ru: "URL редиректа" }, type: "url", required: false, placeholder: { en: "https://safe-page.com", ru: "https://safe-page.com" } },
  ],
  fixedConditions: { bot: true },
  defaultAction: "block",
  defaultStatusCode: 302,
  defaultPriority: 10,
};

const S2: TdsPreset = {
  id: "S2",
  name: "Geo Filter",
  description: { en: "Redirect by geo-targeting", ru: "Редирект по гео-таргетингу" },
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "geo", label: { en: "Countries", ru: "Страны" }, type: "string[]", required: true, placeholder: { en: "US, DE, FR", ru: "US, DE, FR" } },
    { key: "action_url", label: { en: "Redirect URL", ru: "URL редиректа" }, type: "url", required: true, placeholder: { en: "https://geo-page.com", ru: "https://geo-page.com" } },
  ],
  fixedConditions: {},
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 50,
};

const S3: TdsPreset = {
  id: "S3",
  name: "Mobile Redirect",
  description: { en: "Redirect mobile traffic", ru: "Редирект мобильного трафика" },
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action_url", label: { en: "Mobile redirect URL", ru: "URL редиректа для мобильных" }, type: "url", required: true, placeholder: { en: "https://m.example.com", ru: "https://m.example.com" } },
  ],
  fixedConditions: { device: "mobile" },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

const S4: TdsPreset = {
  id: "S4",
  name: "Desktop Redirect",
  description: { en: "Redirect desktop traffic", ru: "Редирект десктопного трафика" },
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action_url", label: { en: "Desktop redirect URL", ru: "URL редиректа для десктопа" }, type: "url", required: true, placeholder: { en: "https://desktop.example.com", ru: "https://desktop.example.com" } },
  ],
  fixedConditions: { device: "desktop" },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

const S5: TdsPreset = {
  id: "S5",
  name: "Geo + Mobile",
  description: { en: "Redirect mobile traffic from specified countries", ru: "Редирект мобильного трафика из указанных стран" },
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "geo", label: { en: "Countries", ru: "Страны" }, type: "string[]", required: true, placeholder: { en: "US, DE, FR", ru: "US, DE, FR" } },
    { key: "action_url", label: { en: "Mobile redirect URL", ru: "URL редиректа для мобильных" }, type: "url", required: true, placeholder: { en: "https://m.example.com", ru: "https://m.example.com" } },
  ],
  fixedConditions: { device: "mobile" },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 30,
};

// ============================================================
// SMARTLINK PRESETS (L1-L3)
// ============================================================

const L1: TdsPreset = {
  id: "L1",
  name: "UTM Split",
  description: { en: "Split traffic by utm_source", ru: "Разделение трафика по utm_source" },
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "utm_source", label: { en: "utm_source value", ru: "Значение utm_source" }, type: "string[]", required: true, placeholder: { en: "facebook", ru: "facebook" } },
    { key: "action_url", label: { en: "Redirect URL", ru: "URL редиректа" }, type: "url", required: true, placeholder: { en: "https://landing.com", ru: "https://landing.com" } },
  ],
  fixedConditions: {},
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 50,
};

const L2: TdsPreset = {
  id: "L2",
  name: "Facebook Traffic",
  description: { en: "Facebook/Meta traffic (utm_source OR fbclid)", ru: "Трафик из Facebook/Meta (utm_source ИЛИ fbclid)" },
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "action_url", label: { en: "Redirect URL", ru: "URL редиректа" }, type: "url", required: true, placeholder: { en: "https://fb-landing.com", ru: "https://fb-landing.com" } },
  ],
  fixedConditions: {
    utm_source: ["facebook", "fb", "fb_ads", "meta"],
    match_params: ["fbclid"],
  },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

const L3: TdsPreset = {
  id: "L3",
  name: "Google Traffic",
  description: { en: "Google Ads traffic (utm_source OR gclid)", ru: "Трафик из Google Ads (utm_source ИЛИ gclid)" },
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "action_url", label: { en: "Redirect URL", ru: "URL редиректа" }, type: "url", required: true, placeholder: { en: "https://google-landing.com", ru: "https://google-landing.com" } },
  ],
  fixedConditions: {
    utm_source: ["google", "google_ads"],
    match_params: ["gclid"],
  },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

// ============================================================
// REGISTRY
// ============================================================

export const TDS_PRESETS: Record<TdsPresetId, TdsPreset> = {
  S1, S2, S3, S4, S5, L1, L2, L3,
};

export function getTdsPreset(id: string): TdsPreset | undefined {
  return TDS_PRESETS[id as TdsPresetId];
}

/**
 * List all presets (raw, with I18nString fields).
 * Used internally by expandTdsPreset / validatePresetParams.
 */
export function listTdsPresets(): Array<{
  id: TdsPresetId;
  name: string;
  description: I18nString;
  category: string;
  tds_type: string;
  params: TdsPresetParam[];
  defaultPriority: number;
}> {
  return Object.values(TDS_PRESETS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    tds_type: p.tds_type,
    params: p.params,
    defaultPriority: p.defaultPriority,
  }));
}

/**
 * Resolve I18nString to a plain string for the given language.
 */
function resolveI18n(s: I18nString, lang: Lang): string {
  return s[lang] || s.en;
}

/**
 * List all presets with localized strings for API response.
 */
export function listTdsPresetsLocalized(lang: Lang = "en") {
  return listTdsPresets().map((p) => ({
    ...p,
    description: resolveI18n(p.description, lang),
    params: p.params.map((param) => ({
      ...param,
      label: resolveI18n(param.label, lang),
      placeholder: param.placeholder ? resolveI18n(param.placeholder, lang) : undefined,
    })),
  }));
}

// ============================================================
// EXPAND PRESET
// ============================================================

interface PresetParams {
  geo?: string[];
  action_url?: string;
  action?: string;
  utm_source?: string[];
  rule_name?: string;
  priority?: number;
  status_code?: number;
}

/**
 * Validate preset params against preset definition.
 */
function validatePresetParams(
  preset: TdsPreset,
  params: PresetParams,
): { ok: true } | { ok: false; error: string } {
  for (const p of preset.params) {
    if (!p.required) continue;

    if (p.key === "action_url" && !params.action_url) {
      return { ok: false, error: `Missing required param: ${p.key}` };
    }
    if (p.key === "geo" && (!params.geo || params.geo.length === 0)) {
      return { ok: false, error: `Missing required param: ${p.key}` };
    }
    if (p.key === "utm_source" && (!params.utm_source || params.utm_source.length === 0)) {
      return { ok: false, error: `Missing required param: ${p.key}` };
    }
    if (p.key === "action" && !params.action) {
      return { ok: false, error: `Missing required param: ${p.key}` };
    }
  }

  return { ok: true };
}

/**
 * Expand a preset into a full rule definition.
 */
export function expandTdsPreset(
  presetId: string,
  params: PresetParams,
): ExpandedTdsPreset | { error: string } {
  const preset = getTdsPreset(presetId);
  if (!preset) return { error: "invalid_preset" };

  const validation = validatePresetParams(preset, params);
  if (!validation.ok) return { error: validation.error };

  // Build conditions
  const conditions: RuleConditions = { ...preset.fixedConditions };

  if (params.geo && params.geo.length > 0) {
    conditions.geo = params.geo;
  }
  if (params.utm_source && params.utm_source.length > 0) {
    conditions.utm_source = params.utm_source;
  }

  // Determine action
  const action = (params.action as "redirect" | "block") || preset.defaultAction;
  const actionUrl = action === "block" ? null : (params.action_url || null);

  const statusCode = (params.status_code || preset.defaultStatusCode) as 301 | 302 | 307;

  const logic: LogicJson = {
    conditions,
    action,
    action_url: actionUrl,
    status_code: statusCode,
  };

  return {
    rule_name: params.rule_name || preset.name,
    tds_type: preset.tds_type,
    logic_json: logic,
    priority: params.priority ?? preset.defaultPriority,
    preset_id: preset.id,
  };
}
