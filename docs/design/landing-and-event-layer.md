# 設計規格：入口頁與前端活動層（M7-A）

狀態：實作中（2026-09-09）。對應 ADR-035 A 部分、`docs/roadmap.md` 任務 5、6、8。

## 1. 入口頁 `/`：一句話的工作

讓還不知道這是什麼的人，在三秒內明白「這裡幫你找隊友」，然後選一場活動進去。

**版面（2026-09-09 修訂）**：入口頁只有滿版的路網板（高度＝視窗扣掉 header、寬度貼齊視窗邊緣，`meta.fullBleed` 讓 App 容器不加欄寬與內距），沒有其他內容；CTA「看看進行中的活動」導到獨立的 `/events` 活動列表頁。header 的「活動」與舊路徑轉址的最終退路也指向 `/events`。

### 視覺論點（signature）

**捷運夜間路網圖**。整站其他頁面是淺色紙面（ADR-008），入口頁 hero 刻意用深色 `--color-ink`（#16302B 系）作底，不跟隨深淺主題切換——它是一塊發光的路網板。Canvas 上漂浮的白點是「人」；每隔幾秒，鄰近的 4–5 個點被一條捷運線色的折線串起來，形成一段「隊伍」線路，端點亮起圓標，微微脈動後淡出，下一組再生成。線色沿用既有技能分類色（紅、藍、綠、橘、棕，對應淡水信義／板南／松山新店／中和新蘆／文湖）。這個動畫就是產品在做的事：把人連成隊。

### 文案（月台顯示器式逐行亮起）

由上而下三行，每行像 LED 顯示器從左掃到右亮起（clip-path 或字元逐個 opacity），間隔約 0.9 秒；第四行是品牌字，較大：

1. `正在找神隊友嗎？`
2. `你來對地方了。`
3. `快來看看誰正在等你來組隊`
4. **`臺北配`** ＋ 小字 `配 Taipei`（品牌「配」字用既有楷體堆疊）

eyebrow（等寬字，IBM Plex Mono）：`下一站：組隊`，左側一個小圓標。

CTA 一顆主要：`看看進行中的活動`（平滑捲動到下方活動列表，鍵盤可達）。不放第二顆按鈕；已登入者 header 有自己的入口。

### 動畫規格

- 純 Canvas 2D + `requestAnimationFrame`，無第三方套件（CSP `script-src 'self'`，且不想為此加 60 KB）。
- 節點 40–70 個（依寬度），慢速漂移（每秒數 px），邊界反彈。每 2.5–4 秒挑一群 4–5 個彼此距離最近的節點，依序連線（每段 180ms 畫出，像列車行進），端點畫圓標（外圈白、內圈線色），停留 1.8 秒後整段 600ms 淡出。同時最多 3 段線路。
- `devicePixelRatio` 上限 2；`IntersectionObserver` 離開視窗或 `document.hidden` 時暫停；`resize` 以 debounce 重建節點。
- `prefers-reduced-motion: reduce`：不跑 rAF，畫一張靜態路網（3 段已連好的線路），文案直接顯示不逐行亮起。
- Canvas `aria-hidden="true"`；所有文案是真 DOM 文字；hero 高度 `min-h-[70vh]`，手機 `min-h-[80vh]`。
- 文案逐行動畫以 CSS animation 實作（`animation-delay`），reduced-motion 時關閉。

### 活動列表（hero 之下，淺色紙面）

- 標題 `進行中的活動`；副標 `選一場進去，看看誰在找隊友`。
- 每張卡：狀態徽章（`招募中` 綠／`招募已截止` 灰）、活動名稱（h3）、活動日期、招募截止、規則 chips（人數範圍、是否一人一隊、聯絡人數——需要 detail 才有，列表只用 summary 時省略 chips，只放日期與狀態）。整張卡是連結 → `/e/:slug`。
- 只有一場 open：仍顯示列表（使用者要「進去後選」），但卡片放大成單欄寬。
- 沒有 open：顯示 `目前沒有進行中的活動`＋ `已結束的活動` 折疊。
- `已結束的活動（n）`：closed 活動預設摺疊，展開後每張卡標 `已結束`，仍可點進去看。
- archived 不出現在任何列表。
- 排序：open 依招募截止近→遠；closed 依結束日近→遠。
- 頁尾維持全站 footer。

## 2. 活動層路由

```
/                         入口頁（hero + 活動列表）
/e/:slug                  活動首頁（現在的 HomePage 內容）
/e/:slug/teams            找團
/e/:slug/teams/:id        隊伍詳情
/e/:slug/people           找人
/e/:slug/applications     申請與邀請
/messages                 站內訊息（跨活動）
/profile                  個人檔案（每場 open 活動一個參加資料區塊）
/admin, /admin/events…    後台（不變）
/privacy, /terms          不變
```

### 舊路徑相容（QR code、既有連結）

`/teams`、`/teams/:id`、`/people`、`/applications` 以 router 守衛轉址：
1. `VITE_EVENT_SLUG` 有設 → 轉到 `/e/<VITE_EVENT_SLUG>/...`（維持場測連結有效）。
2. 否則 open 活動恰一場 → 轉到那場。
3. 否則 → `/`（活動列表），`?next=` 帶原路徑供選完活動後接續（可選）。

### event store

- 改為多活動快取：`details: Record<slug, EventDetail>`、`current: slug | null`、`ensureLoaded(slug)` 共用 in-flight Promise（延續 ADR-032 修法）、`listSummaries()` 供入口頁與轉址判斷。
- 既有 getters（`event`、`termTeam`、`termMember`、`roleLabel`、`skillLabel`、`skillGroups`、`recruitOpen`）改讀 `current`，頁面程式碼幾乎不用改。
- `current` 由路由守衛依 `route.params.slug` 設定；離開活動層時保留最後一個（header 仍可顯示），但 `/` 不顯示活動 nav。

### header（App.vue）

- 在活動層內：圓標 → `/`；圓標右側顯示活動名稱（小字、可截斷）當作「你在哪」；nav：找團／找人／申請（帶 slug）、訊息；登入／暱稱；主題鈕。
- 在活動層外（`/`、`/messages`、`/profile`、admin…）：nav 只有 `活動`（→ `/`）、訊息；登入／暱稱；主題鈕。管理員多一個「審核」。
- 375px 仍單行（延續既有修法）。

## 3. 草稿預覽（管理員）

- 進入 `/e/:slug` 時 `GET /api/events/:slug` 回 404 且使用者是管理員 → 改呼叫 `GET /api/admin/events/:slug`，把 `seed` 轉成 `EventDetail`（roles／skills 只取 `isActive`，依 `sortOrder`），store 標記 `preview = true`。
- 預覽模式下：
  - header 下方一條黏性橫幅（琥珀色）：`草稿預覽　只有管理員看得到；開放後才會出現在活動列表。` 右側連結 `回編輯器`（→ `/admin/events/:slug`）。
  - 活動首頁正常渲染（文案、規則、字典）。
  - 找團／找人／申請頁不打資料 API，直接顯示空狀態（文案加一句「草稿尚無資料」）；所有寫入按鈕（建立隊伍、邀請、申請）隱藏。
  - 非管理員：一般 404 頁。
- 編輯器狀態卡加按鈕：draft → `預覽前台`（新分頁開 `/e/:slug`）；open／closed → `查看前台`。

## 4. 已結束與已封存

- closed：活動首頁 hero 下方灰色提示 `這場活動已結束招募`，建立／申請按鈕消失（既有 `recruitOpen` 邏輯），瀏覽仍可。
- archived：`GET /api/events/:slug` 允許讀取；活動首頁顯示橫幅 `這場活動已封存，僅供瀏覽`；不出現在任何列表；找團／找人頁仍可讀但無寫入。
- draft 對非管理員 404。

## 5. 個人檔案與訊息

- `/profile`：帳號區塊不變；下方每場 **open** 活動一個「我在「活動名」」區塊（可折疊，預設展開目前活動或第一場），各自載入與儲存參加資料。沒有 open 活動時顯示說明。
- `/messages`：thread 列表每筆標活動名稱（`ThreadView` 若無 event 資訊，由 team／thread 所屬活動查得；查不到就不標）。

## 6. 驗收

- [ ] `/` 在 1440 與 375：hero 動畫流暢、文案逐行、CTA 捲動到列表；reduced-motion 下靜態圖＋文案直接顯示；tab 隱藏時 rAF 停止。
- [ ] 兩場 open 活動都出現在列表；點卡進 `/e/:slug`；header 顯示活動名。
- [ ] `/teams`（舊連結）轉到 `VITE_EVENT_SLUG` 的活動。
- [ ] 管理員開草稿 `/e/<draft>` 看到預覽橫幅與空狀態；登出後同網址 404。
- [ ] archived 活動直接連結可讀且有橫幅，列表不出現。
- [ ] 個人檔案顯示兩個活動的參加資料區塊，各自可存。
- [ ] 零 console 錯誤；`pnpm lint`／`typecheck`／`build`／e2e smoke 通過。
