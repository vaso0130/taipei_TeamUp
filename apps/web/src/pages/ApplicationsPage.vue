<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { ApplicationView } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import EmptyState from '../components/EmptyState.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()

const applications = ref<ApplicationView[]>([])
const loading = ref(false)
const feedback = ref('')

async function load() {
  const slug = eventStore.event?.slug
  if (!slug || !auth.token || !auth.isLoggedIn) return
  loading.value = true
  try {
    applications.value = (await api.myApplications(auth.token, slug)).applications
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 503)) console.error(err)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await load()
})
watch(() => auth.isLoggedIn, load)

const invitations = computed(() => applications.value.filter((a) => a.direction === 'invite'))
const applies = computed(() => applications.value.filter((a) => a.direction === 'apply'))

const statusMeta = (status: ApplicationView['status']) => {
  switch (status) {
    case 'pending':
      return { label: '等待回覆', class: 'bg-warn-mist text-warn' }
    case 'accepted':
      return { label: '已加入', class: 'bg-ok-mist text-ok' }
    case 'rejected':
      return { label: '未通過', class: 'bg-mist text-dim' }
    case 'withdrawn':
      return { label: '已撤回', class: 'bg-mist text-dim' }
    default:
      return { label: '已封鎖', class: 'bg-danger-mist text-danger' }
  }
}

async function respond(id: string, action: 'accept' | 'reject') {
  if (!auth.token) return
  feedback.value = ''
  try {
    await api.respondApplication(auth.token, id, action)
    await load()
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    feedback.value =
      code === 'team_full'
        ? `該${eventStore.termTeam}已滿編`
        : code === 'already_in_team'
          ? `你已在其他${eventStore.termTeam}中`
          : '操作失敗，請稍後再試'
  }
}

async function withdraw(id: string) {
  if (!auth.token) return
  feedback.value = ''
  try {
    await api.withdrawApplication(auth.token, id)
    await load()
  } catch {
    feedback.value = '操作失敗，請稍後再試'
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-black">我的申請與邀請</h1>

    <div v-if="!auth.isLoggedIn" class="card mt-6 p-8 text-center">
      <p>登入後就能看到你送出的申請與收到的邀請。</p>
      <RouterLink to="/profile" class="btn btn-primary mt-4">前往登入</RouterLink>
    </div>

    <template v-else>
      <p v-if="feedback" class="mt-4 text-sm text-danger" role="alert">{{ feedback }}</p>
      <p v-if="loading" class="mt-6 text-dim">載入中⋯</p>

      <section class="mt-6" aria-labelledby="invitations-title">
        <h2 id="invitations-title" class="eyebrow">收到的邀請（{{ invitations.length }}）</h2>
        <ul v-if="invitations.length" class="mt-3 space-y-3">
          <li v-for="a in invitations" :key="a.id" class="card flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <RouterLink
                :to="{ name: 'team-detail', params: { id: a.teamId } }"
                class="font-bold hover:text-primary-deep"
              >
                {{ a.teamName }}
              </RouterLink>
              <span class="ml-2 rounded-full px-2 py-0.5 text-xs" :class="statusMeta(a.status).class">
                {{ statusMeta(a.status).label }}
              </span>
              <p v-if="a.message" class="mt-1 text-sm text-dim">{{ a.message }}</p>
              <p v-else-if="a.messageVisibility === 'pending_review'" class="mt-1 text-sm text-dim">
                （附言審核中）
              </p>
            </div>
            <div v-if="a.status === 'pending'" class="flex gap-2">
              <button class="btn btn-primary !min-h-[40px] text-sm" @click="respond(a.id, 'accept')">
                接受邀請
              </button>
              <button class="btn btn-quiet !min-h-[40px] text-sm" @click="respond(a.id, 'reject')">
                婉拒
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-dim">目前沒有邀請。</p>
      </section>

      <section class="mt-8" aria-labelledby="applies-title">
        <h2 id="applies-title" class="eyebrow">我送出的申請（{{ applies.length }}）</h2>
        <ul v-if="applies.length" class="mt-3 space-y-3">
          <li v-for="a in applies" :key="a.id" class="card flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <RouterLink
                :to="{ name: 'team-detail', params: { id: a.teamId } }"
                class="font-bold hover:text-primary-deep"
              >
                {{ a.teamName }}
              </RouterLink>
              <span class="ml-2 rounded-full px-2 py-0.5 text-xs" :class="statusMeta(a.status).class">
                {{ statusMeta(a.status).label }}
              </span>
              <p v-if="a.message" class="mt-1 text-sm text-dim">{{ a.message }}</p>
            </div>
            <button
              v-if="a.status === 'pending'"
              class="btn btn-quiet !min-h-[40px] text-sm"
              @click="withdraw(a.id)"
            >
              撤回申請
            </button>
          </li>
        </ul>
        <EmptyState
          v-else
          class="mt-3"
          title="還沒有送出任何申請"
          :hint="`到「找${eventStore.termTeam}」看看誰在招募。`"
        >
          <template #action>
            <RouterLink to="/teams" class="btn btn-primary">瀏覽{{ eventStore.termTeam }}</RouterLink>
          </template>
        </EmptyState>
      </section>
    </template>
  </div>
</template>
