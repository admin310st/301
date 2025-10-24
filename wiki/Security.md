#  Безопасность и аутентификация в 301.st

## Введение

Система 301.st использует многоуровневую архитектуру безопасности:

* **Edge-уровень (Cloudflare Workers)** — фильтрация, проверка токенов, выдача сессий.
* **D1 (SQL)** — хранение пользователей и аудита.
* **KV** — хранение временных refresh-токенов и OAuth состояний.
* **R2** — резервное копирование логов и архивов.

Для аутентификации применяются два метода:

1. **Classic Auth** — email + пароль.
2. **OAuth 2.0 (Google Sign-In)** — безопасный вход через аккаунт Google.

Все запросы выполняются исключительно по HTTPS, все чувствительные данные передаются в защищённых cookie (`HttpOnly`, `Secure`, `SameSite=Lax`).

---

##  0. Подготовка

1. Зарегистрировать проект в **Google Cloud Console → OAuth 2.0 Client ID**
2. Redirect URI:

   ```
   https://api.301.st/auth/google/callback
   ```
3. Сохранить параметры в **Workers Secrets**:

   * `GOOGLE_CLIENT_ID`
   * `GOOGLE_CLIENT_SECRET`

---

##  1. Регистрация (Classic Sign-Up)

**Поток:**

1. Пользователь заполняет форму (`email + password`) на Webstudio.
2. Фронт отправляет запрос:

   ```http
   POST /auth/register
   Content-Type: application/json
   {"email":"user@site.com","password":"secret123"}
   ```
3. Worker:

   * проверяет Turnstile (антибот);
   * проверяет уникальность e-mail (D1);
   * хэширует пароль:

     ```js
     const hash = await bcrypt.hash(password, 10);
     ```
   * сохраняет запись пользователя:

     ```sql
     INSERT INTO users (email, password_hash) VALUES (?, ?);
     ```
4. Создаёт refresh-токен, сохраняет в KV:

   ```js
   await env.KV_SESSIONS.put(`refresh:${sessionId}`, userId, { expirationTtl: 604800 });
   ```
5. Отправляет пользователю:

   * `access_token` (JWT, TTL 15 мин);
   * cookie:

     ```
     Set-Cookie: refresh_id=<sessionId>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
     ```

---

##  2. Логин (Classic Sign-In)

1. `POST /auth/login` (email, пароль)
2. Worker:

   * находит пользователя в D1;
   * сверяет хэш;
   * создаёт новую сессию в D1;
   * генерирует `access_token` и `refresh_id`.
3. Устанавливает cookie `refresh_id`.

---

##  3. OAuth Google Sign-In

### Шаг 1. Инициация

Фронт вызывает:

```js
window.location.href = "https://api.301.st/auth/google/start";
```

### Шаг 2. Перенаправление на Google

Worker:

```js
const redirect = new URL("https://accounts.google.com/o/oauth2/v2/auth");
redirect.search = new URLSearchParams({
  client_id: env.GOOGLE_CLIENT_ID,
  redirect_uri: "https://api.301.st/auth/google/callback",
  response_type: "code",
  scope: "openid email profile",
  state: crypto.randomUUID(),
});
await env.KV_SESSIONS.put(`oauth_state:${state}`, "1", { expirationTtl: 300 });
return Response.redirect(redirect.toString(), 302);
```

### Шаг 3. Callback от Google

```
GET /auth/google/callback?code=...&state=...
```

Worker:

1. проверяет `state` в KV;
2. обменивает `code` → `id_token`:

   ```js
   const token = await fetch("https://oauth2.googleapis.com/token", {...});
   ```
3. декодирует `id_token` → получает `email`, `name`, `sub`.

### Шаг 4. Проверка / создание пользователя

```js
const user = await env.DB301.prepare(
  "SELECT * FROM users WHERE google_sub=? OR email=?"
).bind(sub, email).first();

if (!user) {
  await env.DB301.prepare(
    "INSERT INTO users (email, google_sub, name) VALUES (?, ?, ?)"
  ).bind(email, sub, name).run();
}
```

### Шаг 5. Создание сессии

* создаётся `session` в D1;
* генерируются `access_token` (15 мин) и `refresh_id` (в KV, 7 дней);
* устанавливается cookie `refresh_id`;
* пользователь перенаправляется в панель 301.st.

---

##  4. Обновление токена (Refresh Flow)

1. `POST /auth/refresh`
2. Worker:

   * проверяет наличие `refresh:<id>` в KV;
   * если валиден — создаёт новый `access_token` и новый `refresh_id`;
   * удаляет старый refresh-токен.
3. Ответ:

   ```
   Set-Cookie: refresh_id=<new_id>; HttpOnly; Secure; SameSite=Lax; Path=/;
   ```

---

##  5. Logout / Revoke

`POST /auth/logout`

* Worker удаляет refresh-токен из KV;
* помечает сессию `revoked=1` в D1;
* очищает cookie:

  ```
  Set-Cookie: refresh_id=; Max-Age=0; Path=/;
  ```

---

##  6. Безопасность и TTL

| Объект         | Хранилище               | TTL       | Назначение               |
| -------------- | ----------------------- | --------- | ------------------------ |
| **Access JWT** | только в памяти клиента | 15 мин    | авторизация API-запросов |
| **Refresh ID** | KV + HttpOnly-cookie    | 7 дней    | продление сессии         |
| **Users**      | D1                      | постоянно | учётные записи           |
| **Sessions**   | D1                      | до отзыва | аудит и безопасность     |

---

##  7. Основные принципы защиты

* Пароли передаются только по HTTPS и хэшируются на Edge (bcrypt/scrypt).
* Токены не хранятся в `localStorage` или `sessionStorage`.
* Все cookie имеют флаги `HttpOnly`, `Secure`, `SameSite=Lax`.
* Ротация refresh-токенов при каждом обновлении (`rotation`).
* Возможность полного отзыва (`/auth/revoke_all`).
* Проверка и ротация ключей JWT (`kid`, JWKS).
* Rate-limit на `/auth/login` и `/auth/refresh`.
* Верификация пользователя через Cloudflare Turnstile.
* Логирование всех событий аутентификации (D1 + R2).

---

##  8. Диаграмма потоков

```mermaid
sequenceDiagram
    participant U as User (Webstudio)
    participant W as Cloudflare Worker
    participant G as Google OAuth
    participant D as D1 Database
    participant K as KV Store

    U->>W: POST /auth/register (email, password)
    W->>D: INSERT user(email, hash)
    W->>K: PUT refresh:sessionId
    W-->>U: access_token + cookie(refresh_id)

    U->>W: POST /auth/login (email, password)
    W->>D: SELECT user
    W->>K: PUT refresh:sessionId
    W-->>U: access_token + cookie(refresh_id)

    U->>W: GET /auth/google/start
    W-->>U: Redirect to Google OAuth
    U->>G: Google Login
    G-->>W: /auth/google/callback (code)
    W->>G: Exchange code→token
    W->>D: upsert user
    W->>K: PUT refresh:sessionId
    W-->>U: access_token + cookie(refresh_id)

    U->>W: POST /auth/refresh (cookie)
    W->>K: GET refresh:sessionId
    W-->>U: new access_token + cookie(new_id)

    U->>W: POST /auth/logout
    W->>K: DELETE refresh:sessionId
    W->>D: UPDATE sessions SET revoked=1
    W-->>U: Cookie cleared
```

#  Security_Credentials

##  Назначение

Хранение и использование пользовательских API-ключей и других чувствительныех данных при взаимодействии с внешними сервисами (Cloudflare, регистраторы, аналитика и т.д.).

---

##  Общие принципы

1. **Ключи пользователей никогда не хранятся в открытом виде.**
2. **Secrets (Workers Secrets)** содержат только глобальные ключи проекта 301.st (например `MASTER_SECRET`), задаваемые разработчиком вручную через `wrangler secret put`.
3. Все пользовательские токены и API-ключи сохраняются только в **KV-хранилище** — в зашифрованном виде.
4. **D1 (SQL)** хранит только метаданные: тип ключа, статус, и ссылку на запись в KV.
5. Шифрование выполняется на Edge при помощи **AES-GCM (256 bit)** с использованием мастер-ключа из `Secrets`.

---

##  Архитектура хранения

| Слой | Хранилище               | Назначение                                        |
| ---- | ----------------------- | ------------------------------------------------- |
| 1  | **D1**                  | Метаданные (account_id, provider, kv_key, статус) |
| 2  | **KV (KV_CREDENTIALS)** | Зашифрованные токены и ключи                      |
| 3  | **Secrets (Workers)**   | Мастер-ключ шифрования `MASTER_SECRET`            |

---

##  Поток записи ключа

```mermaid
sequenceDiagram
    participant U as User (Frontend)
    participant A as API Worker (api.301.st)
    participant K as KV (KV_CREDENTIALS)
    participant D as D1 (account_keys)

    U->>A: POST /accounts/keys (apiKey)
    A->>A: encryptAES(apiKey, MASTER_SECRET)
    A->>K: PUT cred:cloudflare:UUID (encrypted)
    A->>D: INSERT account_keys(provider, kv_key)
    A-->>U: ✅ "Ключ сохранён"
```

---

## Поток использования ключа

```mermaid
sequenceDiagram
    participant A as API Worker (api.301.st)
    participant K as KV (KV_CREDENTIALS)
    participant D as D1 (account_keys)
    participant CF as Cloudflare API

    A->>D: SELECT kv_key FROM account_keys WHERE provider='cloudflare'
    A->>K: GET cred:cloudflare:UUID
    A->>A: decryptAES(cipher, MASTER_SECRET)
    A->>CF: PUT /zones/... (Bearer apiKey)
    CF-->>A: 200 OK
```

---

## Безопасность и политика хранения

| Механизм                  | Описание                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| 🔸 **Шифрование на Edge** | AES-GCM 256 bit, ключ хранится только в Secrets                      |
| 🔸 **TTL / Rotation**     | Поддержка сроков действия и ротации ключей                           |
| 🔸 **Аудит**              | Все операции (создание, чтение, отзыв) логируются в D1 (`audit_log`) |
| 🔸 **Изоляция данных**    | Каждая запись привязана к `account_id` (multi-tenant)                |
| 🔸 **Удаление**           | При удалении аккаунта все KV-записи (`cred:*`) очищаются             |

---

## Поток акцепта команд

Когда пользователь инициирует операцию (например, деплой правил редиректа), система действует так:

1. API Worker создаёт запись в `tasks` (статус `pending`) и сохраняет JSON с изменениями.
2. Пользователь нажимает **Акцепт**, после чего воркер:

   * извлекает зашифрованный токен из KV;
   * расшифровывает его через `MASTER_SECRET`;
   * выполняет действие в Cloudflare API.
3. После успешного ответа задача помечается как `completed`, ключ в памяти уничтожается.

```mermaid
sequenceDiagram
    participant U as User
    participant A as API Worker
    participant K as KV
    participant D as D1
    participant CF as Cloudflare API

    U->>A: POST /actions/create
    A->>D: INSERT task (status=pending)
    U->>A: POST /actions/confirm/:id
    A->>K: GET cred:cloudflare:UUID
    A->>A: decryptAES(...)
    A->>CF: PUT /zones/.../rulesets
    CF-->>A: 200 OK
    A->>D: UPDATE task SET status='completed'
```

---

## ✅ Итоговые принципы

* Пользовательские API-ключи **никогда не хранятся в Secrets**.
* Хранятся в **KV** только в зашифрованном виде.
* Расшифровка и использование происходят **только на Edge** в момент вызова API.
* Все действия фиксируются в D1 для аудита и восстановления истории.

