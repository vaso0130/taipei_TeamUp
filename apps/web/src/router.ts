import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./pages/HomePage.vue') },
    { path: '/teams', name: 'teams', component: () => import('./pages/TeamsPage.vue') },
    {
      path: '/teams/:id',
      name: 'team-detail',
      component: () => import('./pages/TeamDetailPage.vue'),
    },
    { path: '/people', name: 'people', component: () => import('./pages/PeoplePage.vue') },
    { path: '/messages', name: 'messages', component: () => import('./pages/MessagesPage.vue') },
    {
      path: '/applications',
      name: 'applications',
      component: () => import('./pages/ApplicationsPage.vue'),
    },
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
