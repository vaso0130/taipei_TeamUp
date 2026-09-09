import { GoogleAuth } from 'google-auth-library'
import { KmsKek, LocalKek, type KeyEncryptionService } from './kek.js'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when DATABASE_URL is set`)
  return value
}

/** OAuth2 access-token provider for Google APIs (ADC in production). */
export const googleTokenProvider = (): (() => Promise<string>) => {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  return async () => {
    const token = await auth.getAccessToken()
    if (!token) throw new Error('failed to obtain a Google access token')
    return token
  }
}

/**
 * KEK selection from the environment, shared by the server and the
 * operational scripts so both decrypt with the very same key material.
 * `local` never runs in production (ADR-014).
 */
export function buildKekFromEnv(): KeyEncryptionService {
  const provider = process.env.KEK_PROVIDER ?? 'local'
  if (provider === 'local') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('KEK_PROVIDER=local must never run in production — use kms')
    }
    return new LocalKek(requireEnv('LOCAL_KEK_BASE64'))
  }
  if (provider === 'kms') {
    return new KmsKek({
      keyName: requireEnv('KMS_KEY_NAME'),
      tokenProvider: googleTokenProvider(),
    })
  }
  throw new Error(`unsupported KEK_PROVIDER "${provider}" (supported: local, kms)`)
}
