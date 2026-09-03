/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Event slug to display; empty → first open event from the API. */
  readonly VITE_EVENT_SLUG?: string
  /** API origin; empty → same origin (dev server proxies /api). */
  readonly VITE_API_BASE_URL?: string
  /** reCAPTCHA Enterprise site key; empty → captcha disabled. */
  readonly VITE_RECAPTCHA_SITE_KEY?: string
  /** Firebase web config; all three present → Firebase login enabled. */
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
