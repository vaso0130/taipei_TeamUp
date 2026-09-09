import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
} from 'vue-router'
import { ENV_EVENT_SLUG, legacyEventSlug, legacyRedirectPath } from './lib/event-routes.js'
import { useEventStore } from './stores/event.js'

// Module augmentation (this file is a module, so it extends rather than replaces vue-router's types).
declare module 'vue-router' {
  interface RouteMeta {
    /** Route lives under /e/:slug — header shows the event name and event nav. */
    eventLayer?: boolean
    /** Editor-style page: wider main column. */
    wide?: boolean
  }
}

/**
 * Routes (docs/design/landing-and-event-layer.md §2). Everything under
 * `/e/:slug` is the "event layer" (meta.eventLayer): the header shows the
 * event name and event nav, and the guard below points the event store at
 * the slug. Cross-event pages (messages, profile, admin, policies) sit
 * outside it.
 */
const eventLayer = { eventLayer: true } as const

/**
 * Legacy paths (QR codes, printed links) redirect in three steps: the
 * build-time slug, else the sole open event, else the event list with
 * `?next=` so the visitor can continue after picking one.
 */
async function redirectLegacy(to: RouteLocationNormalized): Promise<RouteLocationRaw> {
  const eventStore = useEventStore()
  const slug = legacyEventSlug(
    ENV_EVENT_SLUG,
    ENV_EVENT_SLUG ? null : await eventStore.ensureSummaries(),
  )
  if (slug) return { path: legacyRedirectPath(slug, to.path), query: to.query }
  return { name: 'home', query: { next: to.fullPath } }
}

const legacyRoutes: RouteRecordRaw[] = ['/teams', '/teams/:id', '/people', '/applications'].map(
  (path) => ({
    path,
    // The component never renders: beforeEnter always redirects.
    component: () => import('./pages/NotFoundPage.vue'),
    beforeEnter: redirectLegacy,
  }),
)

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./pages/LandingPage.vue') },
    {
      path: '/e/:slug',
      name: 'event-home',
      component: () => import('./pages/HomePage.vue'),
      meta: eventLayer,
    },
    {
      path: '/e/:slug/teams',
      name: 'teams',
      component: () => import('./pages/TeamsPage.vue'),
      meta: eventLayer,
    },
    {
      path: '/e/:slug/teams/:id',
      name: 'team-detail',
      component: () => import('./pages/TeamDetailPage.vue'),
      meta: eventLayer,
    },
    {
      path: '/e/:slug/people',
      name: 'people',
      component: () => import('./pages/PeoplePage.vue'),
      meta: eventLayer,
    },
    {
      path: '/e/:slug/applications',
      name: 'applications',
      component: () => import('./pages/ApplicationsPage.vue'),
      meta: eventLayer,
    },
    ...legacyRoutes,
    { path: '/messages', name: 'messages', component: () => import('./pages/MessagesPage.vue') },
    { path: '/profile', name: 'profile', component: () => import('./pages/ProfilePage.vue') },
    { path: '/admin', name: 'admin', component: () => import('./pages/AdminPage.vue') },
    {
      path: '/admin/events',
      name: 'admin-events',
      component: () => import('./pages/AdminEventsPage.vue'),
    },
    {
      path: '/admin/events/new',
      name: 'admin-event-new',
      component: () => import('./pages/AdminEventNewPage.vue'),
      meta: { wide: true },
    },
    {
      path: '/admin/events/:slug',
      name: 'admin-event-edit',
      component: () => import('./pages/AdminEventEditorPage.vue'),
      props: { mode: 'edit' },
      meta: { wide: true },
    },
    { path: '/privacy', name: 'privacy', component: () => import('./pages/PrivacyPage.vue') },
    { path: '/terms', name: 'terms', component: () => import('./pages/TermsPage.vue') },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('./pages/NotFoundPage.vue'),
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

// Entering the event layer points the store at the route's event. Not
// awaited: pages render their own loading state and share the in-flight
// request through ensureLoaded(slug).
router.beforeEach((to) => {
  if (to.meta.eventLayer && typeof to.params.slug === 'string') {
    void useEventStore().select(to.params.slug)
  }
})

/** Slug of the event layer route, for components outside the page tree. */
export function routeSlug(route: RouteLocationNormalized): string | null {
  return route.meta.eventLayer && typeof route.params.slug === 'string' ? route.params.slug : null
}
