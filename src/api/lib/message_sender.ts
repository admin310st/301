// src/api/lib/message_sender.ts
import { HTTPException } from "hono/http-exception";

type DeliveryChannel = "email" | "telegram" | "sms";

export interface SendMessageInput {
  channel: DeliveryChannel;
  identifier: string;         // email / phone / tg_id
  token: string;              // omni token
  code?: string;              // OTP код (для TG/SMS)
  template?: "verify" | "login" | "reset" | "invite" | "action";
}

/**
 * Главная точка входа
 */
export async function sendOmniMessage(env: Env, data: SendMessageInput): Promise<void> {
  switch (data.channel) {
    case "email":
      return await sendEmail(env, data);
    case "telegram":
      return await sendTelegram(env, data);
    case "sms":
      return await sendSms(env, data);
    default:
      throw new HTTPException(400, { message: "unsupported_channel" });
  }
}

// EMAIL DELIVERY (Workers Email API + конфигурация через vars)
async function sendEmail(env: Env, data: SendMessageInput): Promise<void> {
  if (!env.EMAIL) {
    throw new HTTPException(500, { message: "email_service_not_available" });
  }

  if (!env.EMAIL_FROM) {
    throw new HTTPException(500, { message: "env.EMAIL_FROM_not_configured" });
  }

  const verifyUrl = `https://api.301.st/auth/verify?token=${data.token}`;
  const subject = getEmailSubject(data.template);
  const body = getEmailBody(data.template, verifyUrl);

  await env.EMAIL.send({
    to: data.identifier,
    from: env.EMAIL_FROM,
    subject,
    text: body,
  });
}

function getEmailSubject(template?: string): string {
  switch (template) {
    case "login":
      return "Login Confirmation — 301.st";
    case "reset":
      return "Password Reset — 301.st";
    case "invite":
      return "Invitation to 301.st";
    case "action":
      return "Action Confirmation — 301.st";
    default:
      return "Email Verification — 301.st";
  }
}

function getEmailBody(template: string | undefined, url: string): string {
  switch (template) {
    case "reset":
      return `Для восстановления пароля перейдите по ссылке:\n${url}\n\n301.st`;
    case "login":
      return `Для входа нажмите ссылку:\n${url}\n\n301.st`;
    case "invite":
      return `Вас пригласили в аккаунт 301.st:\n${url}\n\n301.st`;
    case "action":
      return `Подтвердите действие:\n${url}\n\n301.st`;
    default:
      return `Подтвердите ваш email:\n${url}\n\n301.st`;
  }
}

// TELEGRAM DELIVERY (BOT API) — TOKEN через SECRET
async function sendTelegram(env: Env, data: SendMessageInput): Promise<void> {
  if (!env.TG_BOT_TOKEN) {
    throw new HTTPException(500, { message: "env.TG_BOT_TOKEN_missing" });
  }

  if (!data.code) {
    throw new HTTPException(500, { message: "otp_required_for_telegram" });
  }

  const apiUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  const message = getTelegramMessage(data);

  await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: data.identifier,
      text: message,
    }),
  });
}

function getTelegramMessage(data: SendMessageInput): string {
  switch (data.template) {
    case "login":
      return `Ваш код входа: ${data.code}`;
    case "reset":
      return `Код для восстановления: ${data.code}`;
    case "invite":
      return `Вас пригласили в 301.st. Код подтверждения: ${data.code}`;
    case "action":
      return `Подтверждение действия: ${data.code}`;
    default:
      return `Код подтверждения: ${data.code}`;
  }
}

// SMS DELIVERY (готов под реального провайдера)
async function sendSms(env: Env, data: SendMessageInput): Promise<void> {
  if (!env.SMS_ENDPOINT) {
    throw new HTTPException(500, { message: "env.SMS_ENDPOINT_not_configured" });
  }

  if (!env.SMS_API_KEY) {
    throw new HTTPException(500, { message: "env.SMS_API_KEY_missing" });
  }

  if (!data.code) {
    throw new HTTPException(400, { message: "otp_required_for_sms" });
  }

  await fetch(env.SMS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.SMS_API_KEY,
    },
    body: JSON.stringify({
      to: data.identifier,
      code: data.code,
      sender: env.SMS_SENDER_ID ?? "301",
    }),
  });
}

