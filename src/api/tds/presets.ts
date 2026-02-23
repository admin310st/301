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

// ============================================================
// TYPES
// ============================================================

export type TdsPresetId = "S1" | "S2" | "S3" | "S4" | "S5" | "L1" | "L2" | "L3";

export interface TdsPresetParam {
  key: string;
  label: string;
  type: "string" | "string[]" | "url" | "select";
  required: boolean;
  options?: string[];   // For select type
  placeholder?: string;
}

export interface TdsPreset {
  id: TdsPresetId;
  name: string;
  description: string;
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
  description: "Блокировка или редирект ботов",
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action", label: "Действие", type: "select", required: true, options: ["redirect", "block"] },
    { key: "action_url", label: "URL редиректа", type: "url", required: false, placeholder: "https://safe-page.com" },
  ],
  fixedConditions: { bot: true },
  defaultAction: "block",
  defaultStatusCode: 302,
  defaultPriority: 10,
};

const S2: TdsPreset = {
  id: "S2",
  name: "Geo Filter",
  description: "Редирект по гео-таргетингу",
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "geo", label: "Страны", type: "string[]", required: true, placeholder: "RU, KZ, UA" },
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://offer.com/{country}" },
  ],
  fixedConditions: {},
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 50,
};

const S3: TdsPreset = {
  id: "S3",
  name: "Mobile Redirect",
  description: "Редирект мобильного трафика",
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://m.example.com" },
  ],
  fixedConditions: { device: "mobile" },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

const S4: TdsPreset = {
  id: "S4",
  name: "Desktop Redirect",
  description: "Редирект десктопного трафика",
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://desktop.example.com" },
  ],
  fixedConditions: { device: "desktop" },
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 40,
};

const S5: TdsPreset = {
  id: "S5",
  name: "Geo + Mobile",
  description: "Редирект мобильного трафика из указанных стран",
  category: "smartshield",
  tds_type: "traffic_shield",
  params: [
    { key: "geo", label: "Страны", type: "string[]", required: true, placeholder: "RU, KZ, UA" },
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://m.offer.com/cis" },
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
  description: "Разделение трафика по utm_source",
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "utm_source", label: "UTM Sources", type: "string[]", required: true, placeholder: "facebook, google, tiktok" },
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://offer.com?src={country}" },
  ],
  fixedConditions: {},
  defaultAction: "redirect",
  defaultStatusCode: 302,
  defaultPriority: 50,
};

const L2: TdsPreset = {
  id: "L2",
  name: "Facebook Traffic",
  description: "Трафик из Facebook/Meta (utm_source ИЛИ fbclid)",
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://offer.com/fb" },
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
  description: "Трафик из Google Ads (utm_source ИЛИ gclid)",
  category: "smartlink",
  tds_type: "smartlink",
  params: [
    { key: "action_url", label: "URL редиректа", type: "url", required: true, placeholder: "https://offer.com/gads" },
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
 * List all presets for UI.
 */
export function listTdsPresets(): Array<{
  id: TdsPresetId;
  name: string;
  description: string;
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
