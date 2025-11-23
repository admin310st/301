// src/api/lib/messaging/templates.ts
/**
 * Email templates для исходящих писем
 * Поддержка мультиязычности (сейчас только ru, готово к расширению)
 */

interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

/**
 * Получить email шаблон
 * @param type тип письма (verify, reset, login, invite, action)
 * @param token omni token для verify URL
 * @param env Worker environment
 * @param lang язык (по умолчанию ru, готово к en)
 */

// src/api/lib/messaging/templates.ts

/**
 * Построение verify URL с origin параметром
 */
function buildVerifyUrl(
  token: string,
  type: string | undefined,
  env: Env,
  origin?: string // Добавили параметр origin
): string {
  const base = env.OAUTH_REDIRECT_BASE || "https://api.301.st";
  
  // Добавляем origin в query параметры
  const originParam = origin ? `&origin=${encodeURIComponent(origin)}` : '';

  if (type === "reset") {
    return `${base}/auth/verify?type=reset&token=${token}${originParam}`;
  }

  return `${base}/auth/verify?token=${token}${originParam}`;
}

/**
 * Получить email шаблон
 */
export function getEmailTemplate(
  type: string | undefined,
  token: string,
  env: Env,
  lang: string = "ru",
  origin?: string // ✅ Добавили параметр origin
): EmailTemplate {
  const verifyUrl = buildVerifyUrl(token, type, env, origin); // Передаём origin

  switch (type) {
    case "reset":
      return {
        subject: "Восстановление пароля — 301.st",
        text: `Для восстановления пароля перейдите по ссылке:\n${verifyUrl}\n\nЕсли вы не запрашивали восстановление пароля, проигнорируйте это письмо.\n\n301.st`,
        html: getResetPasswordHTML(verifyUrl),
      };

    case "verify":
    default:
      return {
        subject: "Подтверждение email — 301.st",
        text: `Подтвердите ваш email:\n${verifyUrl}\n\n301.st`,
        html: getVerifyEmailHTML(verifyUrl),
      };
  }
}

// ============================================
// HTML Templates
// ============================================

function getVerifyEmailHTML(url: string): string {
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
                Подтвердите ваш email
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              <p style="margin: 0 0 16px;">Добро пожаловать в 301.st!</p>
              <p style="margin: 0;">Нажмите кнопку ниже, чтобы подтвердить ваш email и активировать аккаунт:</p>
            </td>
          </tr>
          
          <!-- Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${url}" style="display: inline-block; padding: 14px 40px; background-color: #0066ff; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                Подтвердить email
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">Или скопируйте эту ссылку в браузер:</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${url}" style="color: #0066ff; text-decoration: none;">${url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                Ссылка действительна 15 минут.<br>
                Если вы не регистрировались на 301.st, проигнорируйте это письмо.
              </p>
            </td>
          </tr>
        </table>
        
        <!-- Brand Footer -->
        <table width="600" cellpadding="0" cellspacing="0" style="margin-top: 20px;">
          <tr>
            <td style="text-align: center; color: #999; font-size: 14px;">
              <p style="margin: 0;">© 2025 301.st — Domain & Traffic Management Platform</p>
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

function getResetPasswordHTML(url: string): string {
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
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h1 style="margin: 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
                Восстановление пароля
              </h1>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              <p style="margin: 0 0 16px;">Вы запросили восстановление пароля для вашего аккаунта 301.st.</p>
              <p style="margin: 0;">Нажмите кнопку ниже, чтобы создать новый пароль:</p>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${url}" style="display: inline-block; padding: 14px 40px; background-color: #ff4d4d; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                Восстановить пароль
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">Или скопируйте эту ссылку в браузер:</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${url}" style="color: #ff4d4d; text-decoration: none;">${url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                Ссылка действительна 15 минут.<br>
                <strong>Если вы не запрашивали восстановление пароля, проигнорируйте это письмо.</strong>
              </p>
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

function getLoginHTML(url: string): string {
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
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h1 style="margin: 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
                Подтверждение входа
              </h1>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              <p style="margin: 0;">Для входа в ваш аккаунт 301.st нажмите кнопку ниже:</p>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${url}" style="display: inline-block; padding: 14px 40px; background-color: #0066ff; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                Войти в аккаунт
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">Или скопируйте эту ссылку в браузер:</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${url}" style="color: #0066ff; text-decoration: none;">${url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                Ссылка действительна 15 минут.
              </p>
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

function getInviteHTML(url: string): string {
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
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h1 style="margin: 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
                Приглашение в команду
              </h1>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              <p style="margin: 0 0 16px;">Вас пригласили присоединиться к аккаунту 301.st.</p>
              <p style="margin: 0;">Нажмите кнопку ниже, чтобы принять приглашение:</p>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${url}" style="display: inline-block; padding: 14px 40px; background-color: #00cc66; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                Принять приглашение
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">Или скопируйте эту ссылку в браузер:</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${url}" style="color: #00cc66; text-decoration: none;">${url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                Ссылка действительна 15 минут.
              </p>
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

function getActionHTML(url: string): string {
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
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h1 style="margin: 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">
                Подтверждение действия
              </h1>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 30px; color: #666; font-size: 16px; line-height: 1.6;">
              <p style="margin: 0;">Для подтверждения действия нажмите кнопку ниже:</p>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${url}" style="display: inline-block; padding: 14px 40px; background-color: #ff9900; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 16px;">
                Подтвердить
              </a>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e5e5; color: #999; font-size: 14px; line-height: 1.5;">
              <p style="margin: 0 0 10px;">Или скопируйте эту ссылку в браузер:</p>
              <p style="margin: 0; word-break: break-all; color: #666;">
                <a href="${url}" style="color: #ff9900; text-decoration: none;">${url}</a>
              </p>
              <p style="margin: 20px 0 0; color: #999;">
                Ссылка действительна 15 минут.
              </p>
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
