// src/api/auth/register.ts

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { startOmniFlow } from "../lib/start";

const app = new Hono();

/**
 * Classic Sign-Up → OmniAuth START
 * вызываем библиотеку startOmniFlow напрямую,
 */

app.post("/", async (c) => {
  const env = c.env;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }

  const email = body.email?.trim();
  const turnstile_token = body.turnstile_token;

  if (!email) {
    throw new HTTPException(400, { message: "email_required" });
  }

  // IP + UA 
  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    "0.0.0.0";

  const ua = c.req.header("User-Agent") || "unknown";

  // вызов библиотеки
  const result = await startOmniFlow(env, {
    identifier: email,
    mode: "register",
    payload: null,
    ip,
    ua,
    turnstileToken: turnstile_token,
  });

  // результат
  return c.json({
    status: result.status,
    token: result.token,
    channel: result.channel,
    mode: result.mode,
  });
});

export default app;

