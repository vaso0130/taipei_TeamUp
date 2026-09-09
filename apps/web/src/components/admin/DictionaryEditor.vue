<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DictionaryRow } from '../../composables/useEventEditor.js'
import { fieldId } from '../../composables/useEventEditor.js'
import { generateOptionKey, type DictionaryKind } from '../../lib/dictionary-keys.js'

/**
 * Role / skill dictionary editor (docs/design/admin-events.md §3 ⑤⑥).
 * Rows are edited immutably through v-model so the parent's dirty
 * tracking sees every change. Keys are generated here and frozen once a
 * row has been saved; rows in use can only be deactivated.
 */
const rows = defineModel<DictionaryRow[]>({ required: true })
const props = defineProps<{
  kind: DictionaryKind
  /** 'roles' | 'skills' — prefix of the seed path for error lookup. */
  pathPrefix: 'roles' | 'skills'
  errorFor: (path: string) => string | undefined
}>()
const emit = defineEmits<{ touch: [path: string] }>()

const noun = computed(() => (props.kind === 'role' ? '角色' : '技能'))
const hasCategory = computed(() => props.kind === 'skill')
const listId = computed(() => `${props.pathPrefix}-categories`)

const categories = computed(() => {
  const set = new Set<string>()
  for (const r of rows.value) if (r.category.trim()) set.add(r.category.trim())
  return [...set]
})

const path = (i: number, leaf: string) => `${props.pathPrefix}.${i}.${leaf}`

function keysExcept(index: number): string[] {
  return rows.value.filter((_, i) => i !== index).map((r) => r.key)
}

function update(i: number, patch: Partial<DictionaryRow>) {
  rows.value = rows.value.map((r, j) => (j === i ? { ...r, ...patch } : r))
}

function onLabelInput(i: number, label: string) {
  const row = rows.value[i]
  if (!row) return
  // Unsaved rows follow their name; saved rows keep the key participants already reference.
  const key = row.persisted ? row.key : generateOptionKey(label, keysExcept(i), props.kind)
  update(i, { label, key })
}

function move(i: number, delta: -1 | 1) {
  const j = i + delta
  if (j < 0 || j >= rows.value.length) return
  const next = [...rows.value]
  const [row] = next.splice(i, 1)
  next.splice(j, 0, row!)
  rows.value = next
  // Keep focus on the same row's button after it moves.
  requestAnimationFrame(() => {
    document.getElementById(`${props.pathPrefix}-move-${delta < 0 ? 'up' : 'down'}-${j}`)?.focus()
  })
}

function remove(i: number) {
  const row = rows.value[i]
  if (!row || (row.persisted && row.usage > 0)) return
  rows.value = rows.value.filter((_, j) => j !== i)
}

const expanded = ref<Set<string>>(new Set())
function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// ---- add row ----
const newLabel = ref('')
const newCategory = ref('')
const addError = ref('')
const newLabelId = computed(() => `${props.pathPrefix}-new-label`)

function add() {
  const label = newLabel.value.trim()
  if (!label) {
    addError.value = '請輸入名稱'
    return
  }
  if (label.length > 50) {
    addError.value = '名稱最多 50 個字'
    return
  }
  addError.value = ''
  const lastCategory = rows.value.at(-1)?.category ?? ''
  const category = hasCategory.value ? newCategory.value.trim() || lastCategory : ''
  rows.value = [
    ...rows.value,
    {
      id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      key: generateOptionKey(
        label,
        rows.value.map((r) => r.key),
        props.kind,
      ),
      label,
      category,
      isActive: true,
      persisted: false,
      usage: 0,
    },
  ]
  newLabel.value = ''
  if (hasCategory.value) newCategory.value = category
  document.getElementById(newLabelId.value)?.focus()
}

const arrayError = computed(() => props.errorFor(props.pathPrefix))
</script>

<template>
  <div>
    <p v-if="rows.length === 0" class="rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn" role="note">
      開放前至少要有一個角色與一個技能。
    </p>
    <p v-if="arrayError" class="field-error" role="alert">{{ arrayError }}</p>

    <!-- Column headings only make sense on the one-line layout. -->
    <div
      v-if="rows.length"
      class="mt-3 hidden gap-2 px-3 text-xs font-medium text-dim sm:grid"
      :class="hasCategory ? 'sm:grid-cols-[88px_minmax(0,1fr)_minmax(0,160px)_64px_188px]' : 'sm:grid-cols-[88px_minmax(0,1fr)_64px_188px]'"
      aria-hidden="true"
    >
      <span>排序</span>
      <span>名稱</span>
      <span v-if="hasCategory">分類</span>
      <span>啟用</span>
      <span class="text-right">動作</span>
    </div>

    <ul v-if="rows.length" class="mt-1 space-y-2">
      <li
        v-for="(row, i) in rows"
        :key="row.id"
        class="card p-3"
        :class="{ 'opacity-70': !row.isActive }"
      >
        <div
          class="flex flex-wrap items-center gap-2 sm:grid"
          :class="hasCategory ? 'sm:grid-cols-[88px_minmax(0,1fr)_minmax(0,160px)_64px_188px]' : 'sm:grid-cols-[88px_minmax(0,1fr)_64px_188px]'"
        >
          <!-- order -->
          <div class="flex gap-0.5">
            <button
              :id="`${pathPrefix}-move-up-${i}`"
              type="button"
              class="btn btn-quiet !min-h-[44px] !min-w-[44px] !px-0"
              :disabled="i === 0"
              :aria-label="`將『${row.label || '未命名'}』上移`"
              @click="move(i, -1)"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
            </button>
            <button
              :id="`${pathPrefix}-move-down-${i}`"
              type="button"
              class="btn btn-quiet !min-h-[44px] !min-w-[44px] !px-0"
              :disabled="i === rows.length - 1"
              :aria-label="`將『${row.label || '未命名'}』下移`"
              @click="move(i, 1)"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>

          <!-- label -->
          <div class="min-w-[10rem] flex-1 sm:flex-none">
            <label :for="fieldId(path(i, 'label'))" class="sr-only">{{ noun }}名稱</label>
            <input
              :id="fieldId(path(i, 'label'))"
              :value="row.label"
              type="text"
              maxlength="50"
              class="field-input"
              :class="{ '!border-danger': errorFor(path(i, 'label')) }"
              :aria-invalid="errorFor(path(i, 'label')) ? 'true' : undefined"
              :aria-describedby="errorFor(path(i, 'label')) ? `${fieldId(path(i, 'label'))}-error` : undefined"
              @input="onLabelInput(i, ($event.target as HTMLInputElement).value)"
              @blur="emit('touch', path(i, 'label'))"
            />
          </div>

          <!-- category (skills) -->
          <div v-if="hasCategory" class="w-full sm:w-auto">
            <label :for="fieldId(path(i, 'category'))" class="sr-only">分類</label>
            <input
              :id="fieldId(path(i, 'category'))"
              :value="row.category"
              type="text"
              maxlength="50"
              class="field-input"
              placeholder="分類（選填）"
              :list="listId"
              :class="{ '!border-danger': errorFor(path(i, 'category')) }"
              :aria-invalid="errorFor(path(i, 'category')) ? 'true' : undefined"
              :aria-describedby="errorFor(path(i, 'category')) ? `${fieldId(path(i, 'category'))}-error` : undefined"
              @input="update(i, { category: ($event.target as HTMLInputElement).value })"
              @blur="emit('touch', path(i, 'category'))"
            />
          </div>

          <!-- active -->
          <button
            type="button"
            role="switch"
            :aria-checked="row.isActive"
            :aria-label="`啟用『${row.label || '未命名'}』`"
            class="relative flex h-11 w-16 shrink-0 cursor-pointer items-center rounded-full px-1 transition-colors duration-150"
            :class="row.isActive ? 'bg-primary' : 'bg-line'"
            @click="update(i, { isActive: !row.isActive })"
          >
            <span
              class="block h-7 w-7 rounded-full bg-card transition-transform duration-150"
              :class="row.isActive ? 'translate-x-7' : 'translate-x-0'"
              aria-hidden="true"
            ></span>
          </button>

          <!-- actions -->
          <div class="ml-auto flex items-center gap-1 sm:ml-0 sm:justify-end">
            <span
              v-if="row.persisted && row.usage > 0"
              class="rounded-full bg-mist px-2 py-0.5 font-mono text-[11px] text-dim whitespace-nowrap"
            >
              使用中 {{ row.usage }} 人
            </span>
            <button
              type="button"
              class="btn btn-quiet !min-h-[44px] text-xs"
              :aria-expanded="expanded.has(row.id)"
              :aria-controls="`${row.id}-more`"
              @click="toggleExpanded(row.id)"
            >
              更多
            </button>
            <span
              class="inline-block"
              :title="row.persisted && row.usage > 0 ? `已有 ${row.usage} 人選用，只能停用` : undefined"
            >
              <button
                type="button"
                class="btn btn-danger !min-h-[44px] !min-w-[44px] !px-0"
                :disabled="row.persisted && row.usage > 0"
                :aria-label="`刪除『${row.label || '未命名'}』`"
                :aria-describedby="row.persisted && row.usage > 0 ? `${row.id}-lock` : undefined"
                @click="remove(i)"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            </span>
            <span v-if="row.persisted && row.usage > 0" :id="`${row.id}-lock`" class="sr-only">
              已有 {{ row.usage }} 人選用，只能停用
            </span>
          </div>
        </div>

        <p
          v-if="errorFor(path(i, 'label'))"
          :id="`${fieldId(path(i, 'label'))}-error`"
          class="field-error"
          role="alert"
        >
          {{ errorFor(path(i, 'label')) }}
        </p>
        <p
          v-if="errorFor(path(i, 'category'))"
          :id="`${fieldId(path(i, 'category'))}-error`"
          class="field-error"
          role="alert"
        >
          {{ errorFor(path(i, 'category')) }}
        </p>
        <p v-if="errorFor(path(i, 'key'))" class="field-error" role="alert">{{ errorFor(path(i, 'key')) }}</p>

        <div v-if="expanded.has(row.id)" :id="`${row.id}-more`" class="mt-2 rounded-lg bg-mist px-3 py-2 text-xs text-dim">
          系統代號：<code class="font-mono">{{ row.key }}</code>
          <span v-if="row.persisted">（已儲存，不再變動）</span>
          <span v-else>（由名稱自動產生，儲存後固定）</span>
        </div>
      </li>
    </ul>

    <!-- add -->
    <form class="mt-3 flex flex-wrap items-end gap-2" @submit.prevent="add">
      <div class="min-w-[12rem] flex-1">
        <label :for="newLabelId" class="field-label">新增{{ noun }}</label>
        <input
          :id="newLabelId"
          v-model="newLabel"
          type="text"
          maxlength="50"
          class="field-input"
          :placeholder="`${noun}名稱，按 Enter 新增`"
          :aria-describedby="addError ? `${newLabelId}-error` : undefined"
          :aria-invalid="addError ? 'true' : undefined"
        />
      </div>
      <div v-if="hasCategory" class="w-full sm:w-44">
        <label :for="`${pathPrefix}-new-category`" class="field-label">分類</label>
        <input
          :id="`${pathPrefix}-new-category`"
          v-model="newCategory"
          type="text"
          maxlength="50"
          class="field-input"
          :list="listId"
          :placeholder="rows.at(-1)?.category || '選填'"
        />
      </div>
      <button type="submit" class="btn btn-quiet">新增</button>
      <p v-if="addError" :id="`${newLabelId}-error`" class="field-error w-full !mt-0" role="alert">{{ addError }}</p>
    </form>
    <datalist v-if="hasCategory" :id="listId">
      <option v-for="c in categories" :key="c" :value="c"></option>
    </datalist>
  </div>
</template>
