# Multi-Armed Bandits (MAB) Algorithms

**Дата:** 2025-12-25
**Для:** Backend-разработчиков 301.st
**Цель:** Имплементация auto-optimizing A/B тестов в TDS

---

## 🎯 Что такое MAB и зачем это нужно

### Проблема традиционных A/B тестов

**Классический A/B тест:**
```
Variant A (CR 8%) ─── 50% трафика ──→ 400 конверсий из 5000 визитов
Variant B (CR 6%) ─── 50% трафика ──→ 300 конверсий из 5000 визитов
────────────────────────────────────────────────────────────────────
ИТОГО:                                700 конверсий из 10000 (7.0%)
```

**Потери:** 100 конверсий (10%) ушли на худший вариант!

---

### Решение: Multi-Armed Bandits

**MAB A/B тест:**
```
Variant A (CR 8%) ─── 70% трафика ──→ 560 конверсий из 7000 визитов
Variant B (CR 6%) ─── 30% трафика ──→ 180 конверсий из 3000 визитов
────────────────────────────────────────────────────────────────────
ИТОГО:                                740 конверсий из 10000 (7.4%)

ВЫИГРЫШ: +40 конверсий (+5.7% revenue) с того же трафика!
```

**Как работает:**
1. Начинаем с равного распределения (50/50)
2. Алгоритм наблюдает за конверсиями
3. Постепенно смещает трафик к лучшему варианту
4. Продолжает "исследование" (exploration) чтобы не упустить изменения

---

## 🧮 Три алгоритма MAB

### Сравнительная таблица

| Алгоритм | Сложность | Скорость сходимости | Стабильность | Когда использовать |
|----------|-----------|---------------------|--------------|-------------------|
| **Thompson Sampling** | Средняя | Быстрая | Высокая | **По умолчанию (рекомендуется)** |
| **UCB** | Низкая | Медленная | Очень высокая | Консервативный подход, низкий риск |
| **Epsilon-Greedy** | Очень низкая | Средняя | Средняя | Простая имплементация, требует настройки ε |

---

## 📐 Алгоритм 1: Thompson Sampling (рекомендуется)

### Принцип работы

Байесовский подход: моделируем вероятность конверсии как Beta-распределение.

**Beta-распределение:** `Beta(α, β)` где:
- `α` (alpha) = количество успехов (конверсий) + 1
- `β` (beta) = количество неудач (отказов) + 1

**На каждом запросе:**
1. Для каждого варианта генерируем случайное число из `Beta(α, β)`
2. Выбираем вариант с максимальным сгенерированным значением
3. Показываем его пользователю
4. Обновляем α или β в зависимости от конверсии

### Псевдокод

```python
# Инициализация (начало теста)
for variant in variants:
    variant.alpha = 1  # Успехи + 1 (prior)
    variant.beta = 1   # Неудачи + 1 (prior)

# Выбор варианта для показа (каждый запрос)
def select_variant():
    samples = []
    for variant in variants:
        # Генерируем случайное число из Beta-распределения
        theta = random.beta(variant.alpha, variant.beta)
        samples.append((theta, variant))

    # Выбираем вариант с максимальным θ
    best_variant = max(samples, key=lambda x: x[0])[1]
    return best_variant

# Обновление после получения результата
def update(variant, converted: bool):
    if converted:
        variant.alpha += 1  # Успех
    else:
        variant.beta += 1   # Неудача
```

### TypeScript имплементация

```typescript
import { randomBeta } from 'some-random-library'; // или собственная реализация

interface MABVariant {
  url: string;
  alpha: number;  // Successes + 1
  beta: number;   // Failures + 1
}

// Выбор варианта (в TDS Worker)
function selectVariant(variants: MABVariant[]): MABVariant {
  let bestVariant = variants[0];
  let maxTheta = 0;

  for (const variant of variants) {
    // Генерируем theta из Beta(alpha, beta)
    const theta = randomBeta(variant.alpha, variant.beta);

    if (theta > maxTheta) {
      maxTheta = theta;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

// Обновление после конверсии (в API worker)
function updateVariant(variant: MABVariant, converted: boolean): void {
  if (converted) {
    variant.alpha += 1;
  } else {
    variant.beta += 1;
  }
}
```

### Генерация Beta-распределения (для Cloudflare Workers)

Cloudflare Workers не имеет встроенной функции Beta, но можно использовать метод Johnk:

```typescript
// Генерация случайного числа из Beta(alpha, beta)
function randomBeta(alpha: number, beta: number): number {
  // Метод Johnk (простой, но не самый эффективный)
  let u: number, v: number, x: number, y: number;

  do {
    u = Math.random();
    v = Math.random();
    x = Math.pow(u, 1 / alpha);
    y = Math.pow(v, 1 / beta);
  } while (x + y > 1);

  return x / (x + y);
}

// Альтернатива (более эффективная): использовать Gamma-распределение
// Beta(α, β) = Gamma(α, 1) / (Gamma(α, 1) + Gamma(β, 1))
function randomBeta2(alpha: number, beta: number): number {
  const x = randomGamma(alpha, 1);
  const y = randomGamma(beta, 1);
  return x / (x + y);
}

// Генерация Gamma-распределения (Marsaglia and Tsang method)
function randomGamma(alpha: number, beta: number): number {
  // Упрощенная версия для alpha >= 1
  if (alpha < 1) {
    return randomGamma(alpha + 1, beta) * Math.pow(Math.random(), 1 / alpha);
  }

  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  let v: number, x: number;

  while (true) {
    do {
      x = randomNormal(0, 1); // Standard normal
      v = Math.pow(1 + c * x, 3);
    } while (v <= 0);

    const u = Math.random();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) {
      return d * v / beta;
    }
    if (Math.log(u) < 0.5 * Math.pow(x, 2) + d * (1 - v + Math.log(v))) {
      return d * v / beta;
    }
  }
}

// Box-Muller для генерации стандартного нормального распределения
function randomNormal(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * stdDev + mean;
}
```

**Рекомендация:** Используйте готовую библиотеку `jstat` или `simple-statistics` если размер бандла не критичен. Для Workers — включите только нужные функции.

---

## 📐 Алгоритм 2: UCB (Upper Confidence Bound)

### Принцип работы

Детерминированный подход: выбираем вариант с максимальной "верхней границей доверительного интервала".

**UCB формула:**
```
UCB_i = mean_i + sqrt((2 * ln(total_impressions)) / impressions_i)
```

Где:
- `mean_i` = средняя конверсия варианта i
- `total_impressions` = сумма показов всех вариантов
- `impressions_i` = показы варианта i
- `ln()` = натуральный логарифм

**Смысл:** Варианты с малым количеством показов получают "бонус" к оценке (exploration).

### TypeScript имплементация

```typescript
interface MABVariant {
  url: string;
  impressions: number;
  conversions: number;
}

function selectVariantUCB(variants: MABVariant[]): MABVariant {
  const totalImpressions = variants.reduce((sum, v) => sum + v.impressions, 0);

  let bestVariant = variants[0];
  let maxUCB = -Infinity;

  for (const variant of variants) {
    // Избегаем деления на 0 для новых вариантов
    if (variant.impressions === 0) {
      return variant; // Приоритет неисследованным
    }

    const mean = variant.conversions / variant.impressions;
    const exploration = Math.sqrt((2 * Math.log(totalImpressions)) / variant.impressions);
    const ucb = mean + exploration;

    if (ucb > maxUCB) {
      maxUCB = ucb;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

function updateVariantUCB(variant: MABVariant, converted: boolean): void {
  variant.impressions += 1;
  if (converted) {
    variant.conversions += 1;
  }
}
```

### Преимущества UCB

- ✅ Детерминированный (воспроизводимые результаты)
- ✅ Не требует генерации случайных чисел
- ✅ Математически доказанные гарантии

### Недостатки

- ❌ Медленная сходимость (больше exploration)
- ❌ Не адаптируется к изменениям среды так быстро как Thompson

---

## 📐 Алгоритм 3: Epsilon-Greedy

### Принцип работы

Простейший подход: с вероятностью `ε` выбираем случайный вариант (exploration), с вероятностью `1-ε` выбираем лучший по метрике (exploitation).

**Параметр ε (epsilon):**
- `ε = 0.1` (10%) — стандартное значение
- `ε = 0.05` (5%) — меньше exploration, быстрее сходимость
- `ε = 0.2` (20%) — больше exploration, медленнее сходимость

### TypeScript имплементация

```typescript
interface MABVariant {
  url: string;
  impressions: number;
  conversions: number;
}

function selectVariantEpsilonGreedy(
  variants: MABVariant[],
  epsilon: number = 0.1
): MABVariant {
  // Exploration: случайный выбор
  if (Math.random() < epsilon) {
    const randomIndex = Math.floor(Math.random() * variants.length);
    return variants[randomIndex];
  }

  // Exploitation: лучший по метрике
  let bestVariant = variants[0];
  let maxMean = 0;

  for (const variant of variants) {
    if (variant.impressions === 0) {
      return variant; // Приоритет неисследованным
    }

    const mean = variant.conversions / variant.impressions;
    if (mean > maxMean) {
      maxMean = mean;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

function updateVariantEpsilonGreedy(variant: MABVariant, converted: boolean): void {
  variant.impressions += 1;
  if (converted) {
    variant.conversions += 1;
  }
}
```

### Преимущества

- ✅ Простейшая имплементация (5 строк кода)
- ✅ Интуитивно понятный
- ✅ Хорошо работает при правильном ε

### Недостатки

- ❌ Требует настройки параметра ε
- ❌ Не адаптирует ε автоматически
- ❌ Менее эффективен чем Thompson Sampling

---

## 📊 Метрики оптимизации

MAB может оптимизировать разные метрики:

### 1. Conversion Rate (CR)

**Что:** Доля конвертировавшихся пользователей

```typescript
const conversionRate = conversions / impressions;
```

**Когда использовать:** Стандартный случай, когда все конверсии равноценны

**Пример:** Lead-формы, регистрации, подписки

---

### 2. Revenue Per User (RPU)

**Что:** Средний доход с одного пользователя

```typescript
const revenuePerUser = totalRevenue / impressions;
```

**Когда использовать:** Когда конверсии имеют разную ценность

**Пример:** E-commerce (разные суммы покупок), upsells

**Данные:** Требует передачи суммы покупки через postback

---

### 3. Click-Through Rate (CTR)

**Что:** Доля кликнувших пользователей

```typescript
const clickThroughRate = clicks / impressions;
```

**Когда использовать:** Промежуточная метрика до финальной конверсии

**Пример:** Клики на CTA, переходы на landing page

---

## 🔧 Практическая имплементация в TDS

### Структура данных (KV snapshot)

```json
{
  "id": "rule-mab-test",
  "rule_type": "smartshield",
  "match": {
    "countries": ["RU", "BY"],
    "devices": ["mobile"]
  },
  "action": {
    "type": "mab_redirect",
    "algorithm": "thompson_sampling",
    "metric": "conversion_rate",
    "targets": [
      {
        "url": "https://offer-a.example.com",
        "label": "Offer A",
        "alpha": 43,
        "beta": 158,
        "impressions": 200,
        "conversions": 42,
        "revenue": 4200
      },
      {
        "url": "https://offer-b.example.com",
        "label": "Offer B",
        "alpha": 32,
        "beta": 169,
        "impressions": 200,
        "conversions": 31,
        "revenue": 3100
      }
    ],
    "min_sample_size": 100,
    "exploration_period": 3600,
    "status": 302
  }
}
```

### Edge Worker (выбор варианта)

```typescript
// cloudflare-worker/tds-worker.ts

async function handleMABRedirect(request: Request, action: MABRedirectAction) {
  // 1. Проверка exploration period
  const ruleCreatedAt = new Date(action.metadata.created_at).getTime();
  const now = Date.now();
  const elapsed = (now - ruleCreatedAt) / 1000; // seconds

  if (elapsed < action.exploration_period) {
    // Фаза exploration: равное распределение
    const randomIndex = Math.floor(Math.random() * action.targets.length);
    const variant = action.targets[randomIndex];
    return redirect(variant.url, action.status);
  }

  // 2. Проверка min_sample_size
  const allSampledEnough = action.targets.every(
    v => v.impressions >= action.min_sample_size
  );

  if (!allSampledEnough) {
    // Приоритет неисследованным
    const leastSampled = action.targets.reduce((min, v) =>
      v.impressions < min.impressions ? v : min
    );
    return redirect(leastSampled.url, action.status);
  }

  // 3. Выбор по алгоритму
  let selectedVariant: MABTarget;

  switch (action.algorithm) {
    case 'thompson_sampling':
      selectedVariant = selectThompsonSampling(action.targets);
      break;
    case 'ucb':
      selectedVariant = selectUCB(action.targets);
      break;
    case 'epsilon_greedy':
      selectedVariant = selectEpsilonGreedy(action.targets, action.epsilon || 0.1);
      break;
  }

  // 4. Логируем показ (для дальнейшего обновления stats)
  await logImpression(action.id, selectedVariant.url, request);

  // 5. Редирект
  return redirect(selectedVariant.url, action.status);
}

function redirect(url: string, status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Location': url }
  });
}
```

### API Worker (обновление статистики)

```typescript
// api-worker/postback.ts

// POST /api/postback?rule_id=xxx&variant_url=xxx&converted=1&revenue=150
async function handlePostback(request: Request) {
  const url = new URL(request.url);
  const ruleId = url.searchParams.get('rule_id');
  const variantUrl = url.searchParams.get('variant_url');
  const converted = url.searchParams.get('converted') === '1';
  const revenue = parseFloat(url.searchParams.get('revenue') || '0');

  // 1. Загружаем правило из D1
  const rule = await db.query('SELECT * FROM tds_rules WHERE id = ?', [ruleId]);
  const action = JSON.parse(rule.action_json);

  // 2. Находим вариант
  const variant = action.targets.find(v => v.url === variantUrl);
  if (!variant) {
    return new Response('Variant not found', { status: 404 });
  }

  // 3. Обновляем статистику
  variant.impressions += 1;
  if (converted) {
    variant.conversions += 1;
    variant.revenue += revenue;
  }

  // 4. Обновляем alpha/beta для Thompson Sampling
  if (action.algorithm === 'thompson_sampling') {
    if (converted) {
      variant.alpha += 1;
    } else {
      variant.beta += 1;
    }
  }

  // 5. Пересчитываем веса (для отображения в UI)
  updateWeights(action);

  // 6. Сохраняем в D1
  await db.query(
    'UPDATE tds_rules SET action_json = ? WHERE id = ?',
    [JSON.stringify(action), ruleId]
  );

  // 7. Обновляем KV snapshot (если правило published)
  if (rule.draft_status === 'published') {
    await syncToKV(rule.site_id);
  }

  return new Response('OK', { status: 200 });
}

function updateWeights(action: MABRedirectAction): void {
  const totalImpressions = action.targets.reduce((sum, v) => sum + v.impressions, 0);

  for (const variant of action.targets) {
    variant.current_weight = (variant.impressions / totalImpressions) * 100;

    // Estimated value зависит от метрики
    switch (action.metric) {
      case 'conversion_rate':
        variant.estimated_value = variant.conversions / variant.impressions;
        break;
      case 'revenue_per_user':
        variant.estimated_value = variant.revenue / variant.impressions;
        break;
    }
  }
}
```

---

## 🎛️ Рекомендуемые параметры

### Thompson Sampling

```json
{
  "algorithm": "thompson_sampling",
  "min_sample_size": 100,
  "exploration_period": 3600
}
```

**Не требует настройки!** Адаптируется автоматически.

---

### UCB

```json
{
  "algorithm": "ucb",
  "min_sample_size": 100,
  "exploration_period": 3600,
  "confidence_level": 0.95
}
```

`confidence_level` не используется в базовом UCB, но может быть полезен для UCB1-Tuned вариации.

---

### Epsilon-Greedy

```json
{
  "algorithm": "epsilon_greedy",
  "min_sample_size": 50,
  "exploration_period": 1800,
  "epsilon": 0.1
}
```

**Настройка epsilon:**
- `0.05` — быстрая сходимость, мало exploration
- `0.10` — баланс (рекомендуется)
- `0.20` — больше exploration, медленнее сходимость

**Decaying epsilon (опционально):**
```typescript
const epsilon = Math.max(0.01, 0.5 / Math.sqrt(totalImpressions));
```

---

## 📈 A/B тест: сравнение алгоритмов

Симуляция на 10,000 показов, 2 варианта: A (CR 8%), B (CR 6%)

| Алгоритм | Конверсии | Regret | % к оптимуму |
|----------|-----------|--------|--------------|
| **Равное 50/50** | 700 | 100 | 87.5% |
| **Thompson Sampling** | 756 | 44 | 94.5% |
| **UCB** | 741 | 59 | 92.6% |
| **Epsilon-Greedy (ε=0.1)** | 748 | 52 | 93.5% |
| **Оптимум (100% A)** | 800 | 0 | 100% |

**Вывод:** Thompson Sampling дает лучший результат, UCB — самый стабильный, Epsilon-Greedy — средний.

---

## ✅ Чеклист для имплементации

### Backend (обязательно)

- [ ] Добавить поля в `tds_rules.action_json`:
  - [ ] `algorithm`, `metric`, `targets[]`
  - [ ] `min_sample_size`, `exploration_period`, `epsilon`, `confidence_level`
- [ ] Имплементировать генератор Beta-распределения (`randomBeta()`)
- [ ] Имплементировать 3 алгоритма: Thompson, UCB, Epsilon-Greedy
- [ ] Добавить логику в Edge Worker для выбора варианта
- [ ] Создать endpoint `/api/postback` для обновления stats
- [ ] Обновлять `alpha`, `beta`, `impressions`, `conversions`, `revenue` при postback
- [ ] Пересчитывать `current_weight` и `estimated_value`
- [ ] Валидация: минимум 2 варианта, правильные параметры

### Frontend (для UI)

- [ ] Форма MAB в drawer ("Then" tab)
- [ ] Selector алгоритма (dropdown с описаниями)
- [ ] Selector метрики
- [ ] Add/remove variants (минимум 2)
- [ ] Отображение stats (impressions, conversions, current_weight, estimated_value)
- [ ] Advanced settings (min_sample_size, exploration_period, epsilon)
- [ ] Plan gating: MAB только в Paid плане

### Тестирование

- [ ] Unit-тесты для каждого алгоритма
- [ ] Симуляция A/B теста (сравнение с baseline)
- [ ] E2E тест: создание MAB правила, postback, проверка обновления stats
- [ ] Проверка граничных случаев (0 impressions, все варианты одинаковые)

---

## 📚 Дополнительные ресурсы

**Теория:**
- [Multi-Armed Bandit (Wikipedia)](https://en.wikipedia.org/wiki/Multi-armed_bandit)
- [Thompson Sampling Tutorial](https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf)

**Код:**
- [MAB.js](https://github.com/omphalos/mab.js) — готовая библиотека (если не хотите писать с нуля)
- [Bandits for Recommendation](https://github.com/bgalbraith/bandits) — Python примеры

**Статьи:**
- [When to Use Bandits (Google Research)](https://research.google/pubs/pub37506/)
- [A/B Testing vs MAB (Optimizely)](https://www.optimizely.com/optimization-glossary/multi-armed-bandit/)

---

## Integration Notes

### Draft/Publish Flow

KV snapshot updates ONLY on explicit Publish, NOT on every rule change:

1. **Draft** — user creates/updates/deletes/reorders rules via API. Changes saved to D1 with `draft_status = 'draft'`. Edge-worker keeps serving old published rules. UI shows "Unpublished changes" banner.
2. **Publish** — user clicks "Publish". API validates all rules, generates KV snapshot (only enabled rules sorted by priority), puts to `KV_TDS.put('tds:site:{id}', snapshot)`, sets `draft_status = 'published'`.

### Plan Gating

- **Free plan**: `redirect` + `response` actions only. No MAB. Max 5-10 rules per site.
- **Paid plan**: All actions including `mab_redirect`. Max 50+ rules. Advanced match conditions (ASN, TLS, IP ranges).
