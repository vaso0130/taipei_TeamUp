<script setup lang="ts">
import { ref, watch } from 'vue'
import { ApiError } from '../api/client.js'

const props = defineProps<{
  open: boolean
  title: string
  /** What happens to the content once reported (shown under the title). */
  description: string
  submit: (reason: string) => Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()

const REPORT_REASON_OPTIONS = [
  { value: 'scam', label: '詐騙或釣魚' },
  { value: 'harassment', label: '騷擾或威脅' },
  { value: 'spam', label: '垃圾訊息' },
  { value: 'other', label: '其他不當內容' },
] as const

const reason = ref('scam')
const submitting = ref(false)
const done = ref(false)
const error = ref('')

watch(
  () => props.open,
  (open) => {
    if (open) {
      reason.value = 'scam'
      done.value = false
      error.value = ''
    }
  },
)

async function send() {
  submitting.value = true
  error.value = ''
  try {
    await props.submit(reason.value)
    done.value = true
  } catch (err) {
    error.value =
      err instanceof ApiError && err.code === 'already_reported'
        ? '你已經檢舉過了'
        : err instanceof ApiError && err.status === 429
          ? '檢舉太頻繁，請稍後再試'
          : '檢舉失敗，請稍後再試'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="report-dialog-title"
    @click.self="emit('close')"
  >
    <div class="card w-full max-w-md p-6">
      <template v-if="!done">
        <h2 id="report-dialog-title" class="text-lg font-bold">{{ title }}</h2>
        <p class="mt-1 text-sm text-dim">
          {{ description }}
          需要留證據的話，<strong class="text-ink">請先截圖再送出檢舉</strong>。
        </p>
        <fieldset class="mt-4 space-y-2">
          <legend class="sr-only">檢舉原因</legend>
          <label
            v-for="opt in REPORT_REASON_OPTIONS"
            :key="opt.value"
            class="flex cursor-pointer items-center gap-2 text-sm"
          >
            <input v-model="reason" type="radio" name="report-dialog-reason" :value="opt.value" />
            {{ opt.label }}
          </label>
        </fieldset>
        <div class="mt-4 rounded-lg bg-mist p-3 text-sm">
          <p class="font-medium">保護自己</p>
          <p class="mt-1 text-dim">
            懷疑遇到詐騙？先撥 <strong class="text-ink">165 反詐騙諮詢專線</strong> 查證。
            若對方威脅你的人身安全，請直接撥打 <strong class="text-ink">110</strong> 報警。
            內容隱藏後平台仍保留原始紀錄，警方可依法調閱。
          </p>
        </div>
        <p v-if="error" class="mt-3 text-sm text-danger" role="alert">{{ error }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="btn" @click="emit('close')">取消</button>
          <button type="button" class="btn btn-primary" :disabled="submitting" @click="send">
            送出檢舉
          </button>
        </div>
      </template>
      <template v-else>
        <h2 id="report-dialog-title" class="text-lg font-bold">已收到你的檢舉</h2>
        <p class="mt-2 text-sm text-dim">
          內容已送交更嚴格的 AI 複審，必要時由管理員人工處理。謝謝你幫忙維護社群安全。
        </p>
        <p class="mt-2 text-sm text-dim">
          再次提醒：可疑訊息可撥 <strong class="text-ink">165</strong> 查證、
          人身安全疑慮請撥 <strong class="text-ink">110</strong>。
        </p>
        <div class="mt-5 flex justify-end">
          <button type="button" class="btn btn-primary" @click="emit('close')">知道了</button>
        </div>
      </template>
    </div>
  </div>
</template>
