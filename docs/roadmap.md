# Roadmap：M7 多活動與活動管理

狀態（2026-09-09）：**B 活動管理已上線**（任務 2、3、4、7 完成，設計規格見 `docs/design/admin-events.md`）；**A 前端活動層待確認範圍**（任務 5、6、8、9）。對應 ADR-035。

## 為什麼

- 後端從第一天起就是多活動架構：所有資料路由帶活動 slug、一人一隊／參加資料／檢舉都以活動為範圍隔離、後台 API 吃 `?event=`。前端卻在建置時用 `VITE_EVENT_SLUG` 釘死一場活動，路徑沒有活動前綴。兩場活動重疊時，網站只能呈現其中一場。
- 開一場新活動目前等於：寫一個 seed JSON → 有 repo 權限的人跑 `pnpm seed`（需進 GCP 內網）→ 必要時改 `VITE_EVENT_SLUG` 重新部署前端。接手的營運人員通常不具備這三件事的任何一件。

## 目標

1. 多場活動可同時開放，同一個網址、同一個帳號，使用者在首頁選活動。
2. 管理員在後台用表單建立與編輯活動，不需要寫 JSON、不需要部署。
3. JSON seed 仍是有效的匯入／匯出格式（repo 備份、版本控制、測試 fixture），表單與 JSON 走同一套 `EventConfigSchema` 驗證。

## 非目標

- 跨活動的隊伍或訊息（隊伍永遠屬於一場活動；訊息 thread 已有 eventId，維持）。
- 活動層級的管理員權限分工（仍是平台級 `ADMIN_EMAILS`；活動級權限另開 ADR）。
- 報名、繳費、簽到等賽務功能（平台只做媒合，見服務條款）。

## 設計要點（ADR-035 草稿）

### A. 前端活動層

- 路徑加活動前綴：`/e/:slug`（活動首頁）、`/e/:slug/teams`、`/e/:slug/teams/:id`、`/e/:slug/people`、`/e/:slug/applications`。舊路徑 `/teams` 等在只有一場 open 活動時 302 到該活動，多場時導到活動選擇頁（保住既有連結與 QR code）。
- `/`：列出 open 活動（名稱、時間、招募截止、人數規則）；只有一場時直接顯示該活動首頁（與現況體驗一致）。
- event store 改為以路徑 slug 為鍵的快取（`byslug`），`ensureLoaded(slug)`；`VITE_EVENT_SLUG` 降級為「預設活動」而非唯一活動。
- 個人檔案頁：帳號區塊不變；參加資料改為每場 open 活動一個區塊（可折疊），各自儲存。
- 站內訊息：跨活動一頁；thread 列表標示活動名稱；建立 thread 的權限檢查維持以該 thread 的活動為範圍。
- 後台：頂部活動切換器（預設「全部」，統計頁需選一場）；檢舉紀錄與風險清單標示活動。
- 術語 `termTeam`／`termMember` 依當前路徑的活動取值——所有頁面本來就從 event store 讀，改動集中在 store。

### B. 活動管理（後台）

- 新頁籤「活動」：列表（slug、名稱、狀態、時間、隊伍數）＋「建立活動」「複製為新活動」。
- 表單欄位一一對應 `EventConfigSchema`：名稱、說明、開始／結束／招募截止、人數上下限、一人可否多團、聯絡人數、是否需年齡確認、隊伍／成員稱呼、資料保存天數、自訂標籤數量與長度。時間欄位以 Asia/Taipei 輸入，存 ISO 8601 with offset。
- 字典編輯：角色、技能兩張表格（名稱、分類、排序、啟用）。`key` 由系統從名稱產生（拉丁化＋去重），使用者不碰；已被選用的項目只能停用（`isActive=false`），不能刪除。
- 狀態機：`draft`（對外不可見、可自由改）→ `open` → `closed`。`EVENT_STATUSES` 需加 `draft`；公開列表與所有資料路由只認 `open`／`closed`。
- 護欄（伺服端強制）：slug 建立後不可改；已有隊伍時 `maxMembers` 不得低於現有最大隊伍人數、`minMembers` 不得高於它；`requiredContacts` 不得超過 `maxMembers`（schema 已有）；`recruitClosesAt` 不得早於現在若已 open；每次寫入記 `audit_logs`（`admin_event_create`／`admin_event_update`）。
- API：`GET /api/admin/events`、`POST /api/admin/events`、`PUT /api/admin/events/:slug`、`POST /api/admin/events/:slug/duplicate`、`GET /api/admin/events/:slug/export`（回 seed 相容 JSON）。寫入重用 `seed/upsert.ts` 的邏輯（抽成 service），確保 seed 與表單同一條路。
- `pnpm seed` 維持，作為初始化與 CI fixture 匯入。

### C. 相容與遷移

- 既有活動 `codefest-2026-fall` 不需遷移；新增 `draft` 狀態為 enum 擴充（migration 一筆）。
- 舊 QR code／連結（無前綴）靠 302 相容至活動結束。
- e2e：smoke 加活動選擇頁；journey 改走 `/e/:slug/...`。

## 任務拆解

| # | 任務 | 範圍 | 估時 | 依賴 |
|---|---|---|---|---|
| 1 | ADR-035 定稿（B 部分已定案，A 部分待確認） | docs | 0.5h | — |
| 2 ✅ | shared：admin events schema／型別／錯誤碼；`draft`／`archived` 狀態原本就在，無需 migration | packages/shared | 2h | 1 |
| 3 ✅ | api：`EventAdminService`（建立／更新／狀態／複製／匯出／刪除、護欄、audit）＋ `DbEventAdminRepository`；seed CLI 與後台共用 `seed/upsert.ts` | apps/api | 1d | 2 |
| 4 ✅ | api：`GET /api/events` 只列 open／closed；admin 路由與 zod；24 個路由測試（403、護欄、狀態矩陣、匯出 round-trip） | apps/api | 0.5d | 3 |
| 5 | web：router 改 `/e/:slug/*` ＋舊路徑 302 守衛；event store 多活動快取；首頁活動選擇 | apps/web | 1d | — |
| 6 | web：個人檔案多活動參加資料；訊息頁活動標示；後台活動切換器 | apps/web | 0.5d | 5 |
| 7 ✅ | web：`/admin/events`（列表、起點選擇、三欄編輯器、字典編輯、狀態卡、匯出 JSON）；已在正式站以 Chrome 走完「範本→草稿→開放→編輯→關閉→封存」 | apps/web | 1.5d | 4 |
| 8 | e2e 與 Playwright 快照更新；README「換一場活動」改寫成「後台建立活動；JSON 為進階／備份用」；docs/architecture.md 路徑表 | e2e, docs | 0.5d | 5, 7 |
| 9 | 部署：Hosting 不需重建（不再依賴 `VITE_EVENT_SLUG`）；API 一次部署＋migration；場測驗證 | infra | 0.5d | 8 |

總計約 5 個工作日。第 5 項與第 2–4 項可並行。

## 開放問題

- 活動選擇頁的排序：依開始時間？依招募截止？（建議：招募中優先，其次依開始時間）
- `draft` 活動是否允許管理員預覽前台？（建議：允許，網址帶 `?preview=1` 且僅管理員 token 可讀）
- 是否需要「封存」狀態隱藏已結束多年的活動？（`retentionDays` 到期資料已清，列表可依 `endsAt` 自動摺疊，暫不加狀態）
