<script setup lang="ts">
import { ref, watch } from 'vue'
import { describeApiError } from '../lib/errors.js'
import ModalShell from './ModalShell.vue'

const props = defineProps<{
  open: boolean
  title: string
  /** What happens to the content once reported (shown under the title). */
  description: string
  /** Shown after a successful report (defaults to generic copy). */
  doneDescription?: string
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
    error.value = describeApiError(err, { termTeam: '' }, '檢舉失敗，請稍後再試', {
      already_reported: '你已經檢舉過了',
      rate_limited: '檢舉太頻繁，請稍後再試',
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <ModalShell :open="open" labelledby="report-dialog-title" @close="emit('close')">
    <template v-if="!done">
      <h2 id="report-dialog-title" class="text-lg font-bold">{{ title }}</h2>
      <p class="mt-1 text-sm text-dim">
        {{ description }}
        需要留證據的話，<strong class="text-ink">請先截圖再送出檢舉</strong>。
      </p>
      <fieldset class="mt-4 space-y-2">
        <legend class="sr-only">檢舉原因</legend>
        <label
          v-for="(opt, i) in REPORT_REASON_OPTIONS"
          :key="opt.value"
          class="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
        >
          <input
            v-model="reason"
            type="radio"
            name="report-dialog-reason"
            :value="opt.value"
            :data-autofocus="i === 0 ? '' : undefined"
          />
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
        <button type="button" class="btn btn-quiet" @click="emit('close')">取消</button>
        <button type="button" class="btn btn-primary" :disabled="submitting" @click="send">
          {{ submitting ? '送出中⋯' : '送出檢舉' }}
        </button>
      </div>
    </template>
    <template v-else>
      <h2 id="report-dialog-title" class="text-lg font-bold">已收到你的檢舉</h2>
      <p class="mt-2 text-sm text-dim">
        {{ doneDescription ?? '內容已送交更嚴格的 AI 複審，必要時由管理員人工處理。' }}
        謝謝你幫忙維護社群安全。
      </p>
      <p class="mt-2 text-sm text-dim">
        再次提醒：可疑訊息可撥 <strong class="text-ink">165</strong> 查證、
        人身安全疑慮請撥 <strong class="text-ink">110</strong>。
      </p>
      <div class="mt-5 flex justify-end">
        <button type="button" class="btn btn-primary" data-autofocus @click="emit('close')">
          知道了
        </button>
      </div>
    </template>
  </ModalShell>
</template>
