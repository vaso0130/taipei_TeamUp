<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { ApplicationView } from '@teamup/shared'
import { api } from '../api/client.js'
import { classifyLoadError, describeApiError, type LoadFailure } from '../lib/errors.js'
import EmptyState from '../components/EmptyState.vue'
import LoadError from '../components/LoadError.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()
const slug = computed(() => String(route.params.slug))

const applications = ref<ApplicationView[]>([])
const loading = ref(true)
const loadError = ref<LoadFailure | null>(null)
const feedback = ref('')

async function load() {
  if (!auth.isLoggedIn) {
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = null
  const detail = await eventStore.ensureLoaded(slug.value)
  if (!detail || !auth.token) {
    loadError.value = eventStore.failures[slug.value] ?? 'failed'
    loading.value = false
    return
  }
  // Draft preview (§3): no applications can exist yet.
  if (eventStore.preview) {
    applications.value = []
    loading.value = false
    return
  }
  try {
    applications.value = (await api.myApplications(auth.getToken, slug.value)).applications
  } catch (err) {
    loadError.value = classifyLoadError(err)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded(slug.value)
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
    case 'blocked':
      // The note failed moderation (ADR-026); the application never reached the team.
      return { label: '附言未通過審核', class: 'bg-danger-mist text-danger' }
    default:
      return { label: status, class: 'bg-mist text-dim' }
  }
}

const errorCtx = () => ({ termTeam: eventStore.termTeam, termMember: eventStore.termMember })

async function respond(id: string, action: 'accept' | 'reject') {
  if (!auth.token) return
  feedback.value = ''
  try {
    await api.respondApplication(auth.getToken, id, action)
    await load()
  } catch (err) {
    feedback.value = describeApiError(err, errorCtx(), '操作失敗，請稍後再試', {
      team_full: `該${eventStore.termTeam}已滿編`,
      already_in_team: `你已在其他${eventStore.termTeam}中`,
    })
  }
}

async function withdraw(id: string) {
  if (!auth.token) return
  feedback.value = ''
  try {
    await api.withdrawApplication(auth.getToken, id)
    await load()
  } catch (err) {
    feedback.value = describeApiError(err, errorCtx(), '操作失敗，請稍後再試')
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
      <p v-if="loading" class="mt-6 text-dim" aria-live="polite">載入中⋯</p>
      <LoadError v-else-if="loadError" class="mt-6" :kind="loadError" @retry="load" />

      <template v-else>
        <section class="mt-6" aria-labelledby="invitations-title">
          <h2 id="invitations-title" class="eyebrow">收到的邀請（{{ invitations.length }}）</h2>
          <ul v-if="invitations.length" class="mt-3 space-y-3">
            <li v-for="a in invitations" :key="a.id" class="card flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <RouterLink
                  :to="{ name: 'team-detail', params: { slug, id: a.teamId } }"
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
              <div v-if="a.status === 'pending' && !eventStore.readOnly" class="flex gap-2">
                <button class="btn btn-primary text-sm" @click="respond(a.id, 'accept')">
                  接受邀請
                </button>
                <button class="btn btn-quiet text-sm" @click="respond(a.id, 'reject')">婉拒</button>
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
                  :to="{ name: 'team-detail', params: { slug, id: a.teamId } }"
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
                v-if="a.status === 'pending' && !eventStore.readOnly"
                class="btn btn-quiet text-sm"
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
            :hint="eventStore.preview ? '草稿尚無資料。' : `到「找${eventStore.termTeam}」看看誰在招募。`"
          >
            <template #action>
              <RouterLink :to="{ name: 'teams', params: { slug } }" class="btn btn-primary">
                瀏覽{{ eventStore.termTeam }}
              </RouterLink>
            </template>
          </EmptyState>
        </section>
      </template>
    </template>
  </div>
</template>
