import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface AuthIdentity {
  /** Verified email address — the only identity key we use (spec §4 users). */
  email: string
  /** Token subject (Firebase uid). Not persisted; kept for logging correlation. */
  subject: string
}

export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'AuthError'
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthIdentity>
}

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

/**
 * Verifies Firebase Authentication ID tokens (Google sign-in and email
 * magic link both produce verified emails). Stateless: signature via
 * Google's JWKS, issuer/audience pinned to the Firebase project.
 */
export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey

  constructor(
    private readonly projectId: string,
    jwks?: JWTVerifyGetKey,
  ) {
    if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required for firebase auth')
    this.jwks = jwks ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL))
  }

  async verify(token: string): Promise<AuthIdentity> {
    let payload
    try {
      ;({ payload } = await jwtVerify(token, this.jwks, {
        issuer: `https://securetoken.google.com/${this.projectId}`,
        audience: this.projectId,
        algorithms: ['RS256'],
      }))
    } catch {
      throw new AuthError('invalid_token')
    }
    if (typeof payload.email !== 'string' || payload.email_verified !== true) {
      throw new AuthError('email_not_verified')
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthError('invalid_token')
    }
    return { email: payload.email, subject: payload.sub }
  }
}

/**
 * Local-development verifier: accepts tokens of the form `dev:<email>`.
 * Hard-refuses to exist in production builds.
 */
export class DevTokenVerifier implements TokenVerifier {
  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') {
      throw new Error('DevTokenVerifier must never be enabled in production')
    }
  }

  verify(token: string): Promise<AuthIdentity> {
    const match = /^dev:(.+@.+\..+)$/.exec(token)
    if (!match || !match[1]) {
      return Promise.reject(new AuthError('invalid_token'))
    }
    return Promise.resolve({ email: match[1], subject: `dev-${match[1]}` })
  }
}
