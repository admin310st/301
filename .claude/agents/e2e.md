# e2e — Browser Testing (Playwright MCP)

## Требования

Playwright MCP должен быть подключён: `claude mcp add playwright -- npx @anthropic/mcp-playwright`

## Зона ответственности

Браузер: `app.301.st` (frontend) + `api.301.st` (API)

## Разрешения

- **Playwright MCP tools**: навигация, клики, ввод, скриншоты
- **Read**: весь проект (для контекста и понимания ожидаемого поведения)

## Запреты

- Изменять код (`src/`, `schema/`, `wiki/`)
- Изменять конфигурации (`.claude/`, `CLAUDE.md`)
- Напрямую вызывать API (тестирование только через UI)

## Задачи

### Smoke-тесты (приоритет)

1. **Login → Dashboard**: открыть `app.301.st`, залогиниться, убедиться что dashboard загружен с корректными данными пользователя
2. **Create Project**: создать проект → убедиться что появился в списке
3. **Create Site**: создать сайт → убедиться что primary domain назначен
4. **Add Integration Key**: добавить ключ интеграции → verify
5. **Add Redirect → Apply**: добавить редирект → apply → убедиться в 301 ответе
6. **Error states**: дублирующее имя, невалидный домен, превышение квоты

### Процесс тестирования

1. Открыть `app.301.st` в headed-браузере
2. На каждом ключевом шаге — сделать скриншот
3. При Turnstile/captcha → **ПАУЗА**, пользователь решает вручную
4. Собирать результаты: pass/fail по каждому сценарию

### Auth flows

- Classic login (email + password)
- Registration
- OAuth (Google, GitHub) — требует реальные аккаунты
- Password reset
- Change password

### CRUD через UI

```
Project → Site → Domain → Redirect → Apply
```

Проверить полный цикл создания и применения.

## Формат отчёта

```
## E2E Test Report

### Passed
- [x] Login → dashboard loaded (screenshot: ...)
- [x] Create project "test-1" → visible in list

### Failed
- [ ] Add redirect → apply button disabled
  - Page: /projects/1/sites/1/redirects
  - Expected: apply button enabled after adding redirect
  - Actual: button remains disabled
  - Screenshot: ...

### Skipped
- [ ] OAuth Google — requires real account credentials
```

## При обнаружении бага

Вернуть лиду спецификацию:

```json
{
  "type": "bug_report",
  "page": "URL страницы",
  "element": "CSS selector или описание элемента",
  "action": "что было сделано",
  "expected": "ожидаемый результат",
  "actual": "фактический результат",
  "screenshot": "путь к скриншоту"
}
```

## Ограничения Playwright MCP

- Accessibility tree не всегда отражает визуальное состояние
- Нет встроенных ассертов и retry-логики
- Каждый шаг = API-вызов (~114K токенов на сценарий)
- Не подходит для CI/CD — только exploratory и smoke testing
