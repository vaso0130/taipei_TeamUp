# 系統架構

## 總覽

```mermaid
flowchart LR
    subgraph client [使用者]
        B[瀏覽器<br/>Vue 3 SPA]
    end

    subgraph gcp [GCP - asia-east1]
        H[Firebase Hosting<br/>靜態前端]
        API[Cloud Run<br/>Hono API<br/>min-instances=0]
        DB[(Cloud SQL<br/>PostgreSQL<br/>私有 IP)]
        AUTH[Firebase Auth<br/>Google + Email link]
        CT[Cloud Tasks<br/>審核佇列]
        VA[Vertex AI<br/>Gemini 審核]
        KMS[Cloud KMS<br/>欄位加密 KEK]
        SM[Secret Manager<br/>連線字串 / pepper]
        SCH[Cloud Scheduler<br/>資料清理排程]
    end

    B -->|HTTPS| H
    B -->|/api + Firebase ID token| API
    B -.->|登入| AUTH
    API -->|驗證 token| AUTH
    API -->|Cloud SQL Connector| DB
    API -->|enqueue| CT
    CT -->|worker 回呼| API
    API -->|審核請求<br/>去識別化內容| VA
    API --> KMS
    API --> SM
    SCH -->|定期清理| API
```

## 分層

| 層 | 技術 | 位置 |
|---|---|---|
| 前端 SPA | Vue 3 + Vite + Pinia + Tailwind | `apps/web` |
| API | Hono on Node.js（容器化，Cloud Run） | `apps/api` |
| 共用契約 | zod schema + TypeScript 型別 | `packages/shared` |
| 資料庫 | PostgreSQL（Drizzle ORM + drizzle-kit migrations） | `apps/api/src/db` |
| 活動設定 | seed JSON（一檔一活動） | `apps/api/seeds/events` |

## 核心設計：活動即設定

所有「活動規則」都是 `events` 表的資料，不是程式碼：

- 人數上下限 `min_members` / `max_members`
- 一人可否多團 `exclusive_membership`
- 需要幾位聯絡人 `required_contacts`
- 是否詢問年滿 18 `requires_adult_check`
- UI 術語 `term_team` / `term_member`（隊伍／成員 → 讀書會／書友）
- 角色與技能字典：`event_role_options` / `event_skill_options`（per-event，非全域 enum）

新活動 = 新 seed 檔 + `pnpm seed`。程式碼零修改（M1 驗收條件，並有測試把關）。

## 資料流：內容審核（M5）

```mermaid
sequenceDiagram
    participant U as 使用者
    participant API as Cloud Run API
    participant DB as PostgreSQL
    participant CT as Cloud Tasks
    participant G as Vertex AI Gemini

    U->>API: 送出內容（bio / pitch / 訊息）
    API->>DB: 存入，狀態 pending_review（加密）
    API->>CT: enqueue 審核任務
    API-->>U: 已送出，審核中
    CT->>API: worker 回呼
    API->>API: 規則前處理（URL、通訊 ID、金融關鍵字）
    API->>G: 內容 + signals（無任何識別資訊）
    G-->>API: structured JSON（risk_level / categories / rationale）
    API->>DB: 寫 moderation_record，更新內容狀態
    Note over API,G: fail-closed：逾時／解析失敗 → medium，進人工審核
```

## 本機開發模式（ADR-004）

`DATABASE_URL` 未設定時，API 直接載入 seed 檔進記憶體（唯讀），`pnpm dev` 不需要任何外部服務。審核模組本機一律 `MODERATION_PROVIDER=mock`。

## 部署

- `cloudbuild.yaml`：main 分支 → 建置容器 → Artifact Registry → Cloud Run（`asia-east1`）
- 前端：`pnpm --filter @teamup/web build` → Firebase Hosting（`/api/**` rewrite 到 Cloud Run）
- 專案 ID 等真實資源名稱一律走 Cloud Build substitution 與 Secret Manager，repo 內不出現
