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
          <!-- Logo -->
          <tr>
            <td style="padding: 40px 40px 24px; text-align: center;">
              <svg width="128" height="52" viewBox="0 0 128 52" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#a)" fill="#5e8bff"><path d="M67.737.518c2.009-.27 6.787-.07 8.999-.1 3.076.156 6.362-.236 9.41.124 7.247.857 12.361 5.53 15.024 11.902-2.644.037-6.263-.262-8.825.214-.353.066-.901.57-1.18.827-1.397-1.522-3.214-2.92-5.288-3.336-2.97-.598-6.207-.198-9.238-.277-2.16.026-4.352-.052-6.506.023-16.322.574-16.683 30.553-.326 31.312 2.47.114 5.143.045 7.63.041 2.661-.004 5.545.101 8.187-.075 2.592-.306 3.873-1.038 5.91-2.498.364.329.862.623 1.28.89 2.64.122 5.772.035 8.444.028-2.513 5.653-7.534 10.384-13.846 11.278-2.67.378-6.016.163-8.688.178-7.303.04-14.721.703-20.814-4.187-11.364-8.56-12.828-27.08-4.617-38.243 3.39-4.608 8.821-7.32 14.444-8.097z"/><path d="M127.933 16.243c-.027-.566-.071-1.137-.316-1.655-1.556-.604-13.762-.43-16.146-.355-5.844.183-12.659-.267-18.45.045-.78.613-1.05.974-1.108 1.995-.144 2.547.045 5.179.036 7.73-.015 3.857-.067 7.693-.045 11.549.013 1.305.348 2.018 1.794 2.051 4.058.097 8.131.047 12.19.041l21.087-.015c.458-.246.696-.445.851-.963.221-.736.202-18.332.107-20.423m-26.054 18.41h-8.226l.01-3.236c1.697-.006 12.446.286 13.222-.49.337-.337.402-.987.475-1.445l-.06-.165-.037-.092c-.239-.607-.441-.963-1.128-1.131-3.678-.898-12.198 1.821-12.357-4.322a4 4 0 0 1-.053-.518c-.237-5.505 4.788-5.152 8.723-5.05 2.345.061 4.753.063 7.1.044l-.013 3c-1.683 0-10.772-.315-11.72.4-.47.357-.52.907-.619 1.451.118.526.215 1.247.743 1.438 4.256 1.541 10.504-2.036 12.668 3.662 1.133 6.992-3.561 6.457-8.73 6.453zm24.675-13.168c-1.077-.01-5.402-.21-6.045.238.028 1.685.155 5.073.007 6.702q.054 3.02.047 6.04l-3.757.019c.002-1.477-.069-4.23.041-5.61-.153-1.305-.069-5.934.007-7.303-.763-.224-4.564-.129-5.623-.118l.004-3.257 15.331.007zM.16.056 18.616.02C29.11.006 44.87-.997 45.03 13.949c.049 4.54-.271 7.46-3.581 10.947 4.017 3.1 4.823 5.236 5 10.173.621 17.209-14.23 16.066-26.382 16.042L.142 51.047c-.028-2.162-.54-8.643.561-10.027l1.453-.127c5.34-.021 29.856 1.17 32.902-1.511 1.17-1.03 1.61-2.645 1.623-4.152.013-1.361-.424-2.624-1.408-3.596-1.083-1.072-2.59-1.591-4.07-1.848-4.81-.834-15.824-.168-21.33-.15l.005-8.994c6.86-.07 14.205.398 21.029-.127 6.659-.803 6.79-10.321-.262-10.707C20.528 9.257 10.297 9.614.15 9.773zM101.316.44c5.762.121 9.921-.936 14.706 2.76a14.2 14.2 0 0 1 5.279 9.199l-9.883.097.021-1.968-5.328.012c-1.143-4.036-2.36-6.693-4.793-10.102zm10.278 39.074h10.297l-.032 11.595h-10.254z"/></g><defs><clipPath id="a"><path fill="#fff" d="M0 0h128v51.133H0z"/></clipPath></defs></svg>
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding: 0 40px 20px; text-align: center;">
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
