import { describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { AuthError, DevTokenVerifier, FirebaseTokenVerifier } from '../src/auth/verifier.js'

const PROJECT_ID = 'demo-project'

async function makeFirebaseSetup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'test-key'
  jwk.alg = 'RS256'
  const jwks = createLocalJWKSet({ keys: [jwk] })
  const sign = (claims: Record<string, unknown>, audience = PROJECT_ID) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(audience)
      .setSubject((claims.sub as string) ?? 'uid-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
  return { jwks, sign }
}

describe('FirebaseTokenVerifier', () => {
  it('accepts a valid token with a verified email', async () => {
    const { jwks, sign } = await makeFirebaseSetup()
    const verifier = new FirebaseTokenVerifier(PROJECT_ID, jwks)
    const token = await sign({ email: 'user@example.com', email_verified: true })
    const identity = await verifier.verify(token)
    expect(identity.email).toBe('user@example.com')
    expect(identity.subject).toBe('uid-123')
  })

  it('rejects a token for a different Firebase project (audience)', async () => {
    const { jwks, sign } = await makeFirebaseSetup()
    const verifier = new FirebaseTokenVerifier(PROJECT_ID, jwks)
    const token = await sign({ email: 'user@example.com', email_verified: true }, 'other-project')
    await expect(verifier.verify(token)).rejects.toThrowError(AuthError)
  })

  it('rejects an unverified email', async () => {
    const { jwks, sign } = await makeFirebaseSetup()
    const verifier = new FirebaseTokenVerifier(PROJECT_ID, jwks)
    const token = await sign({ email: 'user@example.com', email_verified: false })
    await expect(verifier.verify(token)).rejects.toThrowError(AuthError)
  })

  it('rejects garbage tokens', async () => {
    const { jwks } = await makeFirebaseSetup()
    const verifier = new FirebaseTokenVerifier(PROJECT_ID, jwks)
    await expect(verifier.verify('not-a-jwt')).rejects.toThrowError(AuthError)
  })
})

describe('DevTokenVerifier', () => {
  it('accepts dev:<email> tokens outside production', async () => {
    const verifier = new DevTokenVerifier('development')
    const identity = await verifier.verify('dev:someone@example.com')
    expect(identity.email).toBe('someone@example.com')
  })

  it('rejects malformed dev tokens', async () => {
    const verifier = new DevTokenVerifier('development')
    await expect(verifier.verify('someone@example.com')).rejects.toThrowError(AuthError)
    await expect(verifier.verify('dev:not-an-email')).rejects.toThrowError(AuthError)
  })

  it('refuses to be constructed in production', () => {
    expect(() => new DevTokenVerifier('production')).toThrowError(/production/)
  })
})
