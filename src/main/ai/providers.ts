import { shell } from 'electron'
import { getModels } from '@earendil-works/pi-ai'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import {
  getOAuthApiKey,
  loginAnthropic,
  loginOpenAICodex,
  loginOpenAICodexDeviceCode
} from '@earendil-works/pi-ai/oauth'
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import type { ModelChoice, ProviderStatus } from '@shared/types'
import type { SettingsRepo } from '../db/repos/miscRepos'
import type { CredentialsStore } from './credentials'

/**
 * Provider manager: two OAuth providers (Codex via ChatGPT subscription,
 * Anthropic via Claude Pro/Max) + two API-key providers. Our provider ids
 * double as pi-ai OAuth ids where applicable; 'anthropic-api' maps onto the
 * same pi-ai model catalog as 'anthropic'. GitHub Copilot: deliberate cut.
 */
interface ProviderDef {
  id: string
  label: string
  /** Short name used in model-picker labels ('Codex · gpt-5.5'). */
  short: string
  kind: 'oauth' | 'apiKey'
  /** pi-ai model-catalog provider. */
  catalog: KnownProvider
  /** pi-ai OAuth provider id (oauth kind only). */
  oauthId?: 'openai-codex' | 'anthropic'
}

const PROVIDERS: ProviderDef[] = [
  { id: 'openai-codex', label: 'OpenAI Codex (ChatGPT)', short: 'Codex', kind: 'oauth', catalog: 'openai-codex', oauthId: 'openai-codex' },
  { id: 'anthropic', label: 'Claude Pro/Max', short: 'Claude', kind: 'oauth', catalog: 'anthropic', oauthId: 'anthropic' },
  { id: 'openai', label: 'OpenAI API key', short: 'OpenAI', kind: 'apiKey', catalog: 'openai' },
  { id: 'anthropic-api', label: 'Anthropic API key', short: 'Anthropic', kind: 'apiKey', catalog: 'anthropic' }
]

/** Thrown when a turn needs credentials that are missing/expired → ChatEvent error 'auth_expired'. */
export class AuthRequiredError extends Error {
  constructor(providerId: string, detail?: string) {
    super(detail ?? `Not connected to ${providerId} — connect it in Settings → AI.`)
    this.name = 'AuthRequiredError'
  }
}

type StoredApiKey = { key: string }

export function createProviderManager(deps: {
  credentials: CredentialsStore
  settings: SettingsRepo
  /** Device-code flows push { provider, verificationUrl, userCode } to the renderer (oauth:prompt). */
  onDeviceCode: (info: { provider: string; verificationUrl: string; userCode: string }) => void
}) {
  const { credentials, settings, onDeviceCode } = deps
  const byId = (id: string): ProviderDef => {
    const def = PROVIDERS.find((p) => p.id === id)
    if (!def) throw new Error(`unknown AI provider: ${id}`)
    return def
  }

  const isConnected = (def: ProviderDef): boolean => credentials.get(def.id) !== null

  // Single-flight per provider: concurrent turns share one refresh instead of
  // racing getOAuthApiKey (a double-refresh can invalidate the first new token).
  const inflight = new Map<string, Promise<string>>()

  // Active login flow per provider — drives oauth:cancel, the double-start guard
  // and the pendingLogin field in oauth:status.
  const loginFlights = new Map<string, AbortController>()

  /** Manual code paste is not supported in v1 — device code is the fallback when the callback server can't bind. */
  const rejectPrompt = async (): Promise<string> => {
    throw new Error(
      'Browser sign-in could not complete automatically (is port 1455 in use by another Codex login?). Try the device-code method instead.'
    )
  }

  return {
    status(): { providers: ProviderStatus[]; encryptionAvailable: boolean } {
      const encryptionAvailable = credentials.available()
      const providers: ProviderStatus[] = PROVIDERS.map((def) => {
        const connected = encryptionAvailable && isConnected(def)
        let account: string | undefined
        if (connected && def.kind === 'oauth') {
          // Codex credentials carry the ChatGPT account id (via the OAuthCredentials
          // index signature); Anthropic's expose nothing displayable.
          const creds = credentials.get<OAuthCredentials>(def.id)
          const accountId = creds?.accountId
          if (typeof accountId === 'string' && accountId.length > 0) account = accountId
        }
        // pendingLogin survives an overlay close/reopen — the renderer derives its
        // busy state from here instead of resetting to idle.
        return { id: def.id, label: def.label, kind: def.kind, connected, account, pendingLogin: loginFlights.has(def.id) }
      })
      return { providers, encryptionAvailable }
    },

    async login(providerId: string, method?: 'browser' | 'device_code'): Promise<{ ok: boolean; error?: string }> {
      const def = byId(providerId)
      if (!credentials.available()) return { ok: false, error: 'Secure storage is unavailable — AI features are disabled.' }
      if (def.kind !== 'oauth' || !def.oauthId) return { ok: false, error: `${def.label} uses an API key — set it in Settings → AI.` }
      // Double-start guard: a second login while one is pending would spawn a
      // second callback server / device-code poll racing the first.
      if (loginFlights.has(def.id)) return { ok: false, error: 'login already in progress' }
      const flight = new AbortController()
      loginFlights.set(def.id, flight)
      try {
        let creds: OAuthCredentials
        if (def.oauthId === 'openai-codex' && method === 'device_code') {
          creds = await loginOpenAICodexDeviceCode({
            onDeviceCode: (info) =>
              onDeviceCode({ provider: def.id, verificationUrl: info.verificationUri, userCode: info.userCode }),
            signal: flight.signal
          })
        } else if (def.oauthId === 'openai-codex') {
          // loginOpenAICodex spawns its own localhost:1455 callback server; onAuth
          // hands us the URL to open. Port collision → the error from rejectPrompt
          // tells the user to switch to device code. (No signal in its options —
          // cancel drops the flight and the aborted check below discards a late
          // completion without persisting.)
          creds = await loginOpenAICodex({
            onAuth: ({ url }) => void shell.openExternal(url),
            onPrompt: rejectPrompt,
            onProgress: (m) => console.log(`[oauth codex] ${m}`)
          })
        } else {
          // Anthropic has no device-code variant; the method arg is ignored.
          creds = await loginAnthropic({
            onAuth: ({ url }) => void shell.openExternal(url),
            onPrompt: rejectPrompt,
            onProgress: (m) => console.log(`[oauth anthropic] ${m}`)
          })
        }
        if (flight.signal.aborted) return { ok: false, error: 'Login cancelled.' }
        credentials.set(def.id, creds)
        return { ok: true }
      } catch (err) {
        if (flight.signal.aborted) return { ok: false, error: 'Login cancelled.' }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        // Only clear OUR flight — cancelLogin may already have dropped it and a
        // newer login may own the slot by the time a stale flow settles.
        if (loginFlights.get(def.id) === flight) loginFlights.delete(def.id)
      }
    },

    /** oauth:cancel — abort the active login flow (no-op when none is pending). */
    cancelLogin(providerId: string): void {
      const def = byId(providerId)
      const flight = loginFlights.get(def.id)
      if (!flight) return
      flight.abort()
      // Browser flows ignore the signal (their pi-ai options take none) — drop the
      // flight NOW so pendingLogin clears; login() discards any late completion.
      loginFlights.delete(def.id)
    },

    logout(providerId: string): void {
      credentials.delete(byId(providerId).id)
      inflight.delete(providerId)
    },

    /** Format-only validation — real validation happens on first use with a clear error (offline-tolerant). */
    setApiKey(providerId: string, apiKey: string): { ok: boolean; error?: string } {
      const def = byId(providerId)
      if (def.kind !== 'apiKey') return { ok: false, error: `${def.label} uses OAuth — connect it instead.` }
      if (!credentials.available()) return { ok: false, error: 'Secure storage is unavailable — AI features are disabled.' }
      const key = apiKey.trim()
      if (key.length < 20 || /\s/.test(key) || !key.startsWith('sk-')) {
        return { ok: false, error: 'That does not look like an API key (expected sk-…).' }
      }
      credentials.set(def.id, { key } satisfies StoredApiKey)
      return { ok: true }
    },

    /** API key for a request: stored key, or OAuth access token auto-refreshed via getOAuthApiKey. */
    getApiKeyFor(providerId: string): Promise<string> {
      const def = byId(providerId)
      if (def.kind === 'apiKey') {
        const stored = credentials.get<StoredApiKey>(def.id)
        if (!stored?.key) return Promise.reject(new AuthRequiredError(def.label))
        return Promise.resolve(stored.key)
      }
      let p = inflight.get(def.id)
      if (!p) {
        p = (async () => {
          const creds = credentials.get<OAuthCredentials>(def.id)
          if (!creds) throw new AuthRequiredError(def.label)
          let res: Awaited<ReturnType<typeof getOAuthApiKey>>
          try {
            res = await getOAuthApiKey(def.oauthId!, { [def.oauthId!]: creds })
          } catch {
            // pi-ai throws 'Failed to refresh OAuth token for <id>' — left as-is it
            // classifies 'unknown' (generic error) instead of the Reconnect banner.
            throw new AuthRequiredError(def.label, `Your ${def.label} session could not be refreshed — reconnect it in Settings → AI.`)
          }
          if (!res) throw new AuthRequiredError(def.label)
          // Persist rotated tokens so the refresh survives an app restart — but a
          // logout that raced this refresh wins: re-persisting would resurrect
          // credentials the user just deleted.
          if (res.newCredentials.access !== creds.access || res.newCredentials.refresh !== creds.refresh) {
            if (credentials.get(def.id) !== null) credentials.set(def.id, res.newCredentials)
          }
          return res.apiKey
        })()
        inflight.set(def.id, p)
        void p.finally(() => inflight.delete(def.id))
      }
      return p
    },

    /** Model picker entries for every CONNECTED provider. */
    models(): ModelChoice[] {
      if (!credentials.available()) return []
      const out: ModelChoice[] = []
      for (const def of PROVIDERS) {
        if (!isConnected(def)) continue
        for (const m of getModels(def.catalog)) {
          // Skip date-pinned aliases (claude-*-20250514 etc.) — they duplicate the
          // rolling ids and would triple the picker.
          if (/-\d{8}$/.test(m.id)) continue
          out.push({
            providerId: def.id,
            modelId: m.id,
            label: `${def.short} · ${m.id}`,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning
          })
        }
      }
      return out
    },

    resolveModel(providerId: string, modelId: string): Model<Api> | null {
      const def = PROVIDERS.find((p) => p.id === providerId)
      if (!def) return null
      return (getModels(def.catalog) as Model<Api>[]).find((m) => m.id === modelId) ?? null
    },

    /** Settings-pinned default chat model, falling back to the first available choice. */
    defaultModel(): { providerId: string; modelId: string } | null {
      const pinned = settings.get<{ providerId?: string; modelId?: string }>('ai.defaultModel')
      if (
        pinned &&
        typeof pinned.providerId === 'string' &&
        typeof pinned.modelId === 'string' &&
        this.resolveModel(pinned.providerId, pinned.modelId) &&
        isConnected(byId(pinned.providerId))
      ) {
        return { providerId: pinned.providerId, modelId: pinned.modelId }
      }
      const first = this.models()[0]
      return first ? { providerId: first.providerId, modelId: first.modelId } : null
    },

    /**
     * Cheap model for titles + auto-organize: settings-pinned 'ai.utilityModel',
     * else the cheapest-looking connected model (id contains mini/haiku/spark),
     * else the first available choice. Null when no provider is connected.
     */
    utilityModel(): { providerId: string; modelId: string } | null {
      const pinned = settings.get<{ providerId?: string; modelId?: string }>('ai.utilityModel')
      if (
        pinned &&
        typeof pinned.providerId === 'string' &&
        typeof pinned.modelId === 'string' &&
        this.resolveModel(pinned.providerId, pinned.modelId) &&
        isConnected(byId(pinned.providerId))
      ) {
        return { providerId: pinned.providerId, modelId: pinned.modelId }
      }
      const choices = this.models()
      const cheap = choices.find((c) => /mini|haiku|spark/i.test(c.modelId))
      const pick = cheap ?? choices[0]
      return pick ? { providerId: pick.providerId, modelId: pick.modelId } : null
    }
  }
}

export type ProviderManager = ReturnType<typeof createProviderManager>
