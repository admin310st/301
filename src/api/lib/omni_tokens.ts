// src/api/lib/omni_tokens.ts

import { nanoid } from "nanoid";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types/worker";

export type OmniTokenType =
  | "register"
  | "login"
  | "reset"
  | "invite"
  | "action"
  | "oauth";

export interface OmniTokenPayload {
  type: OmniTokenType;
  identifier: string;
  code?: string;
  channel?: string;
  payload?: any;
  exp?: number;
}

export interface OmniTokenResult {
  token: string;
  code?: string;
}

const DEFAULT_TTL = 600;

//  CREATE TOKEN 
export async function createOmniToken(
  env: Env,
  data: {
    type: OmniTokenType;
    identifier: string;
    channel: string;
    payload?: any;
    otp?: boolean;
    ttl?: number;
  }
): Promise<OmniTokenResult> {
  const token = nanoid();
  const ttl = data.ttl ?? DEFAULT_TTL;

  let code: string | undefined = undefined;
  if (data.otp) {
    code = generateOtp();
  }

  const record: OmniTokenPayload = {
    type: data.type,
    identifier: data.identifier,
    channel: data.channel,
    code,
    payload: data.payload ?? null,
    exp: Date.now() + ttl * 1000,
  };

  await env.KV_SESSIONS.put(`omni:${token}`, JSON.stringify(record), {
    expirationTtl: ttl,
  });

  return { token, code };
}

//  VERIFY TOKEN 
export async function verifyOmniToken(
  env: Env,
  token: string,
  code?: string
): Promise<OmniTokenPayload> {
  const raw = await env.KV_SESSIONS.get(`omni:${token}`);
  if (!raw) {
    throw new HTTPException(400, { message: "invalid_token" });
  }

  const payload: OmniTokenPayload = JSON.parse(raw);

  if (payload.exp && Date.now() > payload.exp) {
    await env.KV_SESSIONS.delete(`omni:${token}`);
    throw new HTTPException(400, { message: "expired_token" });
  }

  if (payload.code && payload.code !== code) {
    throw new HTTPException(400, { message: "invalid_code" });
  }

  await env.KV_SESSIONS.delete(`omni:${token}`);

  return payload;
}

//  HELPERS 
function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

