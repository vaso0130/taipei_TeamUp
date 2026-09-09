<script setup lang="ts">
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
</script>

<template>
  <article class="prose-teamup mx-auto max-w-2xl space-y-6">
    <h1 class="text-2xl font-black">隱私權政策</h1>
    <p class="font-mono text-xs text-dim">生效日期：2026-09-09</p>
    <p class="text-sm text-dim">
      本政策說明「台北配」平台（下稱本平台）如何蒐集、處理及利用你的個人資料（依個人資料保護法第 8 條告知）。
      本平台為開源專案，程式碼公開於
      <a
        href="https://github.com/vaso0130/taipei_TeamUp"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-primary-deep underline"
      >GitHub</a>，任何人都能檢視我們實際如何處理資料。
    </p>

    <section class="card p-6">
      <h2 class="font-bold">我們蒐集什麼</h2>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm">
        <li><strong>Email</strong>：登入與帳號識別用，為唯一必要的識別資料。以信封加密儲存，資料庫中不存在明文。</li>
        <li><strong>暱稱</strong>：由你自訂，不要求真名、不做身分驗證。</li>
        <li>
          <strong>角色偏好與技能標籤</strong>：從活動提供的固定選項中選取；另可填寫少量自訂標籤（自由文字，同樣經過內容檢測）。
        </li>
        <li><strong>自我介紹等自由文字</strong>：你主動填寫的內容。</li>
        <li><strong>是否年滿 18 歲</strong>：僅存是／否，不蒐集生日。</li>
      </ul>
      <p class="mt-3 text-sm text-dim">
        我們<strong>不蒐集</strong>：真實姓名、電話、生日、學校、公司、身分證字號、住址、頭像照片。
        IP 位址僅存在於基礎設施日誌（30 天輪替），不進入應用資料庫。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">蒐集目的與利用方式</h2>
      <p class="mt-3 text-sm">
        蒐集目的為提供活動組{{ eventStore.termTeam }}媒合服務（含帳號管理、
        {{ eventStore.termTeam }}招募與申請、站內訊息）。利用期間為活動結束後至多依各活動設定的保存期限；
        利用對象僅限本平台，不提供第三方行銷使用。
      </p>
      <p class="mt-3 text-sm">
        利用地區：主要資料儲存於 Google Cloud asia-east1（臺灣）；自動化內容檢測使用 Google Cloud
        全球端點處理，送檢內容不含帳號識別資訊。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">自動化內容檢測</h2>
      <p class="mt-3 text-sm">
        你發布的內容（自我介紹、{{ eventStore.termTeam }}簡介、申請附言、站內訊息）會經過自動化風險檢測，
        以防範詐騙、釣魚與騷擾。送交檢測的內容不含你的帳號識別資訊；檢測紀錄僅保存判定結果與內容雜湊值，
        去識別化後保留 180 天。
      </p>
      <p class="mt-3 text-sm">
        判定為中高風險、被其他使用者檢舉、或帶有風險訊號的內容（含其所屬對話脈絡），將由平台管理人員人工檢視；
        每一次人工閱覽都會留存稽核紀錄。無風險訊號的一般對話，管理人員不會主動閱覽。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">保存期限</h2>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm">
        <li>
          帳號刪除：立即停用並隱藏所有內容，30 天後自資料庫永久刪除。刪除後以同一 Email 再登入，會建立全新的空白帳號，原資料不會復原。
        </li>
        <li>活動資料（{{ eventStore.termTeam }}、申請、訊息）：活動結束後依該活動設定的保存天數自動清除。</li>
      </ul>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">你的權利</h2>
      <p class="mt-3 text-sm">
        依個資法第 3 條，你得查詢、請求複製、補充更正、停止蒐集處理利用及刪除你的個人資料。
        本平台在「個人檔案」頁提供<strong>一鍵匯出</strong>（JSON）與<strong>一鍵刪除帳號</strong>功能；
        其他請求請透過下方聯絡管道提出。若不提供 Email，將無法建立帳號使用本服務。
      </p>
      <p class="mt-3 text-sm">
        若你認為內容被自動化檢測誤判，也可透過同一管道或活動主辦單位提出申訴。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">聯絡管道</h2>
      <p class="mt-3 text-sm">
        個資相關請求、申訴與一般問題，請至
        <a
          href="https://github.com/vaso0130/taipei_TeamUp/issues"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-primary-deep underline"
        >GitHub Issues</a>
        提出；資安漏洞請依專案
        <a
          href="https://github.com/vaso0130/taipei_TeamUp/blob/main/SECURITY.md"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-primary-deep underline"
        >SECURITY.md</a>
        所載方式私下通報，請勿公開揭露。
      </p>
    </section>

    <section class="card p-6">
      <h2 class="font-bold">未成年使用者</h2>
      <p class="mt-3 text-sm">
        未滿 18 歲者報名活動所需的法定代理人書面同意書，由<strong>活動主辦單位</strong>收取，
        本平台不經手、不儲存。平台僅記錄你自行勾選的「已取得同意」確認。
      </p>
    </section>
  </article>
</template>
