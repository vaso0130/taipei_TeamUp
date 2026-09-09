<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { ParticipationInput } from '@teamup/shared'
import { api } from '../api/client.js'
import { describeApiError, type LoadFailure } from '../lib/errors.js'
import LoadError from './LoadError.vue'
import TagChip from './TagChip.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

/**
 * Participation record for one event (docs/design/landing-and-event-layer.md §5).
 * The profile page renders one of these per open event, so everything —
 * dictionaries, terminology, load and save — is keyed by the `slug` prop
 * rather than the store's current event. Field ids carry the slug so two
 * instances on one page never share a label target.
 */
const props = defineProps<{ slug: string }>()

const auth = useAuthStore()
const eventStore = useEventStore()

const detail = computed(() => eventStore.detailFor(props.slug))
const event = computed(() => detail.value?.event ?? null)
const skillGroups = computed(() => eventStore.skillGroupsFor(props.slug))
const termTeam = computed(() => event.value?.termTeam ?? '隊伍')
const errorCtx = () => ({ termTeam: termTeam.value, termMember: event.value?.termMember ?? '成員' })
const id = (field: string) => `${field}-${props.slug}`

const eventError = ref<LoadFailure | null>(null)
async function loadEvent() {
  eventError.value = null
  const loaded = await eventStore.ensureLoaded(props.slug)
  if (!loaded) eventError.value = eventStore.failures[props.slug] ?? 'failed'
}
onMounted(loadEvent)

const form = reactive<ParticipationInput>({
  intent: 'looking_for_team',
  preferredRoles: [],
  skills: [],
  blurb: '',
  customTags: [],
  guardianConsentConfirmed: false,
})
/** Comma/、-separated editing buffer for free-form tags. */
const customTagsText = ref('')
const blurbVisibility = ref<string | null>(null)
const loadedParticipation = ref(false)

/** Buffer cap: every allowed tag at max length plus a separator each. */
const customTagsMaxLength = computed(() => {
  const e = event.value
  if (!e) return undefined
  return e.maxCustomTags * (e.customTagMaxLength + 1)
})

watch(
  [() => auth.me, event],
  async ([me, e]) => {
    if (!me || !e || !auth.token || loadedParticipation.value) return
    loadedParticipation.value = true
    const existing = await api.getParticipation(auth.getToken, e.slug).catch(() => null)
    if (existing) {
      form.intent = existing.intent
      form.preferredRoles = [...existing.preferredRoles]
      form.skills = [...existing.skills]
      form.blurb = existing.blurb
      form.customTags = [...existing.customTags]
      customTagsText.value = existing.customTags.join('、')
      form.isAdult = existing.isAdult ?? undefined
      form.guardianConsentConfirmed = existing.guardianConsentConfirmed
      blurbVisibility.value = existing.blurbVisibility
    }
  },
  { immediate: true },
)

function toggleKey(list: string[], key: string) {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}

const saving = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
async function save() {
  const e = event.value
  if (!auth.token || !e) return
  message.value = null
  // Parse the tag buffer: comma (half/full width) or 、 separated.
  form.customTags = [
    ...new Set(
      customTagsText.value
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  ]
  const tagRule = `自訂標籤最多 ${e.maxCustomTags} 個、每個最長 ${e.customTagMaxLength} 字`
  if (
    form.customTags.length > e.maxCustomTags ||
    form.customTags.some((t) => t.length > e.customTagMaxLength)
  ) {
    message.value = { kind: 'error', text: tagRule }
    return
  }
  saving.value = true
  try {
    const view = await api.putParticipation(auth.getToken, e.slug, { ...form })
    blurbVisibility.value = view.blurbVisibility
    message.value = { kind: 'ok', text: '已儲存' }
  } catch (err) {
    message.value = {
      kind: 'error',
      text: describeApiError(err, errorCtx(), '儲存失敗，請稍後再試', {
        adult_check_required: '請先回答是否年滿 18 歲',
        invalid_custom_tags: tagRule,
        validation_failed: '自我介紹最多 500 字，請檢查欄位內容',
      }),
    }
  } finally {
    saving.value = false
  }
}

const intentOptions = computed(
  () =>
    [
      { value: 'looking_for_team', label: `我想找${termTeam.value}`, hint: '會出現在「找人」列表' },
      { value: 'has_team', label: `我已有${termTeam.value}`, hint: '' },
      { value: 'browsing', label: '先看看', hint: '' },
    ] as const,
)
</script>

<template>
  <div>
    <LoadError v-if="eventError" :kind="eventError" title="活動資料載入失敗" @retry="loadEvent" />
    <p v-else-if="!event || !detail" class="text-sm text-dim" aria-live="polite">載入中⋯</p>

    <template v-else>
      <fieldset class="mt-4">
        <legend class="field-label">狀態</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="opt in intentOptions"
            :key="opt.value"
            class="chip chip-selectable !py-2"
            :class="{ 'chip-selected': form.intent === opt.value }"
          >
            <input v-model="form.intent" type="radio" class="sr-only" :value="opt.value" />
            {{ opt.label }}
          </label>
        </div>
        <p class="field-hint">
          {{ intentOptions.find((o) => o.value === form.intent)?.hint ?? '' }}
        </p>
      </fieldset>

      <fieldset v-if="detail.roles.length" class="mt-4">
        <legend class="field-label">偏好角色</legend>
        <div class="flex flex-wrap gap-2">
          <TagChip
            v-for="role in detail.roles"
            :key="role.key"
            :label="role.label"
            selectable
            :selected="form.preferredRoles.includes(role.key)"
            @toggle="toggleKey(form.preferredRoles, role.key)"
          />
        </div>
      </fieldset>

      <fieldset v-for="group in skillGroups" :key="group.category" class="mt-4">
        <legend class="field-label">{{ group.category }}</legend>
        <div class="flex flex-wrap gap-2">
          <TagChip
            v-for="skill in group.skills"
            :key="skill.key"
            :label="skill.label"
            :dot="group.color"
            selectable
            :selected="form.skills.includes(skill.key)"
            @toggle="toggleKey(form.skills, skill.key)"
          />
        </div>
      </fieldset>

      <div class="mt-4">
        <label class="field-label" :for="id('blurb')">
          自我介紹
          <span
            v-if="blurbVisibility === 'pending_review'"
            class="ml-2 rounded-full bg-warn-mist px-2 py-0.5 text-xs font-normal text-warn"
          >
            審核中
          </span>
          <span
            v-else-if="blurbVisibility === 'blocked'"
            class="ml-2 rounded-full bg-danger-mist px-2 py-0.5 text-xs font-normal text-danger"
          >
            未通過審核
          </span>
        </label>
        <textarea
          :id="id('blurb')"
          v-model="form.blurb"
          rows="3"
          maxlength="500"
          class="field-input"
          :aria-describedby="id('blurb-hint')"
          placeholder="介紹一下自己，讓別人知道你想做什麼"
        ></textarea>
        <p :id="id('blurb-hint')" class="field-hint">發布前會經過自動化風險檢測，通過後才公開。</p>
        <p v-if="blurbVisibility === 'blocked'" class="field-hint text-danger">
          目前的自我介紹未通過審核，其他人看不到。若認為誤判，請透過 GitHub Issues 或活動主辦單位聯繫。
        </p>

        <template v-if="event.maxCustomTags > 0">
          <label class="field-label mt-4" :for="id('custom-tags')">自訂技能標籤（選填）</label>
          <input
            :id="id('custom-tags')"
            v-model="customTagsText"
            class="field-input"
            type="text"
            :maxlength="customTagsMaxLength"
            :placeholder="'例如：Rust、Godot、手語（最多 ' + event.maxCustomTags + ' 個，以逗號或頓號分隔）'"
            :aria-describedby="id('custom-tags-hint')"
          />
          <p :id="id('custom-tags-hint')" class="field-hint">
            字典裡沒有的技能可以自己加，最多 {{ event.maxCustomTags }} 個、每個
            {{ event.customTagMaxLength }} 字內；與自介一併通過風險檢測後公開。
          </p>
        </template>
      </div>

      <fieldset v-if="event.requiresAdultCheck" class="mt-4">
        <legend class="field-label">你是否年滿 18 歲？</legend>
        <div class="flex gap-2">
          <label class="chip chip-selectable !py-2" :class="{ 'chip-selected': form.isAdult === true }">
            <input v-model="form.isAdult" type="radio" class="sr-only" :value="true" /> 是
          </label>
          <label class="chip chip-selectable !py-2" :class="{ 'chip-selected': form.isAdult === false }">
            <input v-model="form.isAdult" type="radio" class="sr-only" :value="false" /> 否
          </label>
        </div>
        <div v-if="form.isAdult === false" class="mt-3 rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn">
          <p>報名活動時需檢附法定代理人書面同意書，由活動主辦單位收取；本平台不收也不儲存同意書。</p>
          <label class="mt-2 flex items-center gap-2">
            <input v-model="form.guardianConsentConfirmed" type="checkbox" />
            我確認已取得法定代理人同意
          </label>
        </div>
      </fieldset>

      <p
        v-if="message"
        class="mt-4 text-sm"
        :class="message.kind === 'ok' ? 'text-ok' : 'text-danger'"
        role="status"
      >
        {{ message.text }}
      </p>
      <button class="btn btn-primary mt-4" :disabled="saving" @click="save">
        {{ saving ? '儲存中⋯' : '儲存檔案' }}
      </button>
    </template>
  </div>
</template>
