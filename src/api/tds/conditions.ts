// src/api/tds/conditions.ts

/**
 * TDS Rule Conditions & Actions — Zod validation schemas.
 *
 * Used by CRUD handlers and presets to validate rule definitions.
 */

import { z } from "zod";

// ============================================================
// CONDITION SCHEMAS
// ============================================================

/** ISO 3166-1 alpha-2 country code (2 uppercase letters) */
const countryCode = z.string().regex(/^[A-Z]{2}$/, "Invalid country code");

export const ruleConditionsSchema = z.object({
  geo: z.array(countryCode).max(250).optional(),
  geo_exclude: z.array(countryCode).max(250).optional(),
  device: z.enum(["mobile", "desktop", "any"]).optional(),
  os: z.array(z.string().max(32)).max(10).optional(),
  browser: z.array(z.string().max(32)).max(10).optional(),
  bot: z.boolean().optional(),
  utm_source: z.array(z.string().max(128)).max(50).optional(),
  utm_campaign: z.array(z.string().max(128)).max(50).optional(),
  match_params: z.array(z.string().max(64)).max(20).optional(),
  path: z.string().max(512).optional(),
  referrer: z.string().max(512).optional(),
}).strict();

export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

// ============================================================
// ACTION SCHEMAS
// ============================================================

export const actionSchema = z.enum(["redirect", "block", "pass", "mab_redirect"]);
export type Action = z.infer<typeof actionSchema>;

export const statusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
]);

// ============================================================
// LOGIC JSON SCHEMA (stored in tds_rules.logic_json)
// ============================================================

export const logicJsonSchema = z.object({
  conditions: ruleConditionsSchema,
  action: actionSchema,
  action_url: z.string().url().max(2048).nullable().optional(),
  status_code: statusCodeSchema.optional().default(302),
  // MAB fields (used when action = mab_redirect)
  variants: z.array(z.object({
    url: z.string().url().max(2048),
    weight: z.number().min(0).max(1).optional(),
    alpha: z.number().min(0).optional().default(1),
    beta: z.number().min(0).optional().default(1),
  })).max(20).optional(),
}).refine(
  (data) => {
    if (data.action === "redirect" || data.action === "mab_redirect") {
      if (data.action === "mab_redirect") {
        return data.variants && data.variants.length >= 2;
      }
      return !!data.action_url;
    }
    return true;
  },
  { message: "redirect/mab_redirect action requires action_url or variants" },
);

export type LogicJson = z.infer<typeof logicJsonSchema>;

// ============================================================
// CREATE/UPDATE RULE INPUT
// ============================================================

export const tdsTypeSchema = z.enum(["smartlink", "traffic_shield"]);

export const createRuleSchema = z.object({
  rule_name: z.string().min(1).max(255),
  tds_type: tdsTypeSchema,
  logic_json: logicJsonSchema,
  priority: z.number().int().min(0).max(1000).optional().default(100),
});

export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = z.object({
  rule_name: z.string().min(1).max(255).optional(),
  tds_type: tdsTypeSchema.optional(),
  logic_json: logicJsonSchema.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  status: z.enum(["draft", "active", "disabled"]).optional(),
});

export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// ============================================================
// DOMAIN BINDING INPUT
// ============================================================

export const bindDomainsSchema = z.object({
  domain_ids: z.array(z.number().int().positive()).min(1).max(100),
});

export type BindDomainsInput = z.infer<typeof bindDomainsSchema>;

// ============================================================
// REORDER INPUT
// ============================================================

export const reorderSchema = z.object({
  rules: z.array(z.object({
    id: z.number().int().positive(),
    priority: z.number().int().min(0).max(1000),
  })).min(1).max(100),
});

export type ReorderInput = z.infer<typeof reorderSchema>;

// ============================================================
// PRESET CREATION INPUT
// ============================================================

export const createFromPresetSchema = z.object({
  preset_id: z.string().min(1).max(4),
  params: z.record(z.unknown()),
  domain_ids: z.array(z.number().int().positive()).max(100).optional(),
  rule_name: z.string().min(1).max(255).optional(),
});

export type CreateFromPresetInput = z.infer<typeof createFromPresetSchema>;

// ============================================================
// POSTBACK INPUT
// ============================================================

export const postbackSchema = z.object({
  rule_id: z.number().int().positive(),
  variant_url: z.string().url().max(2048),
  converted: z.number().int().min(0).max(1).optional().default(1),
  revenue: z.number().min(0).optional().default(0),
});

export type PostbackInput = z.infer<typeof postbackSchema>;

// ============================================================
// HELPERS
// ============================================================

/**
 * Validate and parse logic_json from string or object.
 */
export function parseLogicJson(input: unknown): { ok: true; data: LogicJson } | { ok: false; error: string } {
  try {
    const raw = typeof input === "string" ? JSON.parse(input) : input;
    const result = logicJsonSchema.safeParse(raw);
    if (!result.success) {
      return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
    }
    return { ok: true, data: result.data };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
