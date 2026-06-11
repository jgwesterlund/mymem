import { safeStorage } from 'electron'
import type { SettingsRepo } from '../db/repos/miscRepos'

/**
 * Encrypted credential store (OAuth tokens AND API keys). Values are
 * JSON → safeStorage.encryptString → base64, persisted in settings as
 * { v: 1, blob } under 'ai.creds.<provider>'. NEVER plaintext, NEVER a
 * pi-ai auth.json. If the OS keychain is unavailable
 * (isEncryptionAvailable() === false) the whole AI layer is disabled —
 * surfaced to the renderer via oauth:status.encryptionAvailable.
 */
const KEY_PREFIX = 'ai.creds.'

type EncryptedBlob = { v: 1; blob: string }

function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Partial<EncryptedBlob>
  return b.v === 1 && typeof b.blob === 'string'
}

export function createCredentialsStore(settings: SettingsRepo) {
  return {
    available(): boolean {
      return safeStorage.isEncryptionAvailable()
    },

    set(providerId: string, value: unknown): void {
      if (!this.available()) throw new Error('Secure storage is unavailable — AI features are disabled.')
      const blob = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
      settings.set(KEY_PREFIX + providerId, { v: 1, blob } satisfies EncryptedBlob)
    },

    get<T>(providerId: string): T | null {
      if (!safeStorage.isEncryptionAvailable()) return null
      const rec = settings.get(KEY_PREFIX + providerId)
      if (!isEncryptedBlob(rec)) return null
      try {
        return JSON.parse(safeStorage.decryptString(Buffer.from(rec.blob, 'base64'))) as T
      } catch {
        // Keychain identity changed or blob corrupt → treat as logged out (re-auth fixes it).
        return null
      }
    },

    delete(providerId: string): void {
      settings.delete(KEY_PREFIX + providerId)
    }
  }
}

export type CredentialsStore = ReturnType<typeof createCredentialsStore>
