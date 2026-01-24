// src/api/lib/message_sender.ts
/**
 * Обертка для отправки сообщений по разным каналам
 * Единая точка входа, используемая в auth endpoints
 */

import { HTTPException } from "hono/http-exception";
import { sendEmailOutgoing } from "./messaging/email_outgoing";
import { sendTelegram } from "./messaging/telegram";
import { sendSms } from "./messaging/sms";

type DeliveryChannel = "email" | "telegram" | "sms";

export interface SendMessageInput {
  channel: DeliveryChannel;
  identifier: string;         // email / phone / tg_id
  token: string;              // omni token
  code?: string;              // OTP код (для TG/SMS)
  template?: "verify" | "login" | "reset" | "invite" | "action";
  origin?: string;
  lang?: "ru" | "en";         // язык письма
}

/**
 * Главная точка входа для отправки сообщений
 * Роутер по каналам доставки
 */
export async function sendOmniMessage(
  env: Env,
  data: SendMessageInput
): Promise<void> {
  switch (data.channel) {
    case "email":
      return await sendEmailOutgoing(env, data);

    case "telegram":
      return await sendTelegram(env, data);

    case "sms":
      return await sendSms(env, data);

    default:
      throw new HTTPException(400, { message: "unsupported_channel" });
  }
}

