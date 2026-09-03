import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Key Encryption Key service — wraps/unwraps per-record DEKs.
 *
 * Production uses Cloud KMS (KmsKek, wired at deployment); local
 * development and tests use LocalKek with a key from the environment.
 * The envelope format is identical, so data written locally stays
 * readable if the same KEK is supplied.
 */
export interface KeyEncryptionService {
  wrapDek(dek: Buffer): Promise<Buffer>
  unwrapDek(wrapped: Buffer): Promise<Buffer>
}

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export interface KmsKekOptions {
  /** Full key resource: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>. */
  keyName: string
  tokenProvider: () => Promise<string>
  fetchImpl?: typeof fetch
}

/**
 * Production KEK: Cloud KMS encrypt/decrypt over REST (spec §7.3).
 * Only the ~32-byte DEK ever travels to KMS — content stays local.
 */
export class KmsKek implements KeyEncryptionService {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: KmsKekOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async call(method: 'encrypt' | 'decrypt', bodyField: string, value: Buffer) {
    const res = await this.fetchImpl(
      `https://cloudkms.googleapis.com/v1/${this.opts.keyName}:${method}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.opts.tokenProvider()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ [bodyField]: value.toString('base64') }),
      },
    )
    if (!res.ok) throw new Error(`cloud kms ${method} failed: ${res.status}`)
    return (await res.json()) as { ciphertext?: string; plaintext?: string }
  }

  async wrapDek(dek: Buffer): Promise<Buffer> {
    const { ciphertext } = await this.call('encrypt', 'plaintext', dek)
    if (!ciphertext) throw new Error('cloud kms returned no ciphertext')
    return Buffer.from(ciphertext, 'base64')
  }

  async unwrapDek(wrapped: Buffer): Promise<Buffer> {
    const { plaintext } = await this.call('decrypt', 'ciphertext', wrapped)
    if (!plaintext) throw new Error('cloud kms returned no plaintext')
    return Buffer.from(plaintext, 'base64')
  }
}

/** AES-256-GCM wrap with a static key. Local development only. */
export class LocalKek implements KeyEncryptionService {
  private readonly key: Buffer

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64')
    if (this.key.length !== KEY_BYTES) {
      throw new Error(
        `LOCAL_KEK_BASE64 must decode to exactly ${KEY_BYTES} bytes ` +
          '(generate one with: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))")',
      )
    }
  }

  wrapDek(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(dek), cipher.final()])
    return Promise.resolve(Buffer.concat([iv, cipher.getAuthTag(), enc]))
  }

  unwrapDek(wrapped: Buffer): Promise<Buffer> {
    if (wrapped.length < IV_BYTES + TAG_BYTES + 1) {
      return Promise.reject(new Error('wrapped DEK too short'))
    }
    const iv = wrapped.subarray(0, IV_BYTES)
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const enc = wrapped.subarray(IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Promise.resolve(Buffer.concat([decipher.update(enc), decipher.final()]))
  }
}
