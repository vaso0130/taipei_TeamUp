<script setup lang="ts">
import { ref } from 'vue'
import type { ExpandUrlResult, ExpandWarning } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'

const input = ref('')
const checking = ref(false)
const result = ref<ExpandUrlResult | null>(null)
const errorText = ref('')

const WARNING_COPY: Record<ExpandWarning, string> = {
  not_https: '最終頁面未使用加密連線（http），輸入任何資料都可能被攔截。',
  many_hops: '轉址層層包裝，是詐騙短網址常見的手法。',
  ip_host: '網址以 IP 位址呈現，正常的服務很少這樣做。',
  userinfo: '網址內含「@」偽裝——「@」前面看似正常的網域其實不是真正的目的地。',
  idn_host: '網域含國際化字元（xn--），小心與知名網站相似的假冒字形。',
  redirect_loop: '轉址形成迴圈，沒有抵達最終頁面。',
  too_many_redirects: '轉址次數超過上限，已停止追蹤。',
  unreachable: '其中一站無法連線（逾時或拒絕），無法確認最終目的地。',
  blocked_private: '目標指向內部網路位址，已拒絕追蹤——這高度可疑。',
  unsupported_scheme: '使用了非網頁協定（例如 ftp），已停止追蹤。',
}

const finalHost = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function check() {
  const url = input.value.trim()
  if (!url || checking.value) return
  checking.value = true
  errorText.value = ''
  result.value = null
  try {
    result.value = await api.expandUrl(url)
  } catch (err) {
    errorText.value =
      err instanceof ApiError && err.status === 429
        ? '查詢太頻繁，請稍後再試'
        : err instanceof ApiError && err.status === 400
          ? '這看起來不是有效的網址'
          : '查詢失敗，請稍後再試'
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl">
    <h1 class="text-2xl font-black">短網址查核</h1>
    <p class="mt-2 text-dim">
      收到可疑的短網址？<strong class="text-ink">先別點</strong>。貼到下面，我們在伺服器上替你安全地展開，
      看看它究竟通往哪裡——你的裝置全程不會碰到那個網址。
    </p>

    <form class="mt-5 flex flex-wrap gap-2" @submit.prevent="check">
      <label class="sr-only" for="check-url">要查核的網址</label>
      <input
        id="check-url"
        v-model="input"
        type="text"
        inputmode="url"
        class="field-input flex-1"
        placeholder="貼上短網址，例如 https://reurl.cc/…"
        maxlength="2048"
      />
      <button type="submit" class="btn btn-primary" :disabled="checking">
        {{ checking ? '追蹤中⋯' : '查核' }}
      </button>
    </form>
    <p v-if="errorText" class="mt-3 text-sm text-danger" role="alert">{{ errorText }}</p>

    <template v-if="result">
      <div v-if="result.error === 'invalid_url'" class="card mt-6 p-5">
        <p class="text-sm">這看起來不是有效的網址，請確認後再試一次。</p>
      </div>
      <template v-else>
        <!-- 最終目的地 -->
        <section v-if="result.finalUrl" class="card mt-6 overflow-hidden">
          <div
            class="h-2"
            :style="{
              backgroundColor:
                result.warnings.length > 0 ? 'var(--color-warn)' : 'var(--color-ok)',
            }"
            aria-hidden="true"
          ></div>
          <div class="p-5">
            <p class="eyebrow">最終目的地</p>
            <p class="mt-1 text-xl font-black">{{ finalHost(result.finalUrl) }}</p>
            <p class="mt-1 break-all font-mono text-sm text-dim">{{ result.finalUrl }}</p>
          </div>
        </section>
        <section v-else class="card mt-6 overflow-hidden">
          <div class="h-2" :style="{ backgroundColor: 'var(--color-danger)' }" aria-hidden="true"></div>
          <div class="p-5">
            <p class="eyebrow">未能抵達最終頁面</p>
            <p class="mt-1 text-sm text-dim">追蹤在中途停止，原因見下方說明。</p>
          </div>
        </section>

        <!-- 風險說明 -->
        <ul v-if="result.warnings.length" class="mt-4 space-y-2">
          <li
            v-for="w in result.warnings"
            :key="w"
            class="rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn"
          >
            ⚠️ {{ WARNING_COPY[w] }}
          </li>
        </ul>
        <p v-else-if="result.finalUrl" class="mt-4 rounded-lg bg-ok-mist px-4 py-3 text-sm text-ok">
          沒有發現明顯的風險訊號。但這不代表絕對安全——請確認上面的網域是不是你認識、預期中的網站。
        </p>

        <!-- 轉址鏈 -->
        <section v-if="result.hops.length" class="mt-6">
          <h2 class="text-sm font-bold text-dim">轉址過程（{{ result.hops.length }} 站）</h2>
          <ol class="mt-2 space-y-1.5">
            <li
              v-for="(hop, i) in result.hops"
              :key="i"
              class="flex items-baseline gap-2 text-sm"
            >
              <span class="shrink-0 font-mono text-xs text-dim">{{ i + 1 }}.</span>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]"
                :class="hop.status === null ? 'bg-danger-mist text-danger' : 'bg-mist text-dim'"
              >
                {{ hop.status ?? '失敗' }}
              </span>
              <span class="break-all font-mono text-xs">{{ hop.url }}</span>
            </li>
          </ol>
        </section>
      </template>
    </template>

    <div class="mt-8 rounded-lg bg-mist p-4 text-sm">
      <p class="font-medium">保護自己</p>
      <p class="mt-1 text-dim">
        查核結果只是參考。若對方以簡訊、社群訊息傳來不明連結並涉及金錢、個資或帳號，
        請撥 <strong class="text-ink">165 反詐騙諮詢專線</strong> 查證；
        涉及人身安全請撥 <strong class="text-ink">110</strong>。
        本工具不會儲存你查詢的網址。
      </p>
    </div>
  </div>
</template>
