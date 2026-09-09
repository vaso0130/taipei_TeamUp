<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'
import TagChip from '../components/TagChip.vue'
import { formatDate, formatDateTime } from '../lib/format.js'

const store = useEventStore()
const auth = useAuthStore()
const event = computed(() => store.event)

/** Creating a team needs a session: send visitors to login first, then on to the form. */
const createTeamTarget = computed(() =>
  auth.isLoggedIn
    ? { name: 'teams', query: { create: '1' } }
    : { name: 'profile', query: { next: 'create-team' } },
)

const memberRule = computed(() => {
  const e = event.value
  if (!e) return ''
  const range = e.minMembers === e.maxMembers ? `${e.minMembers}` : `${e.minMembers}–${e.maxMembers}`
  return `${range} 名${e.termMember}`
})

// A real sequence, so numbered steps carry information here.
const steps = computed(() => [
  { title: '建立個人檔案', body: '選好你的角色與技能標籤，讓其他人找得到你。' },
  { title: `找${store.termTeam}，或被找到`, body: `瀏覽招募中的${store.termTeam}，或把自己標記為「想找${store.termTeam}」。` },
  { title: `申請加入，成${store.termTeam}出發`, body: `送出申請或接受邀請，湊滿人數就完成組${store.termTeam}。` },
])
</script>

<template>
  <div>
    <p v-if="store.loading" class="text-dim">載入中⋯</p>
    <p v-else-if="store.error" class="card bg-danger-mist p-4 text-danger" role="alert">
      {{ store.error }}
    </p>

    <template v-else-if="event">
      <!-- hero: the platform's single job, stated in the event's own terms -->
      <section class="py-8 sm:py-14">
        <p class="eyebrow">{{ event.name }}</p>
        <h1 class="mt-3 max-w-2xl text-4xl font-black leading-tight sm:text-5xl">
          在報名之前，<br class="sm:hidden" />先找到你的{{ event.termTeam }}。
        </h1>
        <p class="mt-4 max-w-xl whitespace-pre-line text-dim">{{ event.description }}</p>

        <div class="mt-8 flex flex-wrap items-center gap-3">
          <RouterLink to="/teams" class="btn btn-primary">
            瀏覽{{ event.termTeam }}
          </RouterLink>
          <RouterLink v-if="store.recruitOpen" :to="createTeamTarget" class="btn btn-cta">
            建立{{ event.termTeam }}
          </RouterLink>
          <span v-else class="rounded-lg bg-mist px-3 py-2 text-sm text-dim">揪團已截止</span>
        </div>

        <dl class="mt-10 grid gap-x-8 gap-y-4 font-mono text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs text-dim">活動時間</dt>
            <dd class="mt-1 font-semibold">
              {{ formatDate(event.startsAt) }} – {{ formatDate(event.endsAt) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-dim">揪團截止</dt>
            <dd class="mt-1 font-semibold">{{ formatDateTime(event.recruitClosesAt) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-dim">{{ event.termTeam }}規模</dt>
            <dd class="mt-1 font-semibold">{{ memberRule }}</dd>
          </div>
        </dl>

        <ul class="mt-6 flex flex-wrap gap-2">
          <li>
            <TagChip
              :label="
                event.exclusiveMembership
                  ? `每人限加入一個${event.termTeam}`
                  : `可同時加入多個${event.termTeam}`
              "
            />
          </li>
          <li v-if="event.requiredContacts > 0">
            <TagChip :label="`成${event.termTeam}後需指定 ${event.requiredContacts} 位聯絡人`" />
          </li>
        </ul>

        <p
          v-if="event.requiresAdultCheck"
          class="mt-4 max-w-xl rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn"
        >
          未滿 18 歲請先向主辦單位確認同意書流程。
        </p>
      </section>

      <!-- how it works: an actual sequence -->
      <section class="border-t border-line py-10" aria-labelledby="how-title">
        <h2 id="how-title" class="eyebrow">怎麼運作</h2>
        <ol class="mt-6 grid gap-6 sm:grid-cols-3">
          <li v-for="(step, i) in steps" :key="step.title" class="card p-5">
            <span class="font-mono text-sm font-semibold text-primary-deep">{{ i + 1 }}</span>
            <h3 class="mt-2 font-bold">{{ step.title }}</h3>
            <p class="mt-1 text-sm text-dim">{{ step.body }}</p>
          </li>
        </ol>
      </section>

      <!-- the event's own vocabulary: roles and skills -->
      <section
        v-if="store.detail && (store.detail.roles.length || store.detail.skills.length)"
        class="border-t border-line py-10"
        aria-labelledby="dict-title"
      >
        <h2 id="dict-title" class="eyebrow">這場活動的角色與技能</h2>
        <div v-if="store.detail.roles.length" class="mt-6">
          <h3 class="text-sm font-medium text-dim">{{ event.termTeam }}角色</h3>
          <ul class="mt-2 flex flex-wrap gap-2">
            <li v-for="role in store.detail.roles" :key="role.key">
              <TagChip :label="role.label" />
            </li>
          </ul>
        </div>
        <div v-for="group in store.skillGroups" :key="group.category" class="mt-5">
          <h3 class="text-sm font-medium text-dim">{{ group.category }}</h3>
          <ul class="mt-2 flex flex-wrap gap-2">
            <li v-for="skill in group.skills" :key="skill.key">
              <TagChip :label="skill.label" :dot="group.color" />
            </li>
          </ul>
        </div>
      </section>
    </template>
  </div>
</template>
