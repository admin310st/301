// src/api/lib/messaging/templates.ts
/**
 * Email templates для исходящих писем
 * Поддержка мультиязычности через i18n
 */

import { t, type Lang } from "./i18n";

interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

type TemplateType = "verify" | "reset" | "login" | "invite" | "action";

// Цвета кнопок для разных типов писем
const buttonColors: Record<TemplateType, string> = {
  verify: "#0066ff",
  reset: "#ff4d4d",
  login: "#0066ff",
  invite: "#00cc66",
  action: "#ff9900",
};

/**
 * Построение verify URL
 */
function buildVerifyUrl(
  token: string,
  type: TemplateType,
  origin?: string
): string {
  const base = origin || "https://301.st";

  if (type === "reset") {
    return `${base}/auth/verify?type=reset&token=${token}`;
  }

  return `${base}/auth/verify?token=${token}`;
}

/**
 * Получить email шаблон
 * @param type тип письма (verify, reset, login, invite, action)
 * @param token omni token для verify URL
 * @param env Worker environment
 * @param lang язык (по умолчанию en)
 * @param origin домен фронтенда откуда пришёл запрос
 */
export function getEmailTemplate(
  type: string | undefined,
  token: string,
  env: Env,
  lang: Lang = "en",
  origin?: string
): EmailTemplate {
  const templateType: TemplateType = (type as TemplateType) || "verify";
  const verifyUrl = buildVerifyUrl(token, templateType, origin);

  const subject = t(`email:${templateType}:subject`, lang);
  const title = t(`email:${templateType}:title`, lang);
  const body = t(`email:${templateType}:body`, lang);
  const button = t(`email:${templateType}:button`, lang);
  const linkHint = t(`email:${templateType}:link_hint`, lang);
  const expires = t(`email:${templateType}:expires`, lang);
  const ignore = t(`email:${templateType}:ignore`, lang);
  const welcome = templateType === "verify" ? t(`email:verify:welcome`, lang) : null;
  const footer = t("email:common:footer", lang);

  // Plain text version
  const textParts = [
    title,
    "",
    welcome,
    body,
    "",
    verifyUrl,
    "",
    expires,
    ignore,
    "",
    footer,
  ].filter(Boolean);

  const text = textParts.join("\n");

  // HTML version
  const html = buildEmailHTML({
    title,
    welcome,
    body,
    button,
    buttonColor: buttonColors[templateType],
    url: verifyUrl,
    linkHint,
    expires,
    ignore,
    footer,
  });

  return { subject, text, html };
}

interface EmailHTMLParams {
  title: string;
  welcome: string | null;
  body: string;
  button: string;
  buttonColor: string;
  url: string;
  linkHint: string;
  expires: string;
  ignore?: string;
  footer: string;
}

function buildEmailHTML(params: EmailHTMLParams): string {
  const welcomeHtml = params.welcome
    ? `<p style="margin: 0 0 16px;">${params.welcome}</p>`
    : "";

  const ignoreHtml = params.ignore
    ? `<br>${params.ignore}`
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h1 style="margin: 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
                ${params.title}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              ${welcomeHtml}
              <p style="margin: 0;">${params.body}</p>
            </td>
          </tr>

          <!-- Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${params.url}" style="display: inline-block; padding: 14px 40px; background-color: ${params.buttonColor}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                ${params.button}
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">${params.linkHint}</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${params.url}" style="color: ${params.buttonColor}; text-decoration: none;">${params.url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                ${params.expires}${ignoreHtml}
              </p>
            </td>
          </tr>
        </table>

        <!-- Brand Footer -->
        <table width="600" cellpadding="0" cellspacing="0" style="margin-top: 20px;">
          <tr>
            <td style="text-align: center; color: #999; font-size: 14px;">
              <p style="margin: 0;">${params.footer}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}
