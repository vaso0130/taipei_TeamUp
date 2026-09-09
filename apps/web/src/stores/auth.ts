import { defineStore } from 'pinia'
import type { MeView } from '@teamup/shared'
import { api, ApiError, setUnauthorizedHandler } from '../api/client.js'
import { firebaseEnabled, getFirebaseAuth } from '../lib/firebase.js'

const DEV_TOKEN_KEY = 'teamup.token'
const EMAIL_LINK_KEY = 'teamup.emailForSignIn'
/** Set while a Firebase session exists so anonymous visits skip loading the SDK. */
const SESSION_HINT_KEY = 'teamup.hasSession'

/** Log only the error's code/name — Firebase error objects can carry the email. */
function logAuthError(err: unknown) {
  const e = err as { code?: string; name?: string } | null
  console.error('[auth]', e?.code ?? e?.name ?? 'unknown_error')
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable (private mode etc.) — session-only behaviour
  }
}

/** Firebase email-link landing URLs carry mode=signIn&oobCode=... */
function looksLikeEmailLink(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.get('mode') === 'signIn' && params.has('oobCode')
}

/**
 * Auth state. With Firebase configured (VITE_FIREBASE_*), sign-in uses
 * Google popup or an email magic link; tokens are fetched fresh from the
 * SDK before every API call (getToken). The SDK is only loaded when a
 * session hint, an email-link URL, or the login page asks for it, so an
 * anonymous visit to the home page never downloads firebase/auth.
 * Without Firebase, local development talks to the API's dev verifier
 * with "dev:<email>" tokens.
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    /** Last known token — used as a "has a session" flag, not as the bearer value. */
    token: null as string | null,
    me: null as MeView | null,
    loading: false,
    error: null as string | null,
    emailLinkSent: false,
    /** Set when an authenticated call came back 401; the shell offers re-login. */
    sessionExpired: false,
    firebaseStarted: false,
  }),
  getters: {
    isLoggedIn: (s) => s.me !== null,
    usesFirebase: () => firebaseEnabled,
  },
  actions: {
    init() {
      setUnauthorizedHandler(() => this.handleUnauthorized())
      if (firebaseEnabled) {
        if (readStorage(SESSION_HINT_KEY) === '1' || looksLikeEmailLink()) {
          void this.ensureFirebase()
        }
        return
      }
      if (import.meta.env.DEV) {
        this.token = readStorage(DEV_TOKEN_KEY)
        if (this.token) void this.fetchMe()
      }
    },

    /**
     * Fresh bearer token for an API call. Firebase renews the ID token
     * before expiry when asked; dev mode returns the cached string.
     */
    async getToken(): Promise<string | null> {
      if (!firebaseEnabled) return this.token
      try {
        const auth = await getFirebaseAuth()
        const user = auth.currentUser
        if (!user) return this.token
        return await user.getIdToken()
      } catch (err) {
        logAuthError(err)
        return this.token
      }
    },

    /** Start the Firebase SDK and its session listener (idempotent). */
    async ensureFirebase() {
      if (!firebaseEnabled || this.firebaseStarted) return
      this.firebaseStarted = true
      try {
        const auth = await getFirebaseAuth()
        const { onIdTokenChanged } = await import('firebase/auth')
        await this.maybeCompleteEmailLink()
        onIdTokenChanged(auth, (user) => {
          void (async () => {
            if (user) {
              this.token = await user.getIdToken()
              writeStorage(SESSION_HINT_KEY, '1')
              await this.fetchMe()
            } else {
              this.token = null
              this.me = null
              writeStorage(SESSION_HINT_KEY, null)
            }
          })()
        })
      } catch (err) {
        logAuthError(err)
        this.firebaseStarted = false
        this.error = '登入服務初始化失敗，請重新整理頁面'
      }
    },

    async loginWithGoogle() {
      this.error = null
      try {
        await this.ensureFirebase()
        const auth = await getFirebaseAuth()
        const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth')
        await signInWithPopup(auth, new GoogleAuthProvider())
        // onIdTokenChanged picks the session up from here.
      } catch (err) {
        logAuthError(err)
        this.error = 'Google 登入未完成，請再試一次'
      }
    },

    async sendEmailLink(email: string) {
      this.error = null
      this.emailLinkSent = false
      try {
        await this.ensureFirebase()
        const auth = await getFirebaseAuth()
        const { sendSignInLinkToEmail } = await import('firebase/auth')
        await sendSignInLinkToEmail(auth, email.trim(), {
          url: `${window.location.origin}/profile`,
          handleCodeInApp: true,
        })
        writeStorage(EMAIL_LINK_KEY, email.trim())
        this.emailLinkSent = true
      } catch (err) {
        logAuthError(err)
        this.error = '登入連結寄送失敗，請確認 Email 是否正確'
      }
    },

    /** Finish the email-link flow when the user lands from their inbox. */
    async maybeCompleteEmailLink() {
      const auth = await getFirebaseAuth()
      const { isSignInWithEmailLink, signInWithEmailLink } = await import('firebase/auth')
      if (!isSignInWithEmailLink(auth, window.location.href)) return
      let email = readStorage(EMAIL_LINK_KEY)
      email ??= window.prompt('為確認身分，請輸入你收到登入信的 Email')
      if (!email) {
        writeStorage(EMAIL_LINK_KEY, null)
        return
      }
      try {
        await signInWithEmailLink(auth, email, window.location.href)
        // Drop the one-time code from the address bar.
        window.history.replaceState(null, '', window.location.pathname)
      } catch (err) {
        logAuthError(err)
        this.error = '登入連結無效或已過期，請重新寄送'
      } finally {
        // The stored email is single-use either way.
        writeStorage(EMAIL_LINK_KEY, null)
      }
    },

    async devLogin(email: string) {
      if (!import.meta.env.DEV) return
      this.setDevToken(`dev:${email.trim()}`)
      await this.fetchMe()
    },

    setDevToken(token: string) {
      if (!import.meta.env.DEV) return
      this.token = token
      writeStorage(DEV_TOKEN_KEY, token)
    },

    /** Drop the local session without touching the error banner. */
    clearSession() {
      this.token = null
      this.me = null
      this.emailLinkSent = false
      writeStorage(DEV_TOKEN_KEY, null)
      writeStorage(EMAIL_LINK_KEY, null)
      writeStorage(SESSION_HINT_KEY, null)
      if (firebaseEnabled && this.firebaseStarted) {
        void getFirebaseAuth()
          .then((auth) => auth.signOut())
          .catch(logAuthError)
      }
    },

    logout() {
      this.error = null
      this.sessionExpired = false
      this.clearSession()
    },

    /** An authenticated request was rejected: end the session, offer re-login. */
    handleUnauthorized() {
      if (!this.token && !this.me) return
      this.clearSession()
      this.sessionExpired = true
    },

    dismissSessionExpired() {
      this.sessionExpired = false
    },

    async fetchMe() {
      if (!this.token) return
      this.loading = true
      this.error = null
      try {
        this.me = await api.getMe(() => this.getToken())
        this.sessionExpired = false
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // handleUnauthorized already cleared the session via the client hook.
          this.handleUnauthorized()
        } else if (err instanceof ApiError && err.status === 403) {
          this.me = null
          this.error = '此帳號目前無法使用'
        } else if (err instanceof ApiError && err.status === 503) {
          this.error = '此環境未連接資料庫，登入功能暫不可用'
        } else {
          this.error = '無法載入帳號資料，請稍後再試'
          logAuthError(err)
        }
      } finally {
        this.loading = false
      }
    },
  },
})
