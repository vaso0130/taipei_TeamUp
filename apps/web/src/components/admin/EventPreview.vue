<script setup lang="ts">
import { computed } from 'vue'
import type { EventForm } from '../../composables/useEventEditor.js'
import TagChip from '../TagChip.vue'
import { dotColorForIndex } from '../../lib/colors.js'
import { formatDate, formatDateTime } from '../../lib/format.js'
import { taipeiLocalToIso } from '../../lib/taipei-time.js'

/**
 * Live preview of what a participant will see on the home page, rendered
 * from the local form state (so drafts preview too). Reuses the front
 * page's vocabulary — eyebrow, mono data rows, `.chip` — at card scale.
 */
const props = defineProps<{ form: EventForm; compact?: boolean }>()

const DESCRIPTION_PREVIEW_CHARS = 120

const termTeam = computed(() => props.form.termTeam.trim() || '隊伍')
const termMember = computed(() => props.form.termMember.trim() || '成員')
const name = computed(() => props.form.name.trim() || '未命名活動')
const description = computed(() => {
  const text = props.form.description.trim()
  if (!text) return ''
  return text.length > DESCRIPTION_PREVIEW_CHARS ? `${text.slice(0, DESCRIPTION_PREVIEW_CHARS)}…` : text
})

const safeDate = (local: string) => {
  const iso = taipeiLocalToIso(local)
  return iso ? formatDate(iso) : '—'
}
const safeDateTime = (local: string) => {
  const iso = taipeiLocalToIso(local)
  return iso ? formatDateTime(iso) : '—'
}

const memberRule = computed(() => {
  const min = props.form.minMembers
  const max = props.form.maxMembers
  if (min === null || max === null) return '—'
  const range = min === max ? `${min}` : `${min}–${max}`
  return `${range} 名${termMember.value}`
})

const activeRoles = computed(() => props.form.roles.filter((r) => r.isActive && r.label.trim()))

const skillGroups = computed(() => {
  const groups = new Map<string, string[]>()
  for (const s of props.form.skills) {
    if (!s.isActive || !s.label.trim()) continue
    const category = s.category.trim() || '其他'
    const list = groups.get(category) ?? []
    list.push(s.label.trim())
    groups.set(category, list)
  }
  return [...groups.entries()].map(([category, labels], i) => ({
    category,
    labels,
    color: dotColorForIndex(i),
  }))
})
</script>

<template>
  <section class="card overflow-hidden" aria-label="前台預覽">
    <div class="h-1.5 bg-primary" aria-hidden="true"></div>
    <div :class="compact ? 'p-4' : 'p-5'">
      <p class="text-xs font-medium text-dim">參加者在首頁看到的樣子（即時更新）</p>

      <p class="eyebrow mt-4 break-words">{{ name }}</p>
      <h3 class="mt-2 text-xl font-black leading-tight">在報名之前，先找到你的{{ termTeam }}。</h3>
      <p v-if="description" class="mt-2 whitespace-pre-line text-sm text-dim">{{ description }}</p>
      <p v-else class="mt-2 text-sm text-dim italic">（尚未填寫活動說明）</p>

      <div class="mt-4 flex flex-wrap gap-2">
        <span class="btn btn-primary pointer-events-none !min-h-[36px] text-sm">瀏覽{{ termTeam }}</span>
        <span class="btn btn-cta pointer-events-none !min-h-[36px] text-sm">建立{{ termTeam }}</span>
      </div>

      <dl class="mt-5 grid gap-3 font-mono text-sm">
        <div>
          <dt class="text-xs text-dim">活動時間</dt>
          <dd class="mt-0.5 font-semibold">{{ safeDate(form.startsAt) }} – {{ safeDate(form.endsAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-dim">揪團截止</dt>
          <dd class="mt-0.5 font-semibold">{{ safeDateTime(form.recruitClosesAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-dim">{{ termTeam }}規模</dt>
          <dd class="mt-0.5 font-semibold">{{ memberRule }}</dd>
        </div>
      </dl>

      <ul class="mt-4 flex flex-wrap gap-2">
        <li>
          <TagChip
            :label="form.exclusiveMembership ? `每人限加入一個${termTeam}` : `可同時加入多個${termTeam}`"
          />
        </li>
        <li v-if="(form.requiredContacts ?? 0) > 0">
          <TagChip :label="`成${termTeam}後需指定 ${form.requiredContacts} 位聯絡人`" />
        </li>
      </ul>
      <p v-if="form.requiresAdultCheck" class="mt-3 rounded-lg bg-warn-mist px-3 py-2 text-xs text-warn">
        未滿 18 歲請先向主辦單位確認同意書流程。
      </p>

      <div v-if="activeRoles.length || skillGroups.length" class="mt-5 border-t border-line pt-4">
        <p class="eyebrow">這場活動的角色與技能</p>
        <div v-if="activeRoles.length" class="mt-3">
          <p class="text-xs font-medium text-dim">{{ termTeam }}角色</p>
          <ul class="mt-1.5 flex flex-wrap gap-1.5">
            <li v-for="r in activeRoles" :key="r.id"><TagChip :label="r.label.trim()" /></li>
          </ul>
        </div>
        <div v-for="g in skillGroups" :key="g.category" class="mt-3">
          <p class="text-xs font-medium text-dim">{{ g.category }}</p>
          <ul class="mt-1.5 flex flex-wrap gap-1.5">
            <li v-for="label in g.labels" :key="label"><TagChip :label="label" :dot="g.color" /></li>
          </ul>
        </div>
      </div>
      <p v-else class="mt-5 border-t border-line pt-4 text-xs text-dim">
        還沒有角色或技能；開放前至少各需要一個。
      </p>
    </div>
  </section>
</template>
