import { defineStore } from 'pinia'
import type { DictionaryOption, EventDetail } from '@teamup/shared'
import { api } from '../api/client.js'
import { dotColorForIndex } from '../lib/colors.js'

interface EventState {
  detail: EventDetail | null
  loading: boolean
  error: string | null
}

export const useEventStore = defineStore('event', {
  state: (): EventState => ({ detail: null, loading: false, error: null }),
  getters: {
    event: (s) => s.detail?.event ?? null,
    termTeam: (s) => s.detail?.event.termTeam ?? '隊伍',
    termMember: (s) => s.detail?.event.termMember ?? '成員',
    roleLabel: (s) => (key: string) =>
      s.detail?.roles.find((r) => r.key === key)?.label ?? key,
    skillLabel: (s) => (key: string) =>
      s.detail?.skills.find((o) => o.key === key)?.label ?? key,
    /** Stable category → MRT-dot color assignment, cyclic over event data. */
    categoryColor(): (category: string | undefined) => string {
      const categories: string[] = []
      for (const skill of this.detail?.skills ?? []) {
        const c = skill.category ?? '其他'
        if (!categories.includes(c)) categories.push(c)
      }
      return (category) => dotColorForIndex(categories.indexOf(category ?? '其他'))
    },
    skillDot(): (key: string) => string {
      return (key) => {
        const skill = this.detail?.skills.find((o) => o.key === key)
        return this.categoryColor(skill?.category)
      }
    },
    skillGroups(): { category: string; color: string; skills: DictionaryOption[] }[] {
      const groups = new Map<string, DictionaryOption[]>()
      for (const skill of this.detail?.skills ?? []) {
        const category = skill.category ?? '其他'
        const list = groups.get(category) ?? []
        list.push(skill)
        groups.set(category, list)
      }
      return [...groups.entries()].map(([category, skills]) => ({
        category,
        color: this.categoryColor(category),
        skills,
      }))
    },
    recruitOpen: (s) => {
      const e = s.detail?.event
      if (!e) return false
      return e.status === 'open' && new Date(e.recruitClosesAt).getTime() > Date.now()
    },
  },
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        let slug = import.meta.env.VITE_EVENT_SLUG || undefined
        if (!slug) {
          const { events } = await api.listEvents()
          slug = (events.find((e) => e.status === 'open') ?? events[0])?.slug
        }
        if (!slug) {
          this.error = '目前沒有進行中的活動'
          return
        }
        this.detail = await api.getEvent(slug)
      } catch (err) {
        console.error(err)
        this.error = '活動資料載入失敗，請重新整理頁面'
      } finally {
        this.loading = false
      }
    },
    async ensureLoaded() {
      if (!this.detail && !this.loading) await this.load()
    },
  },
})
