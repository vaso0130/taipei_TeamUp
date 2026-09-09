<script setup lang="ts">
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
</script>

<template>
  <article class="mx-auto max-w-2xl space-y-6">
    <h1 class="text-2xl font-black">服務條款</h1>
    <p class="font-mono text-xs text-dim">生效日期：2026-09-09</p>

    <section class="card p-6">
      <h2 class="font-bold">平台性質</h2>
      <p class="mt-3 text-sm">
        「台北配」（下稱本平台）是活動報名前的組{{ eventStore.termTeam }}媒合工具，
        <strong>不代為報名活動</strong>、不隸屬於活動報名系統。活動的參賽資格、規則與報名程序，
        一律以活動主辦單位公告為準。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">使用規範</h2>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm">
        <li>禁止發布詐騙、釣魚、賭博、招攬投資、騷擾或任何違法內容。</li>
        <li>禁止冒充他人、主辦單位或平台管理者。</li>
        <li>禁止以自動化程式大量註冊、發文或發送訊息。</li>
        <li>
          所有發布內容會經過自動化風險檢測；判定高風險的內容不會發布，7 天內累積多次高風險內容者帳號將被停權。
          若認為誤判，請透過 GitHub Issues 或活動主辦單位聯繫申訴。
        </li>
      </ul>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">帳號</h2>
      <p class="mt-3 text-sm">
        你可以隨時刪除帳號；刪除即退出目前所屬的{{ eventStore.termTeam }}（若你是發起人，
        將自動交棒給最早加入的{{ eventStore.termMember }}），內容立即隱藏，資料於 30 天後永久刪除。
        刪除後以同一 Email 再登入，會建立全新的空白帳號，原資料不會復原。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">免責聲明</h2>
      <p class="mt-3 text-sm">
        {{ eventStore.termTeam }}{{ eventStore.termMember }}之間的約定、合作與糾紛由{{ eventStore.termMember }}自行負責。
        平台以現狀提供服務，為活動性質的開源專案，不提供服務水準承諾；
        維護以資安修補為主。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">開源授權與聯絡</h2>
      <p class="mt-3 text-sm">
        本平台程式碼以 MIT 授權開源。問題與申訴請至
        <a
          href="https://github.com/vaso0130/taipei_TeamUp/issues"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-primary-deep underline"
        >GitHub Issues</a>
        提出；資安問題請依專案 SECURITY.md 私下通報。
      </p>
    </section>
  </article>
</template>
