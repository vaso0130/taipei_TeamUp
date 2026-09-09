# 設計規格：後台「活動管理」

狀態：實作中（2026-09-09）。對應 ADR-035、`docs/roadmap.md` 任務 2–4、7。

## 1. 誰在用、要完成什麼

| 角色 | 情境 | 成功的樣子 |
|---|---|---|
| 活動主辦的營運人員（不會寫程式、沒有 repo 權限） | 明年要再辦一場，規則跟去年差不多 | 三分鐘內從「複製去年」開始，改日期與人數，存成草稿，隔天再回來補技能字典，最後按「開放」 |
| 第一次接手的人 | 完全不知道什麼是 slug、JSON | 從範本開始，每個欄位旁有一句白話說明，填錯當場知道，開放前系統幫他檢查漏了什麼 |
| 平台管理員（工程師） | 要備份設定進 repo、要在 CI 用同一份 fixture | 一鍵匯出 JSON，格式與 `apps/api/seeds/events/*.json` 完全相同 |

核心原則：**表單與 JSON 是同一份資料的兩個入口**，都走 `EventConfigSchema` 驗證；表單永遠不會產生 seed 無法接受的設定，反之亦然。

## 2. 資訊架構與路徑

```
/admin                      既有後台（頁籤列加一個入口「活動管理」）
/admin/events               活動列表
/admin/events/new           建立：先選起點（範本／複製／空白），再進編輯器
/admin/events/:slug         編輯器（同一個元件，new 與 edit 共用）
```

編輯器是獨立頁面而不是後台的一個頁籤：欄位多、要能深連結、要有離開守衛。

### 活動列表

- 卡片式（不是表格）：每張卡＝一場活動。左上狀態徽章（草稿／開放中／已關閉／已封存），標題＝活動名稱，副標＝slug（等寬字、灰）。
- 三個數字一行：活動日期區間、招募截止、`隊伍 n・參加者 n`（術語走該活動自己的 termTeam）。
- 動作列：**編輯**（主要）、複製為新活動、匯出 JSON。狀態切換不放在列表，放編輯器（要看到後果說明）。
- 排序：開放中 → 草稿 → 已關閉 → 已封存；同組內依開始時間。已封存預設摺疊在「顯示已封存（n）」之後。
- 空狀態（沒有任何活動）：一張大卡「建立第一場活動」＋三個起點按鈕，直接就是 `/admin/events/new` 的內容。
- 頂部右側「建立活動」主按鈕。

### 建立起點（`/admin/events/new`）

三選一的卡片，選了就進編輯器並預填：

1. **從範本開始**：列出 API 提供的範本（來自 repo 內建 seed：黑客松、讀書會），每個範本一句話描述其規則差異。
2. **複製既有活動**：下拉選一場；預填全部欄位，名稱加「（複本）」，slug 清空要求重填，狀態強制草稿，日期保留但在時程區塊顯示黃色提示「這是複製來的日期，請確認」。
3. **空白**：只有預設值（人數 1–1、無字典）。

## 3. 編輯器版面

桌機（≥1024）：三欄。左 200px 黏性區塊導覽（錨點清單，目前區塊高亮，含每區錯誤數的紅點）；中間表單（max-width 720）；右 320px 黏性**即時預覽**。窄螢幕：區塊導覽變成頂部可橫向捲動的 chips，預覽收成底部可展開的抽屜「預覽前台顯示」。

頂部固定列：返回列表、活動名稱（未命名時顯示「未命名活動」）、狀態徽章、「已儲存 ／ 有未儲存的變更」文字（`role=status`）。

底部黏性動作列：**儲存**（主要；無變更時 disabled）、放棄變更（次要；有變更時才出現，需確認）、右側狀態切換按鈕（見 §6）。儲存中顯示 loading，成功後短暫「已儲存」（3 秒），失敗顯示錯誤摘要（見 §5）。

### 區塊與欄位

每個欄位：可見 label、一句白話說明（helper）、必要時範例。所有輸入 ≥44px 高。

**① 基本資料**
- 活動名稱（必填，1–100）。helper：「會出現在首頁標題與登入信」。
- 網址代號 slug（必填，規則同 shared 的 `eventSlug`：`^[a-z0-9][a-z0-9-]*$`，建議 3–60）。建立時預設自動產生 `event-YYYYMM-xxxx`，可改；**建立後鎖定**（灰底、鎖頭 icon、說明「建立後不可更改，因為它是分享連結的一部分」）。即時顯示會變成的網址。
- 活動說明（0–2000，多行）。helper：「首頁第一段文字。放報名連結、注意事項；未滿 18 歲的規定也寫在這」。字數計數。

**② 時程**（三個 `datetime-local`，以 Asia/Taipei 輸入，存成帶 offset 的 ISO）
- 活動開始、活動結束、招募截止。每個顯示星期幾。
- 下方一行動態摘要：「招募期到 10/30（四）23:59，距活動開始 8 天」。
- 交叉驗證（blur 時）：結束須晚於開始；招募截止不得晚於活動結束；招募截止早於現在時顯示警告（非錯誤）「招募已截止，開放後參加者無法開團」。

**③ 組隊規則**
- 人數：兩個數字輸入（最少／最多）並排，右側即時句子「每{termTeam} 4–5 人」。最少 ≥1，最多 ≥ 最少。
- 一人限加入一個{termTeam}（switch）。helper 說明兩種模式的差別。
- 成隊後需指定聯絡人數（數字，0–maxMembers）。0 時 helper 顯示「不需要聯絡人」。
- 需要年齡確認（switch）。helper：「開啟後參加者填資料時必須回答是否年滿 18 歲；平台不收同意書」。

**④ 用語**
- {termTeam} 稱呼（預設「隊伍」）、{termMember} 稱呼（預設「成員」）。
- 即時預覽三句前台文案：「每人限加入一個{termTeam}」「成{termTeam}後需指定 2 位聯絡人」「找{termTeam}／找人」。

**⑤ 角色字典**、**⑥ 技能字典**（同一個 `DictionaryEditor` 元件，技能多一欄「分類」）
- 列＝一個選項：拖曳不做，用「上移／下移」按鈕排序（鍵盤可用）；名稱（必填，≤50）；分類（技能限定，文字輸入＋既有分類 datalist）；啟用 switch；刪除按鈕。
- **刪除規則**：尚未儲存的新列直接刪；已儲存且「使用中 n 人」＞0 的列，刪除鈕 disabled 並顯示 tooltip「已有 n 人選用，只能停用」；使用中 0 人可刪（伺服端也擋）。
- 底部「新增角色／新增技能」輸入列，Enter 新增；技能新增時分類預設為上一列的分類。
- key 不對使用者顯示，由前端自動產生（規則同 shared 的 `optionKey`：`^[a-z][a-z0-9_]*$`）：名稱含拉丁字母數字 → snake_case（`spring_framework`）；純中文 → `role_01`／`skill_01` 遞增；同一活動內唯一；既有列的 key 永不改變。進階者可在列展開的「更多」看到 key（唯讀）。
- 空字典時區塊顯示提示：「開放前至少要有一個角色與一個技能」。
- 窄螢幕：每列改成兩行卡片，不做橫向捲動表格。

**⑦ 自訂標籤與資料保存**
- 每人可加自訂技能標籤數（0–20；0＝關閉）、每個標籤最長字數（1–30）。helper 說明審核也會套用。
- 資料保存天數（1–3650，預設 90）。helper：「活動結束後幾天自動刪除隊伍、參加資料與訊息」。

**⑧ 狀態與發布**（見 §6）

## 4. 即時預覽

右欄呈現參加者在首頁會看到的精華：eyebrow（活動名稱）、標題（名稱）、說明前 120 字、日期三行、規則 chips（「每人限加入一個{termTeam}」「成{termTeam}後需指定 n 位聯絡人」「未滿 18 歲…」）、角色 chips、技能依分類分組 chips。用前台同一套 `.chip`／token，讓「改一個字立刻看到效果」。草稿也能預覽（因為就是本地資料）。

## 5. 驗證與錯誤

- blur 驗證單欄；跨欄位規則在相關欄位任一 blur 後檢查。
- 送出失敗（前端或伺服端）：表單頂端出現**錯誤摘要**（`role=alert tabindex=-1`，聚焦到它），標題「有 n 個地方需要修正」，每項是連到該欄位的連結；同時保留欄位旁的 inline 錯誤（`aria-describedby`、`aria-invalid`）。左側區塊導覽顯示每區錯誤數。
- 伺服端錯誤碼 → 欄位訊息對應：
  - `slug_taken` → slug：「這個代號已被使用」
  - `slug_immutable` → slug：「建立後不可更改」
  - `max_members_below_existing` → maxMembers：「已有{termTeam}有 n 人，上限不能低於 n」
  - `min_members_above_existing` → minMembers：「已有{termTeam}只有 n 人，下限不能高於 n」
  - `dictionary_key_in_use` → 該列：「已有 n 人選用，只能停用不能刪除」
  - `cannot_open_incomplete` → 摘要列出缺少項（伺服端回 `details: string[]`）
  - `invalid_status_transition` → 狀態卡：「目前狀態不能直接變成 X」
  - `validation_failed`（zod issues）→ 依 `path` 對到欄位，對不到的放摘要。
- 儲存成功：底部列「已儲存 09:41」＋ `role=status`。

## 6. 狀態生命週期

```
draft ──開放──▶ open ──關閉──▶ closed ──封存──▶ archived
  ▲                │              │
  └──（不可逆）      └──重新開放──▶ open（允許）
```

狀態卡（區塊 ⑧）內容：目前狀態徽章＋一段「參加者現在看到什麼」的說明；下一步按鈕一顆，次要動作以文字連結呈現：

| 目前 | 主要動作 | 說明文字 | 確認對話框內容 |
|---|---|---|---|
| draft | 開放活動 | 「草稿對外不可見。開放後會出現在首頁，參加者可以填資料、開團。」 | 開放前檢查清單（伺服端回傳）：名稱、三個時間有效、招募截止在未來、人數規則、≥1 角色、≥1 技能。有缺就列出並禁止。 |
| open | 關閉招募與活動 | 「參加者可以開團、申請、傳訊息。」 | 「關閉後不能再開團與申請，既有{termTeam}與訊息仍可見；可以重新開放。」 |
| closed | 封存 | 「不能開團與申請；資料依保存天數清除。」次要：重新開放 | 「封存後從所有列表消失，直接連結仍可讀。此動作不可逆。」 |
| archived | （無） | 「已封存。」 | — |

狀態變更是獨立 API（不是隨儲存一起送），有未儲存變更時按鈕 disabled 並提示「先儲存變更」。

刪除活動：只有 **草稿且沒有任何參加者／隊伍** 可刪，按鈕放在狀態卡最下方紅色文字連結；其他狀態不提供刪除，只有封存。

## 7. 無障礙與細節

- 所有控制項 ≥44px；switch 用 `role=switch aria-checked`；上移／下移按鈕有 `aria-label="將『前端工程師』上移"`。
- 離開守衛：有未儲存變更時 `beforeunload` 與路由離開都確認。
- 數字欄位用 `inputmode=numeric`；日期欄位有明確格式說明。
- 深色模式沿用 token；錯誤色用 `--color-danger` 系列。
- 文案繁中、不用 emoji、圖示用既有 inline SVG 風格。

## 8. API 契約（後端／前端並行依此開發）

全部在 `requireAdmin` 之下；seed 唯讀模式一律 503 `unavailable`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/events` | `{ items: AdminEventSummary[] }`：slug、name、status、startsAt、endsAt、recruitClosesAt、termTeam、counts `{ teams, participants }`、updatedAt。含 draft／archived。 |
| GET | `/api/admin/events/templates` | `{ templates: { key, name, description, seed: EventSeed }[] }`——repo 內建 seed 檔轉成範本：slug 清空、status 改 draft。 |
| GET | `/api/admin/events/:slug` | `{ seed: EventSeed, usage: { roles: Record<string, number>, skills: Record<string, number> }, stats: { teams, participants, largestTeam, smallestTeam } }`。含停用的字典項目。 |
| POST | `/api/admin/events` | body `EventSeed`（status 必為 draft）→ 201 `{ seed }`；409 `slug_taken`。 |
| PUT | `/api/admin/events/:slug` | body `EventSeed`（slug 須等於路徑，否則 409 `slug_immutable`；status 欄位忽略，狀態只能走 status 端點）→ `{ seed, warnings: string[] }`。字典：body 中消失的 key 若 usage=0 刪除、usage>0 → 409 `dictionary_key_in_use` `{ key, count }`（前端本來就不會送出這種請求，此為保底）。人數護欄 409 `max_members_below_existing` / `min_members_above_existing` `{ current }`。 |
| POST | `/api/admin/events/:slug/status` | body `{ status }` → `{ seed }`；409 `invalid_status_transition` `{ from, to }`；draft→open 且未達開放條件 409 `cannot_open_incomplete` `{ details: string[] }`。 |
| POST | `/api/admin/events/:slug/duplicate` | body `{ slug, name }` → 201 `{ seed }`（draft）。 |
| GET | `/api/admin/events/:slug/export` | `EventSeed` JSON，`Content-Disposition: attachment; filename="<slug>.json"`。 |
| DELETE | `/api/admin/events/:slug` | 僅 draft 且 counts 皆 0 → 204；否則 409 `event_not_empty` / `invalid_status_transition`。 |

所有寫入記 `audit_logs`：`admin_event_create` / `admin_event_update` / `admin_event_status` / `admin_event_duplicate` / `admin_event_delete`（targetType `event`, targetId slug）。

`EventSeed` 即 `packages/shared` 既有型別 `{ event: EventConfig, roles: DictionaryOption[], skills: DictionaryOption[] }`。前端送出的 `DictionaryOption` 必含 `key`（前端產生）、`label`、`sortOrder`、`isActive`、`category?`。

公開端點不變：`GET /api/events` 只列 open／closed（archived 亦隱藏）；`GET /api/events/:slug` 對 draft 回 404。

## 9. 驗收清單

- [ ] 從範本建立 → 存草稿 → 重新整理仍在 → 開放 → 首頁出現該活動（單活動前端會顯示 open 中第一場，多活動層屬 roadmap 任務 5）。
- [ ] 錯誤摘要可鍵盤到達、連結跳到欄位、螢幕閱讀器播報。
- [ ] 字典使用中的項目不能刪只能停用；伺服端 409 亦有對應文案。
- [ ] 人數上限低於現有隊伍人數被伺服端擋下並在欄位旁顯示。
- [ ] 匯出 JSON 用 `pnpm seed` 可直接匯入（round-trip 測試在 API 端）。
- [ ] 375px 寬：區塊導覽為 chips、字典列為卡片、預覽為抽屜、無水平捲動。
- [ ] 深色模式無漏套色。
