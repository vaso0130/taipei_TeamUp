# 揪團平台 Taipei TeamUp

通用的活動揪團媒合平台。任何需要「湊人組隊」的活動都能用——第一個上線場景是 **2026 臺北秋季程式設計節**的黑客松組隊。

> 本平台是報名前的媒合工具，**不是**參賽作品，也不代為報名。

## 特色

- **通用活動模型**：人數上下限、一人可否多團、聯絡人數量、角色與技能字典、UI 術語，全部是活動設定值。換一份 seed 檔就能開一場規則完全不同的活動（讀書會、志工團、專案小組……），不改任何程式碼。
- **媒合導向**：核心是「這團還缺什麼角色／技能」對上「這個人有什麼」，不是留言板。
- **個資最小化**：只收 Email（加密儲存）與暱稱。不收真名、電話、生日、學校公司；未成年同意書由活動主辦單位收取，平台不經手。
- **內容安全**：所有使用者產生的文字發布前經過自動化風險檢測（Vertex AI Gemini，fail-closed），阻擋詐騙、釣魚、站外導流等內容；使用者可檢舉，檢舉內容由升級模型複審。
- **全 serverless**：Cloud Run + Cloud SQL + Cloud Tasks，無任何 VM。

## 安全設計摘要

- **身分**：只信任已驗證 email 的 Firebase ID token；email 以 canonical 形式（去 `+tag`、Gmail 去點）做 HMAC 身分鍵，別名無法繞過一人一隊或停權；pepper 可輪替。
- **資料**：email 信封加密（Cloud KMS KEK）、訊息本文加密；審核紀錄與稽核紀錄 180 天、刪帳 30 天後硬刪，皆由每日排程落實。
- **審核**：規則前處理 + Gemini structured output + prompt injection 防護；worker 冪等、fail-closed；管理員只能調閱風險相關對話，每次調閱先寫稽核（寫不進就不給內容）。
- **濫用防護**：帳號層限流（開團 3/日、訊息 30/時、檢舉 10/時、匯出 3/日等，`RATE_LIMIT_*` 可調）、body 64 KB 上限、路徑參數 UUID 驗證、自由文字拒絕控制字元、reCAPTCHA Enterprise（設定後啟用）。
- **前端**：CSP `script-src 'self'`（不用 inline script）、`frame-ancestors 'none'`、使用者內容一律純文字（`v-html` 為 ESLint error）、訊息對象名稱只信任伺服端。

細節見 [`docs/architecture.md`](docs/architecture.md) 與 [`docs/privacy.md`](docs/privacy.md)；架構決策紀錄以 ADR 編號引用（ADR-025～033 為 2026-09 全站 QA 修復）。

## 本機開發

需求：Node.js ≥ 22、pnpm 10（`corepack enable pnpm`）。Docker 為選用。

```bash
pnpm install
pnpm dev
```

- Web：http://localhost:5173
- API：http://localhost:8080（`/healthz` 健康檢查）

**不需要資料庫就能跑**：`DATABASE_URL` 未設定時，API 以「seed 檔記憶體模式」啟動（唯讀），直接讀 `apps/api/seeds/events/` 下的活動設定。要完整功能再起資料庫：

```bash
docker compose up -d                      # 本機 PostgreSQL
cp .env.example .env.local                # 填 DATABASE_URL
pnpm --filter @teamup/api db:migrate      # 建表
pnpm seed                                 # 匯入活動 seed
```

內容審核模組在本機一律走 mock（`MODERATION_PROVIDER=mock`），不會呼叫任何外部 AI API。

### 常用指令

| 指令 | 說明 |
|---|---|
| `pnpm dev` | 同時啟動 API 與 Web |
| `pnpm test` | 全部測試（Vitest） |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript 檢查 |
| `pnpm build` | 建置全部套件 |
| `pnpm seed` | 將 seed 檔匯入資料庫 |
| `pnpm e2e` | Playwright 瀏覽器 E2E（smoke 在 seed 模式可跑；完整旅程需 `DATABASE_URL`） |
| `pnpm --filter @teamup/api eval:moderation` | 對真實 Vertex 端點跑審核驗收語料 |
| `pnpm --filter @teamup/api rehash:email-lookups -- --dry` | Email canonical／pepper 變更後重算 lookup（先 dry run；步驟見 `docs/deployment.md`） |
| `node deploy/render-firebase-config.mjs` | 由 `firebase.json` 範本產生部署用 `firebase.deploy.json` |

## 換一場活動

活動設定在 `apps/api/seeds/events/*.json`，一個檔案一場活動：人數規則、是否一人限一團、需要幾位聯絡人、角色字典、技能字典、UI 術語（「隊伍／成員」可覆寫成「讀書會／書友」）。新增一個 JSON 檔、跑 `pnpm seed`，就是一場新活動。repo 內附兩個範例：

- `codefest-2026-fall.json` — 黑客松（4–5 人、一人一隊、需 2 位聯絡人）
- `weekend-bookclub.json` — 讀書會（3–6 人、不限團數、免聯絡人）——證明通用性的示範活動

## 架構

- 前端：Vue 3 + Vite + TypeScript + Pinia + Tailwind CSS（`apps/web`）
- 後端：Hono on Node.js，部署於 Cloud Run（`apps/api`）
- 共用：zod schema 與型別（`packages/shared`）
- 資料庫：Cloud SQL for PostgreSQL（Drizzle ORM）；本機用 docker-compose
- 詳見 [`docs/architecture.md`](docs/architecture.md)、[`docs/privacy.md`](docs/privacy.md) 與 [`docs/deployment.md`](docs/deployment.md)

## 維護聲明

本專案為活動性質的開源專案，維護以資安修補為主，不提供功能開發的 SLA。資安通報請見 [`SECURITY.md`](SECURITY.md)。

## English Summary

**Taipei TeamUp** is a general-purpose team-matching platform, first deployed for the Taipei Codefest 2026 Fall hackathon. Every event rule — team size limits, one-team-per-person exclusivity, required contact persons, role/skill dictionaries, even UI terminology — is event configuration, not code. Adding a new event with completely different rules requires only a new seed JSON file.

Design principles: data minimization (email + nickname only, email encrypted at rest with KMS envelope encryption), pre-publication content moderation via Vertex AI Gemini with fail-closed behavior and prompt-injection defenses, and a fully serverless GCP stack (Cloud Run, Cloud SQL, Cloud Tasks — no VMs).

To run locally: `pnpm install && pnpm dev` (no database required — the API falls back to a read-only in-memory mode backed by seed files; moderation uses a mock provider). Licensed under MIT.
