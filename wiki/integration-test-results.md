# Integration Test Results

**Date:** 2026-02-24
**Environment:** Production (api.301.st, CF Client account click@clx.cx)
**Test Site:** site_id=4, project_id=2, account_id=19

---

## Phase 0: Resource Inventory

| Resource | Value |
|----------|-------|
| account_id | 19 |
| user_id | 17 |
| site_id (Test Site) | 4 (active) |
| project_id | 2 |
| plan_tier | pro |

### Test Site Domains

| domain_id | domain_name | role | zone_id | cf_zone_id |
|-----------|-------------|------|---------|------------|
| 34 | benefactor.website | donor | 86 | 6015f3d6... |
| 35 | contributor.website | donor | 87 | 573c957f... |
| 73 | debloat.click | donor | 123 | 7d9788c1... |
| 36 | donator.site | donor | 88 | 295f11f8... |
| 42 | landing.fit | acceptor | 95 | 3e3462db... |
| 43 | supporter.website | donor | 96 | 6eef1e4c... |

### Redirect Rules (Test Site)

| rule_id | rule_name | template | target | status_code | sync_status |
|---------|-----------|----------|--------|-------------|-------------|
| 14 | Domain→Domain: benefactor.website | T1 | landing.fit | 301 | synced |
| 26 | www→non-www: benefactor.website | T4 | — | 301 | synced |
| 47 | Domain→Domain: contributor.website | T1 | landing.fit | 301 | synced |
| 19 | Domain→Domain: donator.site | T1 | landing.fit | 301 | synced |
| 20 | Domain→Domain: supporter.website | T1 | landing.fit | 301 | synced |
| 48 | www→non-www: supporter.website | T4 | — | 301 | synced |
| 49 | Domain→Domain: debloat.click | T1 | 301.st | 301 | synced |
| 50 | www→non-www: debloat.click | T4 | — | 301 | synced |

### TDS Rules: **0** (none exist)
### Client Workers: **0** (not deployed, client_worker_configs empty)

---

## Phase 1e: Redirect Edge Verification

### E1: Domain→Domain (T1) Redirects

| # | Domain | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| E1.1 | https://benefactor.website/ | 301 → landing.fit | 301 → https://landing.fit/ | **PASS** |
| E1.2 | https://contributor.website/ | 301 → landing.fit | 301 → https://landing.fit/ | **PASS** |
| E1.3 | https://donator.site/ | 301 → landing.fit | 301 → https://landing.fit/ | **PASS** |
| E1.4 | https://supporter.website/ | 301 → landing.fit | 301 → https://landing.fit/ | **PASS** |
| E1.5 | https://debloat.click/ | 301 → 301.st | 301 → https://301.st/ | **PASS** |

### E1: www→non-www (T4) Redirects

| # | Domain | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| E1.6 | https://www.benefactor.website/ | 301 → benefactor.website | 301 → https://benefactor.website/ | **PASS** |
| E1.7 | https://www.supporter.website/ | 301 → supporter.website | 301 → https://supporter.website/ | **PASS** |
| E1.8 | https://www.debloat.click/ | 301 → debloat.click | 301 → https://debloat.click/ | **PASS** |

### E1: Path & Query Preservation

| # | URL | Expected Location | Actual | Status |
|---|-----|-------------------|--------|--------|
| E1.9 | https://benefactor.website/some/path?query=test | landing.fit/some/path?query=test | https://landing.fit/some/path?query=test | **PASS** |

### E1: HTTP→Target (no double hop)

| # | URL | Expected | Actual | Status |
|---|-----|----------|--------|--------|
| E1.10 | http://benefactor.website/ | 301 direct to target | 301 → https://landing.fit/ | **PASS** |

### E1: Acceptor Domain

| # | URL | Expected | Actual | Status |
|---|-----|----------|--------|--------|
| E1.11 | https://landing.fit/ | 200 (serves content) | 200 OK, text/html | **PASS** |

---

## Phase 1: Public API Endpoints

### Postback (no auth required)

| # | Test | Request | Expected | Actual | Status |
|---|------|---------|----------|--------|--------|
| P1 | Postback validation error | POST /tds/postback (no params) | 400, validation_error | `{"ok":false,"error":"validation_error","details":["Required","Required"]}` | **PASS** |
| P2 | Postback non-existent rule (query) | POST /tds/postback?rule_id=999&variant_url=https://test.com&converted=1 | 404, rule_not_found | `{"ok":false,"error":"rule_not_found"}` | **PASS** |
| P3 | Postback non-existent rule (JSON) | POST /tds/postback {rule_id:1, variant_url:"...", converted:1} | 404, rule_not_found | `{"ok":false,"error":"rule_not_found"}` | **PASS** |

### API Error Handling

| # | Test | Request | Expected | Actual | Status |
|---|------|---------|----------|--------|--------|
| A1 | Root endpoint | GET / | 404 | 404 Not Found | **PASS** |
| A2 | Non-existent endpoint | GET /nonexistent | 404 | 404 | **PASS** |
| A3 | Auth-protected w/o token | GET /redirects/templates | 401 | `{"ok":false,"error":"unauthorized"}` | **PASS** |
| A4 | Auth-protected w/o token | GET /tds/presets | 401 | `{"ok":false,"error":"unauthorized"}` | **PASS** |

---

## Phase 2d: Health Tests (H1–H8) — 2026-03-03

**Prerequisites resolved:** VT API key added, client worker cron ran, threats data in DB301.

| # | Test | Domain | Expected | Actual | Status |
|---|------|--------|----------|--------|--------|
| H1 | All 8 fields in health response | pin-up.sbs (46) | 8 fields | 8/8 present | **PASS** |
| H2 | Status=warning when threat_score>0 | pin-up.sbs (46) | warning | status=warning, score=5 | **PASS** |
| H3 | Status=healthy when threat_score=0 | donator.site (36) | healthy | status=healthy, score=0 | **PASS** |
| H4 | Threats object with VT data | pin-up.sbs (46) | source=virustotal, categories | 4 categories, checked_at present | **PASS** |
| H5 | Traffic stats populated | donator.site (36) | today/yesterday/anomaly | today=587, anomaly=false | **PASS** |
| H6 | VT quota endpoint | /integrations/virustotal/quota | tier, daily_limit | tier=free, limit=500 | **PASS** |
| H7 | Domain list health.status | GET /domains | warning + healthy | 4 warning, 12 healthy (16 total) | **PASS** |
| H8 | Blocked domain status=blocked | pinupcasino.quest (44) | blocked=true | status=blocked, reason=manual (DB test, reverted) | **PASS** |

**Warning domains (threat_score > 0):** pin-up.beauty (2), pinupcasino.cfd (2), pinupgirl.ru (2), pin-up.sbs (5)

---

## BLOCKED Tests

### Phase 1a: Health Worker — RESOLVED (2026-03-03)
Health worker deployed, VT checks running, all H1-H8 tests pass.

### Phase 1b: TDS Sync + Edge — BLOCKED
**Reason:** No TDS rules exist, no client workers deployed.
Tests T1-T5 cannot be executed.

### Phase 1c: TDS Postback (with real rules) — BLOCKED
**Reason:** No TDS rules exist (need to create via Phase 2b first).
Tests P1-P2 with real rules deferred.

### Phase 1d: D1 Verification — BLOCKED
**Reason:** No client D1 databases exist (workers not deployed).
Tests D1-D4 cannot be executed.

### Phase 2: Authenticated CRUD — REQUIRES PLAYWRIGHT
**Reason:** All CRUD endpoints require JWT with fingerprint validation.
curl cannot work (IP/UA mismatch). Need browser context via MCP Playwright.

**Affected tests:**
- Phase 2a: R1-R11 (Redirect CRUD + Apply)
- Phase 2b: T6-T13 (TDS CRUD)
- Phase 2c: M1-M6 (TDS MAB)
- Phase 2d: C1-C4 (Cleanup)

---

## Summary

| Phase | Tests | Passed | Failed | Blocked |
|-------|-------|--------|--------|---------|
| 1e: Redirect Edge | 11 | **11** | 0 | 0 |
| 1: Public API | 7 | **7** | 0 | 0 |
| 2: CE (Client Env) | 8 | **8** | 0 | 0 |
| 2: R (Redirects) | 7 | **7** | 0 | 0 |
| 2: T (TDS) | 10 | **10** | 0 | 0 |
| 2d: H (Health) | 8 | **8** | 0 | 0 |
| 1b: TDS Edge | 5 | — | — | **5** (no workers/rules) |
| 1c: Postback (real) | 2 | — | — | **2** (no TDS rules) |
| 1d: D1 Verify | 4 | — | — | **4** (no client D1) |
| 2c: MAB | 6 | — | — | **6** (need Playwright) |
| 2d: Cleanup | 4 | — | — | **4** (need Playwright) |
| **Total** | **72** | **51** | **0** | **21** |

---

## Prerequisites for Remaining Tests

1. **Deploy Client Workers** → unblocks Phase 1a, 1b, 1d
   - Deploy Health worker (`301-client`) to click@clx.cx CF account
   - Deploy TDS worker (`301-tds`) to click@clx.cx CF account
   - Run setup endpoints to configure D1, secrets, routes

2. **MCP Playwright** → unblocks Phase 2a-2d
   - Login to app.301.st in browser
   - Execute authenticated fetch() calls from browser console
   - Or: add a service token / API key auth bypass for testing

3. **Create TDS Rules** (via Phase 2b) → unblocks Phase 1c postback tests with real data
