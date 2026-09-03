import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { KeyEncryptionService } from './kek.js'

/**
 * Application-layer envelope encryption (spec §7.3):
 * a fresh random DEK per record, AES-256-GCM for the content, the DEK
 * itself wrapped by the KEK (Cloud KMS in production). Plaintext DEKs
 * live only in memory for the duration of one call.
 *
 * Blob layout (bytea in PostgreSQL):
 *   [1B version=1][2B BE wrapped-DEK length][wrapped DEK]
 *   [12B IV][16B GCM tag][ciphertext]
 */
const VERSION = 1
const DEK_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export class FieldCipher {
  constructor(private readonly kek: KeyEncryptionService) {}

  async encrypt(plaintext: string): Promise<Buffer> {
    const dek = randomBytes(DEK_BYTES)
    try {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', dek, iv)
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      const wrapped = await this.kek.wrapDek(dek)

      const header = Buffer.alloc(3)
      header.writeUInt8(VERSION, 0)
      header.writeUInt16BE(wrapped.length, 1)
      return Buffer.concat([header, wrapped, iv, tag, enc])
    } finally {
      dek.fill(0)
    }
  }

  async decrypt(blob: Buffer): Promise<string> {
    if (blob.length < 3) throw new Error('ciphertext blob too short')
    const version = blob.readUInt8(0)
    if (version !== VERSION) throw new Error(`unsupported envelope version ${version}`)
    const wrappedLen = blob.readUInt16BE(1)
    let offset = 3
    const wrapped = blob.subarray(offset, offset + wrappedLen)
    offset += wrappedLen
    const iv = blob.subarray(offset, offset + IV_BYTES)
    offset += IV_BYTES
    const tag = blob.subarray(offset, offset + TAG_BYTES)
    offset += TAG_BYTES
    const enc = blob.subarray(offset)

    const dek = await this.kek.unwrapDek(wrapped)
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    } finally {
      dek.fill(0)
    }
  }
}
