import { defineStore } from 'pinia'
import type { DictionaryOption, EventDetail, EventSummary } from '@teamup/shared'
import { api } from '../api/client.js'
import { dotColorForIndex } from '../lib/colors.js'
import { classifyLoadError, type LoadFailure } from '../lib/errors.js'
import { detailFromSeed, shouldTryDraftPreview } from '../lib/event-preview.js'
import { useAuthStore } from './auth.js'

/**
 * Multi-event cache keyed by slug (docs/design/landing-and-event-layer.md §2).
 * `current` follows `route.params.slug` (set by the router guard) and the
 * same-named getters pages already use (`event`, `termTeam`, …) read the
 * current entry, so page code stays terminology-driven and slug-agnostic.
 *
 * In-flight requests are shared per slug (ADR-032): the guard, App.vue and
 * the page all ask for the same event within the same tick.
 */
let summariesInflight: Promise<EventSummary[]> | null = null
const detailInflight = new Map<string, Promise<void>>()

export interface SkillGroup {
  category: string
  color: string
  skills: DictionaryOption[]
}

const OTHER_CATEGORY = '其他'

/** Stable category → MRT-dot color assignment, cyclic over the event's own data. */
function categoryColorOf(detail: EventDetail | null): (category: string | undefined) => string {
  const categories: string[] = []
  for (const skill of detail?.skills ?? []) {
    const c = skill.category ?? OTHER_CATEGORY
    if (!categories.includes(c)) categories.push(c)
  }
  return (category) => dotColorForIndex(categories.indexOf(category ?? OTHER_CATEGORY))
}

function skillGroupsOf(detail: EventDetail | null): SkillGroup[] {
  const color = categoryColorOf(detail)
  const groups = new Map<string, DictionaryOption[]>()
  for (const skill of detail?.skills ?? []) {
    const category = skill.category ?? OTHER_CATEGORY
    const list = groups.get(category) ?? []
    list.push(skill)
    groups.set(category, list)
  }
  return [...groups.entries()].map(([category, skills]) => ({
    category,
    color: color(category),
    skills,
  }))
}

interface EventState {
  details: Record<string, EventDetail>
  /** Slugs whose detail came from the admin endpoint — a draft only admins can see (§3). */
  drafts: Record<string, true>
  /** Why a slug could not be loaded; cleared on retry. */
  failures: Record<string, LoadFailure>
  summaries: EventSummary[] | null
  summariesError: LoadFailure | null
  /** Slug of the event the visitor is in (or was last in). */
  current: string | null
  /** True while `current` has no cached detail yet. */
  loading: boolean
  /** Load failure of `current`. */
  error: LoadFailure | null
}

export const useEventStore = defineStore('event', {
  state: (): EventState => ({
    details: {},
    drafts: {},
    failures: {},
    summaries: null,
    summariesError: null,
    current: null,
    loading: false,
    error: null,
  }),
  getters: {
    detail: (s) => (s.current ? (s.details[s.current] ?? null) : null),
    event(): EventDetail['event'] | null {
      return this.detail?.event ?? null
    },
    termTeam(): string {
      return this.detail?.event.termTeam ?? '隊伍'
    },
    termMember(): string {
      return this.detail?.event.termMember ?? '成員'
    },
    roleLabel(): (key: string) => string {
      return (key) => this.detail?.roles.find((r) => r.key === key)?.label ?? key
    },
    skillLabel(): (key: string) => string {
      return (key) => this.detail?.skills.find((o) => o.key === key)?.label ?? key
    },
    categoryColor(): (category: string | undefined) => string {
      return categoryColorOf(this.detail)
    },
    skillDot(): (key: string) => string {
      return (key) => {
        const skill = this.detail?.skills.find((o) => o.key === key)
        return this.categoryColor(skill?.category)
      }
    },
    skillGroups(): SkillGroup[] {
      return skillGroupsOf(this.detail)
    },
    /** Same helpers for an explicit slug (profile shows several events at once). */
    detailFor: (s) => (slug: string) => s.details[slug] ?? null,
    skillGroupsFor: (s) => (slug: string) => skillGroupsOf(s.details[slug] ?? null),
    recruitOpen(): boolean {
      const e = this.event
      if (!e) return false
      return e.status === 'open' && new Date(e.recruitClosesAt).getTime() > Date.now()
    },
    /** Current event is a draft rendered through the admin fallback (§3). */
    preview: (s) => !!s.current && !!s.drafts[s.current],
    archived(): boolean {
      return this.event?.status === 'archived'
    },
    /** No writes at all: draft preview or archived event (§3, §4). */
    readOnly(): boolean {
      return this.preview || this.archived
    },
    notFound: (s) => s.error === 'not_found',
    openEvents: (s) => (s.summaries ?? []).filter((e) => e.status === 'open'),
    /** Display name for any slug seen so far (summaries or details), else the slug. */
    eventName: (s) => (slug: string) =>
      s.details[slug]?.event.name ?? s.summaries?.find((e) => e.slug === slug)?.name ?? slug,
  },
  actions: {
    /** Public event list (open + closed), fetched once and shared. */
    async ensureSummaries(): Promise<EventSummary[]> {
      if (this.summaries) return this.summaries
      if (!summariesInflight) {
        summariesInflight = api
          .listEvents()
          .then(({ events }) => {
            this.summaries = events
            this.summariesError = null
            return events
          })
          .finally(() => {
            summariesInflight = null
          })
      }
      try {
        return await summariesInflight
      } catch (err) {
        this.summariesError = classifyLoadError(err)
        return []
      }
    },

    /**
     * Fetch one event's detail into the cache, sharing the in-flight
     * request. Never throws: failures land in `failures[slug]` and the
     * result is null.
     */
    async ensureLoaded(slug: string): Promise<EventDetail | null> {
      const cached = this.details[slug]
      if (cached) return cached
      let inflight = detailInflight.get(slug)
      if (!inflight) {
        inflight = this.fetchDetail(slug).finally(() => {
          detailInflight.delete(slug)
        })
        detailInflight.set(slug, inflight)
      }
      await inflight
      return this.details[slug] ?? null
    },

    async fetchDetail(slug: string) {
      delete this.failures[slug]
      try {
        this.details[slug] = await api.getEvent(slug)
        delete this.drafts[slug]
        return
      } catch (err) {
        const auth = useAuthStore()
        if (!shouldTryDraftPreview(err, !!auth.me?.isAdmin)) {
          this.failures[slug] = classifyLoadError(err)
          return
        }
      }
      // Public 404 seen by an admin: the event may be a draft (§3).
      try {
        const auth = useAuthStore()
        const { seed } = await api.adminGetEvent(auth.getToken, slug)
        this.details[slug] = detailFromSeed(seed)
        this.drafts[slug] = true
      } catch (err) {
        this.failures[slug] = classifyLoadError(err)
      }
    },

    /** Router guard entry: make `slug` the current event and load it. */
    async select(slug: string) {
      this.current = slug
      this.error = null
      this.loading = !this.details[slug]
      await this.ensureLoaded(slug)
      // The visitor may have navigated elsewhere while this loaded.
      if (this.current !== slug) return
      this.error = this.failures[slug] ?? null
      this.loading = false
    },

    /** Re-run a failed load (e.g. the admin session arrived after a draft 404). */
    async retry(slug: string) {
      delete this.failures[slug]
      await this.select(slug)
    },

    /** Session ended: drafts are admin-only, so forget them and re-resolve the current one. */
    dropDrafts() {
      const wasDraft = !!this.current && !!this.drafts[this.current]
      for (const slug of Object.keys(this.drafts)) {
        delete this.details[slug]
        delete this.drafts[slug]
      }
      if (wasDraft && this.current) void this.select(this.current)
    },
  },
})
