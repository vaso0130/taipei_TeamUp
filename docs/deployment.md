# 部署與網域設定

本文件只用佔位符：`<PROJECT_ID>`（GCP 專案 ID）、`<API_ORIGIN>`（Cloud Run 服務網址，如 `https://teamup-api-xxxx.a.run.app`）、`$INTERNAL_TASK_SECRET`（Secret Manager 中的值）。實際場測環境的專案 ID、網址與實例位置記錄在 `docs/deployment.local.md`，不進公開 repo。

## 部署形態

| 資源 | 形態 |
|---|---|
| API（Cloud Run） | `asia-east1`，服務帳號最小權限，KMS KEK + Vertex 審核 + Secret Manager |
| 前端（Firebase Hosting） | 建置時以 `VITE_EVENT_SLUG` 指定當期活動、`VITE_API_BASE_URL` 指定 API 網址 |
| 資料庫 | Cloud SQL PostgreSQL；migration + seed 由 `deploy/cloudbuild-migrate.yaml` 在 Cloud Build 內網執行（實例連線名以 `--substitutions=_INSTANCE=...` 帶入） |
| Firebase Auth | 建議獨立 Firebase 專案（Google / Email link 需在 Console 啟用） |
| Cloud Tasks | 佇列 `teamup-moderation`（審核 worker 回呼） |
| Cloud Scheduler | 每日一次 `POST /internal/cleanup`（資料保存期限、硬刪、待審重新入列） |

注意：外部監控請打 `/api/healthz`——`/healthz` 在 `*.run.app` 會被 Google 前端攔截（容器探測不受影響）。
正式上線前應：換獨立 Cloud SQL 實例、把 Hosting 與 Cloud Run 收攏到同一專案（可改回 rewrites 免 CORS）、掛上 `xn--ej4a.taipei`。

## 網域：配.taipei

自訂網域為中文 IDN：**配.taipei**，DNS 與 GCP 一律使用 punycode 形式 **`xn--ej4a.taipei`**（部分註冊商介面可直接輸入中文，實際記錄仍是 punycode）。

目前架構：前端掛 Firebase Hosting，瀏覽器以 `VITE_API_BASE_URL` **直連** Cloud Run（跨源，API 以 `ALLOWED_ORIGINS` 放行前端來源；ADR-033）。Hosting 與 Cloud Run 收攏到同一 GCP 專案後，可在 `firebase.json` 加回 `/api/**` run rewrite 讓全程同源：

```json
{ "source": "/api/**", "run": { "serviceId": "teamup-api", "region": "asia-east1" } }
```

（跨專案時這條 rewrite 不會生效，所以範本中已移除。）

### 步驟一：GCP / Firebase 端

1. Firebase Console → Hosting → 「新增自訂網域」→ 輸入 `xn--ej4a.taipei`
2. Console 會給一組 **TXT 驗證記錄**（含 ACME challenge），照抄到註冊商
3. 驗證通過後，Console 會給 **2 筆 A 記錄** 的 IP，照抄到註冊商
4. SSL 憑證由 Firebase 自動簽發與續期（數分鐘到 24 小時）

### 步驟二：註冊商（DNS）端要填的值

| 類型 | 主機名稱 | 值 | 用途 |
|---|---|---|---|
| TXT | `xn--ej4a.taipei`（或 `_acme-challenge.xn--ej4a.taipei`，依 Console 指示） | Console 提供的驗證字串 | 網域所有權驗證＋憑證簽發，**要一直留著** |
| A | `xn--ej4a.taipei`（apex/@） | Console 提供的第 1 個 IP | 指向 Firebase Hosting |
| A | `xn--ej4a.taipei`（apex/@） | Console 提供的第 2 個 IP | 同上 |
| CAA（選填） | `xn--ej4a.taipei` | `0 issue "letsencrypt.org"` 與 `0 issue "pki.goog"` | 若網域已有 CAA 記錄，必須加這兩筆，否則憑證簽不出來；完全沒有 CAA 記錄則可不填 |

注意：

- A 記錄的實際 IP **以 Firebase Console 顯示的為準**（不要抄網路上的舊教學值，Google 更換過 Hosting 的 IP）。
- TXT 驗證記錄刪掉會導致憑證無法續期。
- 不需要為 API 另設子網域。若日後要獨立 API 網域，再用 Cloud Run 網域對應或 Load Balancer。
- `.taipei` 註冊局支援中文 IDN；申請時直接用「配.taipei」查詢與註冊即可（Gandi 等國際註冊商有支援 .taipei）。

### 步驟三（選用）：信箱 DNS

信箱有兩件獨立的事，記錄不同，互不衝突，也都與 Hosting 的 A/TXT 記錄相容：

**A. 收信**（例如 `contact@xn--ej4a.taipei`）——需要一個收信服務，DNS 填該服務給的 MX：

| 類型 | 主機名稱 | 值 | 用途 |
|---|---|---|---|
| MX | apex/@ | 收信服務提供（含優先序，可能多筆） | 信件路由 |
| TXT | apex/@ | 該服務的 SPF（見下方合併規則） | 防偽寄件者 |

服務選項（由簡到繁）：註冊商附贈信箱（Gandi 註冊網域含免費信箱，MX 用其預設值即可）、免費轉寄服務（ImprovMX 等，把 contact@ 轉到既有 Gmail）、正式信箱代管（Google Workspace／Zoho）。

**B. 寄信：Firebase Auth 登入信改用自己的網域**（解決登入信進垃圾郵件的根本辦法）：

1. Firebase Console → Authentication → Templates →「自訂網域」→ 輸入網域
2. Console 會產生**專屬的驗證 TXT、SPF TXT 與 DKIM CNAME 記錄**——值以 Console 顯示為準，照抄到 DNS
3. 驗證通過後，登入信寄件者變成 `noreply@xn--ej4a.taipei`；前端以 `VITE_MAIL_SENDER`（與選填的 `VITE_MAIL_SENDER_DISPLAY`）把寄件者顯示在「請檢查垃圾郵件」提示中

**共同規則：**

- **SPF 一個網域只能有一筆** `v=spf1 ...` TXT。同時要收信＋Firebase 寄信時必須合併成一筆，例如：
  `v=spf1 include:_spf.google.com include:_spf.firebasemail.com ~all`（include 內容依實際服務）
- 建議加 DMARC：TXT `_dmarc` → `v=DMARC1; p=quarantine; adkim=r; aspf=r`（先用 `p=none` 觀察也可）
- **IDN 注意**：信箱地址實際是 `user@xn--ej4a.taipei`，中文形式的顯示與相容性依收件方而定，部分郵件服務不支援 IDN 網域註冊——對外聯絡信箱若在意觀感，可考慮另備一個 ASCII 網域或用轉寄。收 Firebase 登入信的是**使用者自己的信箱**，不受此影響。

## Cloud Run（API）

- `cloudbuild.yaml`：main 分支自動 build → Artifact Registry → `gcloud run deploy`（`asia-east1`、`min-instances=0`）
- 環境變數與密鑰一律 Secret Manager 掛載：`DATABASE_URL`（Cloud SQL Connector）、`EMAIL_HMAC_PEPPER`、`INTERNAL_TASK_SECRET`
- 正式環境必要設定（`local`／`mock`／`in-process` 在 production 會拒絕啟動）：
  - `AUTH_PROVIDER=firebase` + `FIREBASE_PROJECT_ID`
  - `KEK_PROVIDER=kms` + `KMS_KEY_NAME`（完整金鑰資源路徑；輪替 90 天）
  - `MODERATION_PROVIDER=vertex` + `MODERATION_MODEL` + `GCP_PROJECT_ID`
    - `MODERATION_LOCATION`（預設 `global`；Gemini 3.x 僅 global 端點提供）
    - `MODERATION_TIMEOUT_MS`（非同步 worker，預設 25000）／`MODERATION_SYNC_TIMEOUT_MS`（訊息同步審核，預設 3000；啟用 Model Armor 後建議 4000，平台層篩查約增加 1 秒延遲）／`NAME_MODERATION_TIMEOUT_MS`（公開名稱行內審查，預設 12000——名稱寫入是「當場收或退」，容許時間抓寬鬆，ADR-022）
    - Model Armor（ADR-016）：global 端點不支援 per-request template，改用**專案層 floor settings**（Console → Security → Model Armor，或 REST `PATCH /v1/projects/<PROJECT_ID>/locations/global/floorSetting`）啟用 PI/jailbreak + 惡意連結過濾與 Vertex AI 整合；被攔截的 prompt 會以 medium（進人工審核）處理，不觸發停權三振。`MODEL_ARMOR_TEMPLATE` 僅供未來改用區域端點時掛 template
    - 檢舉複審（ADR-018）：`REPORT_MODERATION_MODEL`（Vertex Model Garden 上的 Anthropic Claude 模型 id，如 `claude-opus-5`；未設定則檢舉退回預設審核器）＋ `REPORT_MODERATION_TIMEOUT_MS`（預設 60000，僅走非同步佇列）。需在 Model Garden 啟用該 Claude 模型；服務帳號沿用 `aiplatform.user`
  - `MODERATION_QUEUE=cloud-tasks` + `CLOUD_TASKS_QUEUE_PATH` + `MODERATION_TASK_TARGET_URL`（見下方 Cloud Tasks）
  - `ADMIN_EMAILS`（人工審核後台名單）
  - `ALLOWED_ORIGINS`：前端來源（Hosting 網域與自訂網域，逗號分隔）——前端跨源直連 API 時必填
- 選用（皆有預設，ADR-025／028／031）：
  - `RATE_LIMIT_*`：帳號層限流覆寫（預設值見 `.env.example`）
  - `DB_POOL_MAX`（預設 10）：每個 Cloud Run 實例的連線池上限；`max-instances × DB_POOL_MAX` 必須小於 Cloud SQL `max_connections`
  - `MODERATION_REQUEUE_AFTER_MINUTES`（預設 15）：待審內容超過此時間仍無審核紀錄即由 cleanup 重新入列
  - `EMAIL_HMAC_PEPPER_PREVIOUS`：pepper 輪替期間的舊值（見下方「Email lookup 重算」）
- 服務帳號最小權限：`cloudsql.client`、`cloudkms.cryptoKeyEncrypterDecrypter`、`aiplatform.user`、`cloudtasks.enqueuer`；Cloud Tasks／Scheduler 用的呼叫端服務帳號另需 `run.invoker`（若 Cloud Run 不允許未驗證呼叫）
- **reCAPTCHA Enterprise 尚未啟用**：`RECAPTCHA_SITE_KEY`／`VITE_RECAPTCHA_SITE_KEY` 目前留空＝整個略過（ADR-014 不做半套）。開放公眾使用前應在 Console 建立 site key（score-based、網域填 Hosting 網域與 `xn--ej4a.taipei`）並同時設定前後端兩個變數；只設一邊會使開團／申請全部失敗。
- 優雅關機：收到 SIGTERM 停收新連線→等待進行中請求→關閉 DB pool；Cloud Run 預設 10 秒寬限期足夠。

### Cloud Tasks（審核佇列）

```bash
gcloud tasks queues create teamup-moderation \
  --location=asia-east1 \
  --max-attempts=6 \
  --min-backoff=10s \
  --max-backoff=300s \
  --max-concurrent-dispatches=20
```

- `CLOUD_TASKS_QUEUE_PATH=projects/<PROJECT_ID>/locations/asia-east1/queues/teamup-moderation`
- `MODERATION_TASK_TARGET_URL=<API_ORIGIN>/internal/moderation/tasks`
- worker 以 `x-task-secret` 驗證（常數時間比對），並且**冪等**（ADR-027）：重試不會覆蓋人工判定、不重複計入三振，所以 `max-attempts` 可放心設大於 1。
- 6 次嘗試 × 最長 300 秒退避 ≈ 20 分鐘內耗盡；耗盡後內容留在 pending_review，由每日 cleanup 重新入列（`MODERATION_REQUEUE_AFTER_MINUTES`）。

### Cloud Scheduler（每日清理）

每日 03:30（Asia/Taipei）呼叫 `POST /internal/cleanup`，header `x-task-secret`。密鑰值從 Secret Manager 取出放進 shell 變數，**不要**寫進指令歷史或文件：

```bash
INTERNAL_TASK_SECRET="$(gcloud secrets versions access latest --secret=internal-task-secret --project=<PROJECT_ID>)"

gcloud scheduler jobs create http teamup-cleanup \
  --project=<PROJECT_ID> \
  --location=asia-east1 \
  --schedule="30 3 * * *" \
  --time-zone="Asia/Taipei" \
  --uri="<API_ORIGIN>/internal/cleanup" \
  --http-method=POST \
  --headers="x-task-secret=$INTERNAL_TASK_SECRET,Content-Type=application/json" \
  --message-body='{}' \
  --attempt-deadline=300s \
  --max-retry-attempts=2 \
  --oidc-service-account-email=<SCHEDULER_SA>@<PROJECT_ID>.iam.gserviceaccount.com

# 建好後手動觸發一次確認 200
gcloud scheduler jobs run teamup-cleanup --project=<PROJECT_ID> --location=asia-east1
```

（`--oidc-service-account-email` 只在 Cloud Run 要求已驗證呼叫時需要；服務允許未驗證呼叫則可省略，安全性由 `x-task-secret` 提供。Scheduler 的 header 會存在 job 設定中，輪替 secret 時要 `gcloud scheduler jobs update http ... --update-headers=...`。）

**cleanup 回應欄位與告警**（ADR-025）：

| 欄位 | 意義 | 建議 |
|---|---|---|
| `hardDeleteFailures` | 軟刪滿 30 天但硬刪失敗的帳號數（逐筆執行，不互相影響） | **> 0 告警**：查 Cloud Logging 該次 request 的錯誤，通常是 FK 或連線問題；下次排程會再試 |
| `requeuedForReview` | 超過 `MODERATION_REQUEUE_AFTER_MINUTES` 仍無審核紀錄而重新入列的待審內容數 | 持續 > 0 代表 Cloud Tasks enqueue 或 worker 有問題（佇列暫停、`run.invoker` 權限、secret 不符） |
| `purgedModerationRecords` | 超過 180 天而清除的審核紀錄數 | 資訊性 |
| `purgedAuditLogs` | 超過 180 天而清除的稽核紀錄數 | 資訊性 |
| 其他既有欄位 | 依活動 `retention_days` 清除的隊伍／thread／參加者數、硬刪帳號數 | 資訊性 |

可用 Cloud Logging 的 log-based alert 監看 `hardDeleteFailures > 0`，或讓 Scheduler 的失敗（非 2xx）進 Cloud Monitoring uptime／alerting。

### Email lookup 重算（`rehash:email-lookups`）

Email canonical 形式改變（ADR-028：去 `+tag`、Gmail 去點）或 pepper 輪替後，既有 `users.email_lookup` 必須重算一次，否則舊帳號登入會被當成新帳號。

步驟（建議在維護窗執行，數分鐘內完成）：

1. **先部署**含新 canonical 邏輯的 API（新登入立刻用新形式；舊列由 `EMAIL_HMAC_PEPPER_PREVIOUS`／rehash 銜接）。
2. 在能連到 Cloud SQL 的環境（Cloud Build 內網 job、或有 Auth Proxy 的機器）以**正式環境同一組** `DATABASE_URL`、`EMAIL_HMAC_PEPPER`、`KEK_PROVIDER=kms` + `KMS_KEY_NAME` 執行 dry run：

   ```bash
   pnpm --filter @teamup/api rehash:email-lookups -- --dry
   ```

   輸出 `scanned/updated/unchanged/conflicts/failures` 與會變動的 user id（**不印地址**）。
3. dry run 無 `failures` 後正式執行（同指令去掉 `--dry`）。腳本冪等，可重跑。
4. **conflict 處理**：兩列塌縮到同一 canonical（例如 `a.b@gmail.com` 與 `ab@gmail.com` 在改版前各自註冊）時腳本**不自動合併**，先到的列保留、後到的列維持舊 lookup 並印出 id，exit code 2。處理方式：由當事人登入（會落到保留的那一列）自行決定，或管理員以後台停權／當事人刪除多餘帳號後重跑。
5. pepper 輪替時：新舊 pepper 同時設定（`EMAIL_HMAC_PEPPER` 新、`EMAIL_HMAC_PEPPER_PREVIOUS` 舊）部署 → 跑 rehash → 確認 `unchanged == scanned` → 移除 `EMAIL_HMAC_PEPPER_PREVIOUS` 再部署一次。

`failures > 0`（解密失敗）代表 KEK 設定與寫入時不同，**停止並檢查** `KMS_KEY_NAME`，不要在錯的金鑰下繼續。

## Firebase 專案注意事項

- GCP 專案與 Firebase 專案是 1:1。若原專案上已有其他服務使用 Firebase Auth，
  在同一專案啟用會**共用同一個使用者庫**——建議為 teamup 另建獨立 GCP/Firebase 專案
  （Cloud SQL 正式實例也應獨立，見 ADR-011）。
- Firebase Console → Authentication：啟用 Google 與 Email link（無密碼）兩種登入方式；
  Authorized domains 加入 `xn--ej4a.taipei`。
- 前端環境值：`VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_AUTH_DOMAIN` / `VITE_FIREBASE_PROJECT_ID`
 （三者齊備自動啟用 Firebase 登入，否則 fallback 到 dev 登入）。前端只在偵測到既有登入（localStorage 提示）或 email link 時才載入 Firebase SDK（ADR-032）。

## 前端（Firebase Hosting）

`firebase.json` 是**範本**：CSP 的 `connect-src` 以 `__API_ORIGIN__` 佔位，repo 內不出現部署網址（ADR-033）。部署前先由 `deploy/render-firebase-config.mjs` 產生 gitignored 的 `firebase.deploy.json`：

```bash
export VITE_EVENT_SLUG=<event-slug>
export VITE_API_BASE_URL=<API_ORIGIN>            # 必須 https
export VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=... VITE_FIREBASE_PROJECT_ID=...

pnpm --filter @teamup/web build                  # 產出 apps/web/dist
node deploy/render-firebase-config.mjs           # 讀 VITE_API_BASE_URL（或 API_ORIGIN）→ firebase.deploy.json
firebase deploy --only hosting --project <PROJECT_ID> --config firebase.deploy.json
```

- 腳本也會讀 `.env.local`（不覆蓋已設定的環境變數），本機部署可直接跑。
- 範本內容：CSP（`frame-ancestors 'none'`、`form-action 'self'`、`font-src 'self' fonts.gstatic.com`）、HSTS、nosniff、Referrer-Policy、Permissions-Policy；`/assets/**` 為 Vite 帶 hash 的檔名，快取 `immutable, max-age=31536000`；`index.html`／`/`／json／txt 為 `no-cache`，確保新版部署後立即生效。
- 忘記 render 直接 `firebase deploy` 會把字面值 `__API_ORIGIN__` 寫進 CSP，前端所有 API 呼叫被瀏覽器擋下——這是刻意的 fail-closed。
