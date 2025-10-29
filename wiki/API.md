# API — Аутентификация и Сессии

## Базовый URL

```
https://api.301.st/auth
```

---

# 📘 POST /auth/register — Регистрация пользователя (расширенная версия)

**Описание:**
Создаёт нового пользователя в D1, выполняет проверку Cloudflare Turnstile, хэширует пароль (`bcrypt-ts`), создаёт сессию и сохраняет refresh-токен в KV.

---

## ⚙️ Алгоритм

1. **Проверка Cloudflare Turnstile** — антибот‑механизм от Cloudflare, аналог reCAPTCHA.
   Проверяет, что запрос выполнен человеком. Отправляется `token` с фронтенда на API:

   ```bash
   curl -X POST https://api.301.st/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"user@site.com","password":"secret123","turnstile_token":"..."}'
   ```

   Воркер обращается к API Turnstile:

   ```js
   const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
     method: 'POST',
     body: new URLSearchParams({
       secret: env.TURNSTILE_SECRET,
       response: body.turnstile_token
     })
   });
   ```

   При неуспешной верификации возвращается `403 Forbidden`.

2. **Валидация email и пароля** (`zod`):
   Email должен быть корректным, пароль — длиной не менее 8 символов.

3. **Проверка дубликата**:

   ```sql
   SELECT id FROM users WHERE email = ?;
   ```

   Если пользователь уже существует → `409 Conflict`.

4. **Хэширование пароля:**

   ```js
   const hash = await bcrypt.hash(password, 10);
   ```

5. **Создание пользователя:**

   ```sql
   INSERT INTO users (email, password_hash) VALUES (?, ?);
   ```

6. **Создание сессии:**

   ```sql
   INSERT INTO sessions (user_id, ip_address, user_agent) VALUES (?, ?, ?);
   ```

7. **Сохранение refresh-токена в KV:**

   ```js
   await env.KV_SESSIONS.put(`refresh:${sessionId}`, userId, { expirationTtl: 604800 });
   ```

8. **Создание JWT:**
   Access‑токен генерируется через `jose` (TTL 15 минут), добавляется `kid` для проверки подписи.

9. **Ответ пользователю:**

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 900,
  "user": {
    "id": 1,
    "email": "user@site.com",
    "created_at": "2025-10-25T12:34:00Z"
  }
}
```

**Set-Cookie:**

```
refresh_id=<uuid>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
```

---

## 🔁 Поток регистрации (Mermaid)

```mermaid
sequenceDiagram
    participant U as 👤 Пользователь (Webstudio)
    participant A as ⚙️ API Worker (api.301.st)
    participant D as 🗄️ D1 (users/sessions)
    participant K as 🔑 KV (KV_SESSIONS)
    participant T as 🧩 Turnstile API

    U->>A: POST /auth/register (email, password, token)
    A->>T: Verify Turnstile token
    T-->>A: OK / Error
    alt valid
        A->>D: SELECT * FROM users WHERE email=?
        alt not found
            A->>A: bcrypt.hash(password)
            A->>D: INSERT user(email, hash)
            A->>D: INSERT session(user_id, ip, agent)
            A->>K: PUT refresh:<sessionId>
            A-->>U: JWT + cookie(refresh_id)
        else exists
            A-->>U: 409 Conflict (User exists)
        end
    else invalid
        A-->>U: 403 Forbidden (Bot detected)
    end
```

---

## POST /auth/login — Авторизация пользователя

**Описание:**
Проверяет email и пароль, создаёт новую сессию и выдаёт токены.

### Параметры запроса

| Поле       | Тип    | Обязательно | Описание           |
| ---------- | ------ | ----------- | ------------------ |
| `email`    | string | ✅           | Email пользователя |
| `password` | string | ✅           | Пароль             |

### Пример запроса

```bash
curl -i -X POST https://api.301.st/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@site.com","password":"secret123"}'
```

### Пример ответа (200 OK)

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 900,
  "user": {
    "id": 1,
    "email": "user@site.com",
    "name": "User"
  }
}
```

---

## POST /auth/refresh — Обновление токена

**Описание:**
Проверяет `refresh_id` в cookie или теле запроса, создаёт новый `access_token` и ротацию refresh-токена.

### Заголовки

```
Cookie: refresh_id=<uuid>
```

### Пример запроса

```bash
curl -X POST https://api.301.st/auth/refresh \
  -H "Cookie: refresh_id=fc5b2c90-bd0a-42b1-8043-0f02e7b87abf"
```

### Пример ответа (200 OK)

```json
{
  "access_token": "<new_JWT>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

**Set-Cookie:**

```
refresh_id=<new_uuid>; HttpOnly; Secure; SameSite=Lax; Path=/;
```

---

## GET /auth/me — Проверка текущего пользователя

**Описание:**
Возвращает информацию о пользователе по `access_token`.

### Заголовки

```
Authorization: Bearer <access_token>
```

### Пример запроса

```bash
curl -X GET https://api.301.st/auth/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

### Пример ответа (200 OK)

```json
{
  "user": {
    "id": 1,
    "email": "user@site.com",
    "role": "user",
    "created_at": "2025-10-25T12:34:00Z"
  }
}
```

---

## POST /auth/logout — Завершение сессии

**Описание:**
Удаляет refresh-токен из KV, помечает сессию как отозванную в D1 и очищает cookie.

### Заголовки

```
Cookie: refresh_id=<uuid>
```

### Пример запроса

```bash
curl -X POST https://api.301.st/auth/logout \
  -H "Cookie: refresh_id=fc5b2c90-bd0a-42b1-8043-0f02e7b87abf"
```

### Пример ответа (204 No Content)

```
Set-Cookie: refresh_id=; Max-Age=0; Path=/;
```

---

## OAuth 2.0 — Google Sign-In

### Шаг 1. Старт OAuth

```bash
GET https://api.301.st/auth/google/start
```

Перенаправляет пользователя на Google OAuth.

### Шаг 2. Callback

```bash
GET https://api.301.st/auth/google/callback?code=...&state=...
```

Worker:

* Проверяет `state` в KV;
* Обменивает `code → id_token`;
* Создаёт или находит пользователя в D1;
* Возвращает `access_token` и cookie.

---

## Swagger-сводка


| Метод  | Путь                    | Назначение                      | Авторизация | Хранилище | Ответ          |
| ------ | ----------------------- | ------------------------------- | ----------- | --------- | -------------- |
| `POST` | `/auth/register`        | Регистрация нового пользователя | ❌           | D1 + KV   | 201 Created    |
| `POST` | `/auth/login`           | Вход по email и паролю          | ❌           | D1 + KV   | 200 OK         |
| `POST` | `/auth/refresh`         | Обновление Access Token         | ✅ cookie    | KV        | 200 OK         |
| `GET`  | `/auth/me`              | Проверка текущего пользователя  | ✅ Bearer    | D1        | 200 OK         |
| `POST` | `/auth/logout`          | Завершение сессии               | ✅ cookie    | KV + D1   | 204 No Content |
| `GET`  | `/auth/google/start`    | Запуск OAuth Google             | ❌           | KV        | 302 Redirect   |
| `GET`  | `/auth/google/callback` | Callback от Google              | ❌           | D1 + KV   | 200 OK / 302   |

---

## Поток аутентификации (Mermaid)

```mermaid
sequenceDiagram
    participant U as 👤 Пользователь (Webstudio)
    participant A as ⚙️ API Worker (api.301.st)
    participant D as 🗄️ D1 (users/sessions)
    participant K as 🔑 KV (KV_SESSIONS)
    participant G as 🌐 Google OAuth

    %% Регистрация
    U->>A: POST /auth/register (email, password)
    A->>D: INSERT user(email, hash)
    A->>K: PUT refresh:<sessionId>
    A-->>U: access_token + cookie(refresh_id)

    %% Логин
    U->>A: POST /auth/login
    A->>D: SELECT user(email)
    A->>K: PUT refresh:<sessionId>
    A-->>U: access_token + cookie(refresh_id)

    %% OAuth вход
    U->>A: GET /auth/google/start
    A-->>U: 302 Redirect → Google OAuth
    U->>G: Авторизация Google
    G-->>A: /auth/google/callback?code&state
    A->>K: GET oauth_state:<uuid>
    A->>D: UPSERT user(email, google_sub)
    A->>K: PUT refresh:<sessionId>
    A-->>U: access_token + cookie(refresh_id)

    %% Refresh
    U->>A: POST /auth/refresh (cookie)
    A->>K: GET refresh:<sessionId>
    A->>K: PUT refresh:<newId>
    A-->>U: new access_token + cookie(newId)

    %% Logout
    U->>A: POST /auth/logout (cookie)
    A->>K: DELETE refresh:<sessionId>
    A->>D: UPDATE sessions SET revoked=1
    A-->>U: Cookie cleared
```

