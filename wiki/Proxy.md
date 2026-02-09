# mail.301.st — Руководство по эксплуатации

Сервер настроен и работает. Ниже — все данные доступа, архитектура и инструкции по управлению.

---

## Доступ к серверу

```bash
ssh -i server_key deploy@51.68.21.133 -p 2222
```

> Root-логин и вход по паролю отключены. Доступ только через ключ, только пользователь `deploy` с sudo.

### SSH-ключ (ed25519)

Приватный ключ (`server_key`):

```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAk/GE4xErbEzBJI0gyBIPOgYmzP7WO/jo8respDB4DWgAAAKAgbk2DIG5N
gwAAAAtzc2gtZWQyNTUxOQAAACAk/GE4xErbEzBJI0gyBIPOgYmzP7WO/jo8respDB4DWg
AAAEBGQyGWE4/ApUk4OFA9kfb+DfIjHxLvyKOsP05Oh1Z9eiT8YTjEStsTMEkjSDIEg86B
ibM/tY7+Ojyt6ykMHgNaAAAAGGNsYXVkZS1jb2RlQHNlcnZlci1zZXR1cAECAwQF
-----END OPENSSH PRIVATE KEY-----
```

Публичный ключ (`server_key.pub`):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICT8YTjEStsTMEkjSDIEg86BibM/tY7+Ojyt6ykMHgNa claude-code@server-setup
```

Для подключения: сохранить приватный ключ в файл, выставить права `chmod 600 server_key`, затем:

```bash
ssh -i server_key deploy@51.68.21.133 -p 2222
```

---

## Веб-интерфейсы

| Сервис | URL | Логин | Пароль |
|---|---|---|---|
| Mailcow (админка) | https://mail.301.st | `admin` | `<MAILCOW_ADMIN_PASS>` |
| Mailcow (SOGo webmail) | https://mail.301.st/SOGo/ | `admin@301.st` | `<MAILCOW_SOGO_PASS>` |
| Postal (транзакционные) | https://postal.301.st | `admin@301.st` | `<POSTAL_ADMIN_PASS>` |
| Лендинг RU | https://ru.301.st | — | — |

### Почтовые ящики (Mailcow)

| Ящик | Пароль |
|---|---|
| `admin@301.st` | `<MAILBOX_ADMIN_PASS>` |
| `postmaster@301.st` | `<MAILBOX_POSTMASTER_PASS>` |
| `abuse@301.st` | `<MAILBOX_ABUSE_PASS>` |

---

## Архитектура

```
mail.301.st (Ubuntu 22.04, 8 GB RAM, 3 vCPU, 50 GB SSD)
│
├── Traefik v3 (reverse proxy, SSL Let's Encrypt)
│   ├── mail.301.st         → Mailcow nginx (HTTPS, порт 8444, insecureSkipVerify)
│   ├── ru.301.st           → Nginx-static (лендинг RU)
│   ├── postal.301.st       → Postal web (порт 5000)
│   ├── relay.301.st        → api.namecheap.com (reverse proxy, Basic Auth)
│   ├── autodiscover.301.st → Mailcow
│   └── autoconfig.301.st   → Mailcow
│
├── Mailcow (18 контейнеров)
│   ├── Postfix (SMTP, порт 25/465/587)
│   ├── Dovecot (IMAP, порт 993)
│   ├── SOGo 5.12.4 (webmail), Rspamd, ClamAV
│   └── MySQL, Redis, PHP-FPM, Nginx
│
├── Postal 3.3.5 (3 контейнера + MariaDB)
│   ├── Web (bridge, в сети proxy)
│   ├── SMTP (host, порт 2525)
│   ├── Worker (host)
│   └── MariaDB (127.0.0.1:3306)
│
├── Nginx-static (landing-ru)
│   └── nginx:alpine + статика
│
├── Traefik API Relay (relay.301.st)
│   └── Reverse proxy → api.namecheap.com (Basic Auth + passHostHeader: false)
│
└── Squid (API proxy, порт 8443) — DEPRECATED, заменён на Traefik relay
    └── Whitelist: namecheap.com, namesilo.com
```

---

## Управление сервисами

### Mailcow

```bash
cd /opt/mailcow-dockerized

# Статус
docker compose ps

# Перезапуск
docker compose restart

# Остановка / запуск
docker compose down
docker compose up -d

# Обновление Mailcow
./update.sh

# Логи
docker compose logs -f --tail=50
docker compose logs -f postfix-mailcow    # логи конкретного сервиса
```

### Postal

```bash
cd /opt/postal/install

# Статус
docker compose -p postal ps

# Запуск / остановка / перезапуск
docker compose -p postal up -d
docker compose -p postal down
docker compose -p postal restart

# Логи
docker compose -p postal logs -f
docker compose -p postal logs -f web    # конкретный сервис

# Создать нового админа (из web-контейнера, т.к. runner не имеет доступа к БД)
# Проще через SQL:
HASH=$(docker compose -p postal exec -T web ruby -e "require 'bcrypt'; puts BCrypt::Password.create('NewPassword123!')")
docker exec postal-mariadb mariadb -uroot -p$(cat /opt/postal/.db_password) postal \
  -e "INSERT INTO users (email_address, first_name, last_name, password_digest, admin) VALUES ('new@301.st','First','Last','${HASH}',1);"
```

### Traefik

```bash
cd /opt/traefik

docker compose restart
docker compose logs -f
```

### Лендинг

```bash
cd /opt/landing

# Ручное обновление
webstudio sync
webstudio build --template ssg
docker restart landing-ru

# Автообновление: cron каждый день в 3:00 UTC
```

### Traefik API Relay (relay.301.st)

Relay-маршрут настроен в том же Traefik (`/opt/traefik/dynamic.yml`). Отдельный контейнер не нужен.

```bash
# Проверить работоспособность relay
curl -sk -u apiuser:PASSWORD https://relay.301.st/xml.response?ApiUser=USER&ApiKey=KEY&UserName=USER&ClientIp=51.68.21.133&Command=namecheap.users.getBalances

# Перезапуск (вместе со всем Traefik)
cd /opt/traefik
docker compose restart
```

### Squid — DEPRECATED

> Squid forward proxy (`cf.proxy`) заменён на Traefik relay.
> Причина: `cf.proxy` не работает в Cloudflare Workers для HTTP-проксирования.
> Контейнер можно остановить и удалить.

```bash
cd /opt/squid
docker compose down
```

---

## Порты

| Порт | Сервис | Доступ |
|---|---|---|
| 2222 | SSH | Внешний (только ключ) |
| 25 | SMTP (Mailcow) | Внешний |
| 465 | SMTPS (Mailcow) | Внешний |
| 587 | SMTP Submission (Mailcow) | Внешний |
| 993 | IMAPS (Mailcow) | Внешний |
| 80 | HTTP → HTTPS (Traefik) | Внешний |
| 443 | HTTPS (Traefik) | Внешний |
| 2525 | SMTP (Postal) | Host only |
| 5000 | Postal Web UI | Через Traefik |
| 443 | Traefik relay (relay.301.st) | Внешний (Basic Auth) |
| 8443 | Squid Proxy (DEPRECATED) | Внешний (с auth) |

---

## Учётные данные сервисов

### Mailcow API

```
API Key: <MAILCOW_API_KEY>
```

Пример использования:

```bash
# Список доменов
curl -s -k -X GET 'https://mail.301.st/api/v1/get/domain/all' \
  -H 'X-API-Key: <MAILCOW_API_KEY>'

# Список почтовых ящиков
curl -s -k -X GET 'https://mail.301.st/api/v1/get/mailbox/all' \
  -H 'X-API-Key: <MAILCOW_API_KEY>'
```

### Traefik API Relay

```
URL:      https://relay.301.st
User:     apiuser
Password: <RELAY_AUTH_PASS>
```

Использование из Cloudflare Workers:
```typescript
// Worker делает обычный fetch к relay, Traefik проксирует к api.namecheap.com
const res = await fetch("https://relay.301.st/xml.response?ApiUser=...&Command=...", {
  method: "GET",
  headers: { Authorization: "Basic <RELAY_AUTH_BASE64>" },
});
```

> **Почему relay вместо Squid?**
> `cf.proxy` в `fetch()` — это внутренний механизм Cloudflare для routing между зонами, **не** HTTP forward proxy. Worker с `cf.proxy` получал 500 от Squid или ошибку IP от Namecheap. Прямой curl через Squid работал, но из Workers — нет. Traefik relay решает это: Worker делает обычный `fetch()` → Traefik reverse-proxy передаёт запрос на `api.namecheap.com` с `Host: api.namecheap.com` (passHostHeader: false) → IP сервера (51.68.21.133) whitelisted в Namecheap.

### Squid API Proxy — DEPRECATED

```
URL:      http://51.68.21.133:8443
User:     apiuser
Password: <SQUID_AUTH_PASS>
```

> Оставлен для справки. Заменён на Traefik relay (см. выше).

### Postal MariaDB

```
Host:     127.0.0.1:3306 (только с сервера)
User:     root
Password: <POSTAL_DB_PASS>
Database: postal
```

### Postal API (для Workers)

После настройки организации и сервера в Postal UI, получить API-ключ и использовать:

```typescript
const res = await fetch("https://postal.301.st/api/v1/send/message", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Server-API-Key": env.POSTAL_API_KEY,
  },
  body: JSON.stringify({
    to: ["user@example.com"],
    from: "noreply@301.st",
    subject: "Subject",
    html_body: "<h1>Hello</h1>",
  }),
});
```

---

## DNS (Cloudflare) — текущее состояние

### A-записи

```
mail.301.st            A       51.68.21.133         proxy OFF
postal.301.st          A       51.68.21.133         proxy OFF
relay.301.st           A       51.68.21.133         proxy OFF   ← API relay (Traefik → Namecheap)
rp.postal.301.st       A       51.68.21.133         proxy OFF
ru.301.st              A       51.68.21.133         proxy OFF
```

### CNAME

```
autoconfig.301.st      CNAME   mail.301.st          proxy OFF
autodiscover.301.st    CNAME   mail.301.st          proxy OFF
track.301.st           CNAME   postal.301.st        proxy OFF
```

### MX

```
301.st                 MX 10   emx.mail.ru          (mail.ru, основной — пока)
301.st                 MX 20   mail.301.st           (Mailcow, вторичный)
inbound.301.st         MX 10   inbound.mailersend.net
```

> Когда готовы переключить почту на Mailcow — поменять приоритеты: Mailcow → 10, mail.ru → 20 (или удалить).

### TXT (email-аутентификация)

```
301.st                 TXT     "v=spf1 ip4:51.68.21.133 include:_spf.mailersend.net include:_spf.mail.ru ~all"
dkim._domainkey.301.st TXT     "v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqhkiG9w0BAQEFA..."
_dmarc.301.st          TXT     "v=DMARC1; p=none; rua=mailto:dmarc@301.st; fo=1;"
rp.postal.301.st       TXT     "v=spf1 ip4:51.68.21.133 ~all"
mailru._domainkey      TXT     (DKIM mail.ru)
```

> DMARC: сейчас `p=none` (мониторинг). После прогрева IP сменить на `p=quarantine`, затем `p=reject`.

### PTR-запись

PTR для `51.68.21.133` → `mail.301.st` — установлена (запрос хостеру).

---

## Бэкапы

Автоматически: каждое воскресенье в 4:00 UTC (cron deploy).

### Что бэкапится

- Mailcow: vmail, mysql, redis, rspamd, postfix, crypt (helper-scripts/backup_and_restore.sh)
- Postal DB: mysqldump + gzip
- Конфиги: traefik (включая relay), landing, postal, mailcow (tar.gz)

### Хранение и ротация

| Где | Хранение | Ротация |
|---|---|---|
| Локально `/opt/backups/` | 2 последних | Старые удаляются автоматически |
| Cloudflare R2 `mailserver` | 4 последних | Старые удаляются автоматически |

### Команды

```bash
# Ручной запуск
sudo /opt/backup.sh

# Просмотр локальных бэкапов
ls -lh /opt/backups/

# Просмотр бэкапов в R2
sudo rclone ls r2:mailserver/

# Восстановление из R2
sudo rclone copy r2:mailserver/2026-02-06/ /opt/backups/restore/
```

### R2 Object Storage (Cloudflare)

```
Bucket:            mailserver
Endpoint:          https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com
Access Key ID:     <R2_ACCESS_KEY_ID>
Secret Access Key: <R2_SECRET_ACCESS_KEY>
```

Конфиг rclone на сервере: `/root/.config/rclone/rclone.conf`

---

## Безопасность

- **UFW** — все ненужные порты закрыты
- **Fail2ban** — защита SSH (порт 2222, 3 попытки), Postfix, Dovecot (backend = systemd)
- **SSH** — только ключи, root-логин отключён, нестандартный порт 2222
- **Traefik** — TLS 1.2+, HSTS, catch-all для неизвестных хостов
- **Swap** — 2 GB страховка, swappiness=10
- **Автообновления** — unattended-upgrades для security-патчей
- **ClamAV/olefy** — отключены (корп-почта, экономия ~1 GB RAM)

---

## Логирование

| Что | Лимит |
|---|---|
| Docker container logs | 10 MB x 3 файла (daemon.json) |
| Systemd journal | 50 MB max, 7 дней |
| Squid access/cache log (DEPRECATED) | Отключены |
| Traefik log level | WARN |
| MySQL/MariaDB binlog | OFF |

---

## Настройка лендинга (Webstudio)

Когда будет share link с Build access из Webstudio Cloud:

```bash
ssh -i server_key deploy@51.68.21.133 -p 2222

# Установить CLI (уже есть npm)
npm install -g webstudio

# Линковка
cd /opt/landing
webstudio link    # вставить share link

# Сборка
webstudio sync
webstudio build --template ssg
docker restart landing-ru
```

Автообновление настроено через cron (ежедневно в 3:00 UTC).

---

## Прогрев IP (первые 2-4 недели)

| Неделя | Объём/день | Что отправлять |
|---|---|---|
| 1 | 5-10 писем | Свои ящики (Gmail, Outlook, Yahoo) |
| 2 | 20-30 писем | Команда, знакомые — те, кто откроет |
| 3 | 50-100 писем | Первые пользователи |
| 4+ | Наращивать x2 | Транзакционные через Postal |

Важно:
- Первые письма должны быть открыты и НЕ помечены как спам
- Следить за bounce rate (< 2%) и spam complaints (< 0.1%)
- Проверять IP: https://multirbl.valli.org, https://mxtoolbox.com/blacklists.aspx
- Тест доставки: https://mail-tester.com (цель: 9-10/10)

---

## Проверка здоровья системы

```bash
# Все контейнеры
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Ресурсы
free -h && df -h / && docker stats --no-stream

# DNS
dig 301.st MX +short
dig 301.st TXT +short
dig dkim._domainkey.301.st TXT +short
dig _dmarc.301.st TXT +short
dig -x 51.68.21.133 +short    # PTR

# Fail2ban
sudo fail2ban-client status
sudo fail2ban-client status sshd

# UFW
sudo ufw status verbose

# Тест отправки почты
# (из Mailcow: SOGo → Написать письмо на внешний адрес)
```

---

## Расположение конфигов

| Файл | Путь |
|---|---|
| Mailcow конфиг | `/opt/mailcow-dockerized/mailcow.conf` |
| Mailcow Traefik override | `/opt/mailcow-dockerized/docker-compose.override.yml` |
| Mailcow custom SOGo JS | `/opt/mailcow-dockerized/data/conf/sogo/custom-sogo.js` |
| Postal конфиг | `/opt/postal/config/postal.yml` |
| Postal Traefik override | `/opt/postal/install/docker-compose.override.yml` |
| Postal DB пароль | `/opt/postal/.db_password` |
| Traefik конфиг | `/opt/traefik/traefik.yml` |
| Traefik dynamic | `/opt/traefik/dynamic.yml` |
| Traefik docker-compose | `/opt/traefik/docker-compose.yml` |
| Лендинг | `/opt/landing/docker-compose.yml` |
| Traefik relay конфиг | `/opt/traefik/dynamic.yml` (секция api-relay) |
| Squid конфиг (DEPRECATED) | `/opt/squid/squid.conf` |
| Squid пароль (DEPRECATED) | `/opt/squid/.api_password` |
| Бэкап скрипт | `/opt/backup.sh` |
| R2 rclone конфиг | `/root/.config/rclone/rclone.conf` |
| Docker log limits | `/etc/docker/daemon.json` |
| Journal limits | `/etc/systemd/journald.conf.d/size.conf` |
