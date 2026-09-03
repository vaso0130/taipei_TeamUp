import { defineStore } from 'pinia'
import type { MeView } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import { firebaseEnabled, getFirebaseAuth } from '../lib/firebase.js'

const DEV_TOKEN_KEY = 'teamup.token'
const EMAIL_LINK_KEY = 'teamup.emailForSignIn'

/**
 * Auth state. With Firebase configured (VITE_FIREBASE_*), sign-in uses
 * Google popup or an email magic link and tokens refresh via
 * onIdTokenChanged. Without it, local development talks to the API's
 * dev verifier with "dev:<email>" tokens.
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: null as string | null,
    me: null as MeView | null,
    loading: false,
    error: null as string | null,
    emailLinkSent: false,
  }),
  getters: {
    isLoggedIn: (s) => s.me !== null,
    usesFirebase: () => firebaseEnabled,
  },
  actions: {
    init() {
      if (firebaseEnabled) {
        void this.initFirebase()
        return
      }
      try {
        this.token = localStorage.getItem(DEV_TOKEN_KEY)
      } catch {
        this.token = null
      }
      if (this.token) void this.fetchMe()
    },

    async initFirebase() {
      try {
        const auth = await getFirebaseAuth()
        const { onIdTokenChanged } = await import('firebase/auth')
        await this.maybeCompleteEmailLink()
        onIdTokenChanged(auth, (user) => {
          void (async () => {
            if (user) {
              this.token = await user.getIdToken()
              await this.fetchMe()
            } else {
              this.token = null
              this.me = null
            }
          })()
        })
      } catch (err) {
        console.error(err)
        this.error = '登入服務初始化失敗，請重新整理頁面'
      }
    },

    async loginWithGoogle() {
      this.error = null
      try {
        const auth = await getFirebaseAuth()
        const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth')
        await signInWithPopup(auth, new GoogleAuthProvider())
        // onIdTokenChanged picks the session up from here.
      } catch (err) {
        console.error(err)
        this.error = 'Google 登入未完成，請再試一次'
      }
    },

    async sendEmailLink(email: string) {
      this.error = null
      this.emailLinkSent = false
      try {
        const auth = await getFirebaseAuth()
        const { sendSignInLinkToEmail } = await import('firebase/auth')
        await sendSignInLinkToEmail(auth, email.trim(), {
          url: `${window.location.origin}/profile`,
          handleCodeInApp: true,
        })
        try {
          localStorage.setItem(EMAIL_LINK_KEY, email.trim())
        } catch {
          // storage unavailable — completion will ask for the email
        }
        this.emailLinkSent = true
      } catch (err) {
        console.error(err)
        this.error = '登入連結寄送失敗，請確認 Email 是否正確'
      }
    },

    /** Finish the email-link flow when the user lands from their inbox. */
    async maybeCompleteEmailLink() {
      const auth = await getFirebaseAuth()
      const { isSignInWithEmailLink, signInWithEmailLink } = await import('firebase/auth')
      if (!isSignInWithEmailLink(auth, window.location.href)) return
      let email: string | null = null
      try {
        email = localStorage.getItem(EMAIL_LINK_KEY)
      } catch {
        email = null
      }
      email ??= window.prompt('為確認身分，請輸入你收到登入信的 Email')
      if (!email) return
      try {
        await signInWithEmailLink(auth, email, window.location.href)
        try {
          localStorage.removeItem(EMAIL_LINK_KEY)
        } catch {
          // ignore
        }
        // Drop the one-time code from the address bar.
        window.history.replaceState(null, '', window.location.pathname)
      } catch (err) {
        console.error(err)
        this.error = '登入連結無效或已過期，請重新寄送'
      }
    },

    async devLogin(email: string) {
      this.setDevToken(`dev:${email.trim()}`)
      await this.fetchMe()
    },

    setDevToken(token: string) {
      this.token = token
      try {
        localStorage.setItem(DEV_TOKEN_KEY, token)
      } catch {
        // storage unavailable — session-only login still works
      }
    },

    logout() {
      this.token = null
      this.me = null
      this.error = null
      this.emailLinkSent = false
      try {
        localStorage.removeItem(DEV_TOKEN_KEY)
      } catch {
        // ignore
      }
      if (firebaseEnabled) {
        void getFirebaseAuth().then((auth) => auth.signOut())
      }
    },

    async fetchMe() {
      if (!this.token) return
      this.loading = true
      this.error = null
      try {
        this.me = await api.getMe(this.token)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          this.logout()
          this.error = '登入已失效，請重新登入'
        } else if (err instanceof ApiError && err.status === 403) {
          this.me = null
          this.error = '此帳號目前無法使用'
        } else if (err instanceof ApiError && err.status === 503) {
          this.error = '此環境未連接資料庫，登入功能暫不可用'
        } else {
          this.error = '無法載入帳號資料，請稍後再試'
          console.error(err)
        }
      } finally {
        this.loading = false
      }
    },
  },
})
