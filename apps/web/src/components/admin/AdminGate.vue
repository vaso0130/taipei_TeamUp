<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../../stores/auth.js'

/**
 * Admin-only wrapper: renders the slot for admins, a sign-in prompt for
 * visitors, and a plain refusal for signed-in non-admins. While a stored
 * session is still being restored it shows a loading line instead of
 * flashing the sign-in prompt.
 */
defineProps<{ forbidden?: boolean }>()
const auth = useAuthStore()

const restoring = computed(() => auth.loading || (auth.token !== null && auth.me === null && !auth.error))
</script>

<template>
  <p v-if="restoring" class="text-dim">載入中⋯</p>
  <div v-else-if="!auth.isLoggedIn" class="card mt-2 p-8 text-center" role="status">
    <p class="font-medium">此頁面僅限管理員使用，請先登入。</p>
    <RouterLink to="/profile" class="btn btn-primary mt-4">前往登入</RouterLink>
  </div>
  <div v-else-if="!auth.me?.isAdmin || forbidden" class="card mt-2 p-8 text-center" role="status">
    <p class="font-medium">此頁面僅限管理員使用。</p>
    <RouterLink to="/" class="btn btn-quiet mt-4">回首頁</RouterLink>
  </div>
  <slot v-else />
</template>
