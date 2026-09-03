# 貢獻指南 Contributing

感謝你願意貢獻！本文件說明開發流程與規範。

## 開發環境

- Node.js ≥ 22（建議 24）
- pnpm 10（`corepack enable pnpm`）
- Docker（本機 PostgreSQL 用；不裝也能以 seed 記憶體模式跑 API）

```bash
pnpm install
docker compose up -d        # 起本機 PostgreSQL（選用）
pnpm dev                    # 同時起 API (8080) 與 Web (5173)
pnpm test                   # 全部測試
pnpm lint                   # ESLint
pnpm -r typecheck           # TypeScript 型別檢查
```

## 分支策略

- `main`：隨時可部署。所有變更走 PR，不直接 push。
- 功能分支：`feat/<簡短描述>`、`fix/<簡短描述>`。

## Commit 格式

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hant/)：

- `feat:` 新功能
- `fix:` 修 bug
- `docs:` 文件
- `chore:` 建置、CI、依賴
- `refactor:` / `test:` / `perf:`

Commit 訊息主旨用英文或中文皆可，但要具體描述「做了什麼」。

## PR 流程

1. 從 `main` 開分支，完成後開 PR。
2. CI 必須全綠（lint、typecheck、test、build、gitleaks）。
3. 安全相關程式碼（加密、審核、權限檢查）**必須附單元測試**。
4. 涉及架構決策的變更，請同步更新 `DECISIONS.md`。

## 鐵則

- **密鑰絕不進 repo**：`.env` 系列檔案已在 `.gitignore`；真實憑證一律走 Secret Manager。
- **活動規則絕不硬編碼**：人數上下限、角色、技能字典等一律來自 `events` 設定與 seed 檔。若你發現自己正要寫 `if (members >= 5)`，請停下來改讀 `event.maxMembers`。
- 程式碼註解與命名用英文；使用者面向文案與文件用繁體中文。
- 顯示使用者產生內容一律當純文字處理，禁止 `v-html`。
