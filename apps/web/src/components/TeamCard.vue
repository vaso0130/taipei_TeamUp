<script setup lang="ts">
import { computed } from 'vue'
import type { TeamSummary } from '@teamup/shared'
import { useEventStore } from '../stores/event.js'
import TagChip from './TagChip.vue'

const props = defineProps<{ team: TeamSummary }>()
const eventStore = useEventStore()

const statusMeta = computed(() => {
  switch (props.team.status) {
    case 'recruiting':
      return { label: '招募中', bar: 'var(--color-primary)', chip: 'text-primary-deep bg-primary-mist' }
    case 'full':
      return { label: '已滿編', bar: 'var(--color-warn)', chip: 'text-warn bg-warn-mist' }
    default:
      return { label: '已關閉', bar: 'var(--color-dim)', chip: 'text-dim bg-mist' }
  }
})

const max = computed(() => eventStore.event?.maxMembers ?? 0)
</script>

<template>
  <RouterLink
    :to="{ name: 'team-detail', params: { id: team.id } }"
    class="card block overflow-hidden transition-colors duration-150 hover:border-primary"
  >
    <!-- signboard top rule: status carries the color -->
    <div class="h-1.5" :style="{ backgroundColor: statusMeta.bar }" aria-hidden="true"></div>
    <div class="p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-lg font-bold">{{ team.name }}</h3>
        <span class="rounded-full px-2.5 py-0.5 text-xs font-medium" :class="statusMeta.chip">
          {{ statusMeta.label }}
        </span>
      </div>

      <p v-if="team.pitch" class="mt-2 line-clamp-2 text-sm text-dim">{{ team.pitch }}</p>
      <p v-else-if="team.pitchVisibility === 'pending_review'" class="mt-2 text-sm text-dim">
        （簡介審核中）
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <span class="font-mono text-sm font-semibold text-primary-deep">
          {{ team.memberCount }}<span class="text-dim">/{{ max }}</span>
        </span>
        <span class="text-xs text-dim">{{ eventStore.termMember }}</span>
      </div>

      <ul
        v-if="team.neededRoles.length || team.neededSkills.length"
        class="mt-3 flex flex-wrap gap-1.5"
        :aria-label="`還缺的角色與技能`"
      >
        <li v-for="key in team.neededRoles" :key="`r-${key}`">
          <TagChip :label="eventStore.roleLabel(key)" />
        </li>
        <li v-for="key in team.neededSkills" :key="`s-${key}`">
          <TagChip :label="eventStore.skillLabel(key)" :dot="eventStore.skillDot(key)" />
        </li>
      </ul>
    </div>
  </RouterLink>
</template>
