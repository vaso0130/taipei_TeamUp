/**
 * Firebase web auth (Google sign-in + email magic link, spec §2.1).
 * Enabled only when all VITE_FIREBASE_* values are configured; loaded
 * dynamically so unconfigured (dev) builds never ship or run it.
 */
import type { Auth } from 'firebase/auth'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
}

export const firebaseEnabled = Boolean(config.apiKey && config.authDomain && config.projectId)

let authInstance: Auth | null = null

export async function getFirebaseAuth(): Promise<Auth> {
  if (!firebaseEnabled || !config.apiKey || !config.authDomain || !config.projectId) {
    throw new Error('firebase is not configured')
  }
  if (!authInstance) {
    const [{ initializeApp }, { getAuth }] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ])
    authInstance = getAuth(
      initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
      }),
    )
  }
  return authInstance
}
