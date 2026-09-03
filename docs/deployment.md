# 部署與網域設定

## 部署形態

| 資源 | 形態 |
|---|---|
| API（Cloud Run） | `asia-east1`，服務帳號最小權限，KMS KEK + Vertex 審核 + Secret Manager |
| 前端（Firebase Hosting） | 建置時以 `VITE_EVENT_SLUG` 指定當期活動 |
| 資料庫 | Cloud SQL PostgreSQL；migration + seed 由 `deploy/cloudbuild-migrate.yaml` 在 Cloud Build 內網執行（實例連線名以 `--substitutions=_INSTANCE=...` 帶入） |
| Firebase Auth | 建議獨立 Firebase 專案（Google / Email link 需在 Console 啟用） |

（實際場測環境的專案 ID、網址與實例位置記錄在 `docs/deployment.local.md`，不進公開 repo。）

注意：外部監控請打 `/api/healthz`——`/healthz` 在 `*.run.app` 會被 Google 前端攔截（容器探測不受影響）。
正式上線前應：換獨立 Cloud SQL 實例、把 Hosting 與 Cloud Run 收攏到同一專案（rewrites 免 CORS）、掛上 `xn--ej4a.taipei`。

## 網域：配.taipei

自訂網域為中文 IDN：**配.taipei**，DNS 與 GCP 一律使用 punycode 形式 **`xn--ej4a.taipei`**（部分註冊商介面可直接輸入中文，實際記錄仍是 punycode）。

架構上只需要**一個網域**：前端掛 Firebase Hosting，`/api/**` 由 Hosting rewrite 轉給 Cloud Run，瀏覽器全程同源。

### 步驟一：GCP / Firebase 端

1. Firebase Console → Hosting → 「新增自訂網域」→ 輸入 `xn--ej4a.taipei`
2. Console 會給一組 **TXT 驗證記錄**（含 ACME challenge），照抄到註冊商
3. 驗證通過後，Console 會給 **2 筆 A 記錄** 的 IP，照抄到註冊商
4. SSL 憑證由 Firebase 自動簽發與續期（數分鐘到 24 小時）

`firebase.json` 的 rewrite 設定：

```json
{
  "hosting": {
    "public": "apps/web/dist",
    "cleanUrls": true,
    "rewrites": [
      { "source": "/api/**", "run": { "serviceId": "teamup-api", "region": "asia-east1" } },
      { "source": "**", "destination": "/index.html" }
    ]
  }
}
```

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
- 不需要為 API 另設子網域（`/api/**` 走 rewrite）。若日後要獨立 API 網域，再用 Cloud Run 網域對應或 Load Balancer。
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
3. 驗證通過後，登入信寄件者變成 `noreply@xn--ej4a.taipei`

**共同規則：**

- **SPF 一個網域只能有一筆** `v=spf1 ...` TXT。同時要收信＋Firebase 寄信時必須合併成一筆，例如：
  `v=spf1 include:_spf.google.com include:_spf.firebasemail.com ~all`（include 內容依實際服務）
- 建議加 DMARC：TXT `_dmarc` → `v=DMARC1; p=quarantine; adkim=r; aspf=r`（先用 `p=none` 觀察也可）
- **IDN 注意**：信箱地址實際是 `user@xn--ej4a.taipei`，中文形式的顯示與相容性依收件方而定，部分郵件服務不支援 IDN 網域註冊——對外聯絡信箱若在意觀感，可考慮另備一個 ASCII 網域或用轉寄。收 Firebase 登入信的是**使用者自己的信箱**，不受此影響。

## Cloud Run（API）

- `cloudbuild.yaml`：main 分支自動 build → Artifact Registry → `gcloud run deploy`（`asia-east1`、`min-instances=0`）
- 環境變數與密鑰一律 Secret Manager 掛載：`DATABASE_URL`（Cloud SQL Connector）、`EMAIL_HMAC_PEPPER`、`INTERNAL_TASK_SECRET`
- 正式環境必要設定（`local`／`mock` 在 production 會拒絕啟動）：
  - `AUTH_PROVIDER=firebase` + `FIREBASE_PROJECT_ID`
  - `KEK_PROVIDER=kms` + `KMS_KEY_NAME`（完整金鑰資源路徑；輪替 90 天）
  - `MODERATION_PROVIDER=vertex` + `MODERATION_MODEL` + `GCP_PROJECT_ID`
    - `MODERATION_LOCATION`（預設 `global`；Gemini 3.x 僅 global 端點提供）
    - `MODERATION_TIMEOUT_MS`（非同步 worker，預設 25000）／`MODERATION_SYNC_TIMEOUT_MS`（訊息同步審核，預設 3000；啟用 Model Armor 後建議 4000，平台層篩查約增加 1 秒延遲）／`NAME_MODERATION_TIMEOUT_MS`（公開名稱行內審查，預設 12000——名稱寫入是「當場收或退」，容許時間抓寬鬆，ADR-022）
    - Model Armor（ADR-016）：global 端點不支援 per-request template，改用**專案層 floor settings**（Console → Security → Model Armor，或 REST `PATCH /v1/projects/{p}/locations/global/floorSetting`）啟用 PI/jailbreak + 惡意連結過濾與 Vertex AI 整合；被攔截的 prompt 會以 medium（進人工審核）處理，不觸發停權三振。`MODEL_ARMOR_TEMPLATE` 僅供未來改用區域端點時掛 template
    - 檢舉複審（ADR-018）：`REPORT_MODERATION_MODEL`（Vertex Model Garden 上的 Anthropic Claude 模型 id，如 `claude-opus-5`；未設定則檢舉退回預設審核器）＋ `REPORT_MODERATION_TIMEOUT_MS`（預設 60000，僅走非同步佇列）。需在 Model Garden 啟用該 Claude 模型；服務帳號沿用 `aiplatform.user`
  - `MODERATION_QUEUE=cloud-tasks` + `CLOUD_TASKS_QUEUE_PATH` + `MODERATION_TASK_TARGET_URL`
  - `RECAPTCHA_SITE_KEY`（選用；設定即啟用開團/申請的 captcha 檢查）
  - `ADMIN_EMAILS`（人工審核後台名單）
- 服務帳號最小權限：`cloudsql.client`、`cloudkms.cryptoKeyEncrypterDecrypter`、`aiplatform.user`、`cloudtasks.enqueuer`
- **Cloud Scheduler**：每日 `POST {API}/internal/cleanup`，header `x-task-secret: $INTERNAL_TASK_SECRET`（資料保存期限清理 + 帳號硬刪 + audit log 輪替）

## Firebase 專案注意事項

- GCP 專案與 Firebase 專案是 1:1。若原專案上已有其他服務使用 Firebase Auth，
  在同一專案啟用會**共用同一個使用者庫**——建議為 teamup 另建獨立 GCP/Firebase 專案
  （Cloud SQL 正式實例也應獨立，見 ADR-011）。
- Firebase Console → Authentication：啟用 Google 與 Email link（無密碼）兩種登入方式；
  Authorized domains 加入 `xn--ej4a.taipei`。
- 前端環境值：`VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_AUTH_DOMAIN` / `VITE_FIREBASE_PROJECT_ID`
 （三者齊備自動啟用 Firebase 登入，否則 fallback 到 dev 登入）。

## 前端

```bash
pnpm --filter @teamup/web build   # 產出 apps/web/dist
firebase deploy --only hosting
```
