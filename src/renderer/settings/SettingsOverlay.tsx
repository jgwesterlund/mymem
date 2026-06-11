import { useEffect, useState } from 'react'
import type { ModelChoice, ProviderStatus, Template } from '@shared/types'
import { invoke, on } from '../api'
import { useUiStore, toast } from '../stores/ui'
import { useChatStore } from '../stores/chat'
import { ModelPicker } from '../shell/ModelPicker'

/**
 * Settings overlay (Cmd+,): a modal in the main window — deliberately NOT a
 * separate settings window (plan cut). Sections: General (theme),
 * AI (providers + default model + chat instructions), Data (index/embeddings),
 * Templates (CRUD; notes save into it via the ⋯ menu in NoteView).
 */
type Section = 'general' | 'ai' | 'data' | 'templates'

function SectionButton({ id, label, active, onClick }: { id: Section; label: string; active: boolean; onClick: (id: Section) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onClick(id)}
      className={`w-full rounded-md px-2.5 py-1.5 text-left text-[13px] ${active ? 'bg-active font-medium' : 'text-ink-muted hover:bg-hover'}`}
    >
      {label}
    </button>
  )
}

function OAuthCard({
  provider,
  busy,
  deviceCode,
  onLogin,
  onCancel,
  onLogout
}: {
  provider: ProviderStatus
  busy: boolean
  deviceCode: { verificationUrl: string; userCode: string } | null
  onLogin: (method: 'browser' | 'device_code') => void
  onCancel: () => void
  onLogout: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-hairline px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">{provider.label}</p>
          <p className="text-[11px] text-ink-muted">
            {provider.connected ? `Connected${provider.account ? ` · ${provider.account}` : ''}` : 'Not connected'}
          </p>
        </div>
        {provider.connected ? (
          <button onClick={onLogout} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover">
            Disconnect
          </button>
        ) : busy ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-ink-muted">Waiting…</span>
            <button
              onClick={onCancel}
              className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <button
              onClick={() => onLogin('browser')}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
            >
              Connect via browser
            </button>
            {provider.id === 'openai-codex' && (
              <button
                onClick={() => onLogin('device_code')}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
              >
                Device code
              </button>
            )}
          </div>
        )}
      </div>
      {busy && deviceCode && (
        <div className="mt-2 rounded-md bg-surface-dim px-2.5 py-2 text-[12px]">
          Go to{' '}
          <a href={deviceCode.verificationUrl} target="_blank" rel="noreferrer" className="font-medium text-accent underline">
            {deviceCode.verificationUrl}
          </a>{' '}
          and enter code <code className="select-text rounded bg-active px-1 font-mono">{deviceCode.userCode}</code>
        </div>
      )}
    </div>
  )
}

function ApiKeyCard({ provider, onSaved }: { provider: ProviderStatus; onSaved: () => void }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="rounded-lg border border-hairline px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium">{provider.label}</p>
          <p className="text-[11px] text-ink-muted">{provider.connected ? 'Key saved' : 'No key set'}</p>
        </div>
        {provider.connected && (
          <button
            onClick={() => {
              void invoke('oauth:logout', { provider: provider.id }).then(onSaved)
            }}
            className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
          >
            Remove key
          </button>
        )}
      </div>
      <div className="mt-2 flex gap-1.5">
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setError(null)
          }}
          placeholder="sk-…"
          className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent/50"
          style={{ userSelect: 'text' }}
        />
        <button
          disabled={!key.trim()}
          onClick={() => {
            void invoke('apikey:set', { provider: provider.id, apiKey: key }).then((res) => {
              if (res.ok) {
                setKey('')
                onSaved()
              } else setError(res.error ?? 'Invalid key')
            })
          }}
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-[#b0524a] dark:text-[#c97a72]">{error}</p>}
    </div>
  )
}

function AiSection(): React.JSX.Element {
  const [status, setStatus] = useState<{ providers: ProviderStatus[]; encryptionAvailable: boolean } | null>(null)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [utilityModel, setUtilityModel] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [deviceCode, setDeviceCode] = useState<{ provider: string; verificationUrl: string; userCode: string } | null>(null)

  const refresh = (): void => {
    void invoke('oauth:status').then(setStatus)
    void invoke('ai:models').then(setModels)
    void useChatStore.getState().refreshModels() // keep the chat picker in sync
  }

  useEffect(() => {
    refresh()
    void invoke('settings:get', { key: 'ai.defaultModel' }).then((v) => {
      const m = v as { providerId?: string; modelId?: string } | null
      if (m?.providerId && m.modelId) setDefaultModel(`${m.providerId}|${m.modelId}`)
    })
    void invoke('settings:get', { key: 'ai.utilityModel' }).then((v) => {
      const m = v as { providerId?: string; modelId?: string } | null
      if (m?.providerId && m.modelId) setUtilityModel(`${m.providerId}|${m.modelId}`)
    })
    void invoke('settings:get', { key: 'ai.chatInstructions' }).then((v) => {
      if (typeof v === 'string') setInstructions(v)
    })
    return on('oauth:prompt', (p) => setDeviceCode(p))
  }, [])

  const login = (providerId: string, method: 'browser' | 'device_code'): void => {
    setBusyProvider(providerId)
    setDeviceCode(null)
    void invoke('oauth:login', { provider: providerId, method }).then((res) => {
      setBusyProvider(null)
      setDeviceCode(null)
      if (res.ok) toast('Connected')
      else if (res.error) toast(res.error)
      refresh()
    })
  }

  const cancelLogin = (providerId: string): void => {
    void invoke('oauth:cancel', { provider: providerId }).then(() => {
      setBusyProvider(null)
      setDeviceCode(null)
      refresh()
    })
  }

  const logout = (providerId: string): void => {
    void invoke('oauth:logout', { provider: providerId }).then(refresh)
  }

  if (!status) return <div />
  const oauthProviders = status.providers.filter((p) => p.kind === 'oauth')
  const keyProviders = status.providers.filter((p) => p.kind === 'apiKey')
  // 'providerId|modelId' ⇄ ModelPicker's { providerId, modelId } | null
  const parseModel = (v: string): { providerId: string; modelId: string } | null => {
    const [providerId, modelId] = v.split('|')
    return providerId && modelId ? { providerId, modelId } : null
  }
  const pickerTrigger =
    'mt-1 flex w-full items-center justify-between gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] hover:bg-hover'

  return (
    <div className="flex flex-col gap-3">
      {!status.encryptionAvailable && (
        <div className="rounded-md border border-[#a98e5f]/35 bg-[#a98e5f]/12 px-3 py-2 text-[12px] text-[#7a653f] dark:border-[#a98e5f]/35 dark:bg-[#a98e5f]/15 dark:text-[#cbb68a]">
          AI is disabled: macOS keychain encryption is unavailable, so credentials cannot be stored securely.
        </div>
      )}
      {oauthProviders.map((p) => (
        <OAuthCard
          key={p.id}
          provider={p}
          // pendingLogin (from oauth:status) survives an overlay close/reopen —
          // local busyProvider only bridges the gap until the next refresh.
          busy={busyProvider === p.id || p.pendingLogin === true}
          deviceCode={deviceCode?.provider === p.id ? deviceCode : null}
          onLogin={(method) => login(p.id, method)}
          onCancel={() => cancelLogin(p.id)}
          onLogout={() => logout(p.id)}
        />
      ))}
      {keyProviders.map((p) => (
        <ApiKeyCard key={p.id} provider={p} onSaved={refresh} />
      ))}

      <div className="mt-2">
        <p className="text-[12px] font-medium">Default chat model</p>
        <ModelPicker
          choices={models}
          value={parseModel(defaultModel)}
          noneLabel="First available"
          selectableNone
          triggerClassName={pickerTrigger}
          onChange={(m) => {
            setDefaultModel(m ? `${m.providerId}|${m.modelId}` : '')
            void invoke('settings:set', { key: 'ai.defaultModel', value: m })
          }}
        />
      </div>

      <div>
        <p className="text-[12px] font-medium">Utility model</p>
        <p className="text-[11px] text-ink-muted">Cheap model for note titles and auto-organize.</p>
        <ModelPicker
          choices={models}
          value={parseModel(utilityModel)}
          noneLabel="Cheapest available"
          selectableNone
          triggerClassName={pickerTrigger}
          onChange={(m) => {
            setUtilityModel(m ? `${m.providerId}|${m.modelId}` : '')
            void invoke('settings:set', { key: 'ai.utilityModel', value: m })
          }}
        />
      </div>

      <div>
        <p className="text-[12px] font-medium">Chat instructions</p>
        <p className="text-[11px] text-ink-muted">Included in every conversation's system prompt.</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => void invoke('settings:set', { key: 'ai.chatInstructions', value: instructions })}
          rows={4}
          placeholder="e.g. Answer in Swedish. Keep answers short."
          className="mt-1 w-full resize-none rounded-md border border-hairline bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-accent/50"
          style={{ userSelect: 'text' }}
        />
      </div>
    </div>
  )
}

type Theme = 'light' | 'dark' | 'system'

function GeneralSection(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>('system')
  const [menuBarIcon, setMenuBarIcon] = useState(true)
  const [loginItem, setLoginItem] = useState(false)
  useEffect(() => {
    void invoke('settings:get', { key: 'ui.theme' }).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setTheme(v)
    })
    // Default ON: only an explicit false means hidden (matches main's tray guard).
    void invoke('settings:get', { key: 'ui.menuBarIcon' }).then((v) => setMenuBarIcon(v !== false))
    // Login item state lives in the OS, not our settings DB — read it fresh.
    void invoke('app:getLoginItem').then((v) => setLoginItem(v.openAtLogin))
  }, [])
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-[12px] font-medium">Appearance</p>
        <p className="text-[11px] text-ink-muted">
          System follows macOS; Light/Dark force it for this app only.
        </p>
        <select
          data-testid="theme-select"
          value={theme}
          onChange={(e) => {
            const next = e.target.value as Theme
            setTheme(next)
            // theme:set (not settings:set): main also flips nativeTheme.themeSource,
            // which re-skins the vibrancy material and pushes theme:changed → .dark.
            void invoke('theme:set', { theme: next })
          }}
          className="mt-1 w-full rounded-md border border-hairline bg-surface px-2 py-1 text-[12px]"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium">Show menu bar icon</p>
          <p className="text-[11px] text-ink-muted">Quick access to myMem and Quick Capture from the menu bar.</p>
        </div>
        <input
          type="checkbox"
          checked={menuBarIcon}
          onChange={(e) => {
            setMenuBarIcon(e.target.checked)
            // Main toggles the tray live on this settings:set (handlers.ts).
            void invoke('settings:set', { key: 'ui.menuBarIcon', value: e.target.checked })
          }}
        />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium">Start myMem at login</p>
          <p className="text-[11px] text-ink-muted">Starts in the background — menu bar icon and ⌃⌘Space only.</p>
        </div>
        <input
          type="checkbox"
          checked={loginItem}
          onChange={(e) => {
            const wanted = e.target.checked
            setLoginItem(wanted) // optimistic; corrected by the re-read below
            void invoke('app:setLoginItem', { openAtLogin: wanted }).then(() =>
              invoke('app:getLoginItem').then((v) => {
                // The OS owns this state and can refuse — reflect reality.
                setLoginItem(v.openAtLogin)
                if (v.openAtLogin !== wanted) {
                  toast('macOS declined the change — see System Settings → Login Items')
                }
              })
            )
          }}
        />
      </div>
      <div>
        <p className="text-[12px] font-medium">Quick capture</p>
        <p className="text-[11px] text-ink-muted">
          ⌃⌘Space opens quick capture from anywhere — it works even with the window closed.
        </p>
      </div>
    </div>
  )
}

/** One template row: collapsed (name + actions) or expanded into an editor. */
function TemplateRow({ t, onChanged }: { t: Template; onChanged: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(t.name)
  const [contentMd, setContentMd] = useState(t.contentMd)
  return (
    <div className="rounded-lg border border-hairline px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent/50"
            style={{ userSelect: 'text' }}
          />
        ) : (
          <p className="truncate text-[13px] font-medium">{t.name}</p>
        )}
        <div className="flex shrink-0 gap-1.5">
          {editing ? (
            <>
              <button
                onClick={() => {
                  void invoke('templates:update', {
                    id: t.id,
                    patch: { name: name.trim() || t.name, contentMd }
                  }).then(() => {
                    setEditing(false)
                    onChanged()
                  })
                }}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setName(t.name)
                  setContentMd(t.contentMd)
                  setEditing(false)
                }}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  if (!window.confirm(`Delete template “${t.name}”?`)) return
                  void invoke('templates:delete', { id: t.id }).then(onChanged)
                }}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-[#b0524a] hover:bg-hover dark:text-[#c97a72]"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {editing && (
        <textarea
          value={contentMd}
          onChange={(e) => setContentMd(e.target.value)}
          rows={8}
          placeholder="Template markdown…"
          className="mt-2 w-full resize-none rounded-md border border-hairline bg-surface px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent/50"
          style={{ userSelect: 'text' }}
        />
      )}
    </div>
  )
}

function TemplatesSection(): React.JSX.Element {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const refresh = (): void => {
    void invoke('templates:list').then(setTemplates)
  }
  useEffect(refresh, [])
  if (!templates) return <div />
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-ink-muted">
          Save any note as a template via its ⋯ menu, or start one from scratch.
        </p>
        <button
          onClick={() => {
            void invoke('templates:create', { name: 'New template', contentMd: '' }).then(refresh)
          }}
          className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
        >
          New template
        </button>
      </div>
      {templates.length === 0 && (
        <p className="text-[12px] text-ink-muted">No templates yet.</p>
      )}
      {templates.map((t) => (
        <TemplateRow key={`${t.id}:${t.updatedAt}`} t={t} onChanged={refresh} />
      ))}
    </div>
  )
}

function DataSection(): React.JSX.Element {
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    void invoke('settings:get', { key: 'embeddings.consent' }).then((v) => setConsent(v === true))
  }, [])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium">Semantic search</p>
          <p className="text-[11px] text-ink-muted">Local embedding model (~25 MB) for Deep Search and Heads Up.</p>
        </div>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked)
            void invoke('settings:set', { key: 'embeddings.consent', value: e.target.checked })
          }}
        />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium">Search index</p>
          <p className="text-[11px] text-ink-muted">Re-chunk and re-index every note from scratch.</p>
        </div>
        <button
          onClick={() => {
            void invoke('index:rebuild')
            toast('Rebuilding index…')
          }}
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:bg-hover"
        >
          Rebuild index
        </button>
      </div>
    </div>
  )
}

export function SettingsOverlay(): React.JSX.Element | null {
  const open = useUiStore((s) => s.settingsOpen)
  const [section, setSection] = useState<Section>('ai')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useUiStore.getState().setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/25" onMouseDown={() => useUiStore.getState().setSettingsOpen(false)}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="mx-auto mt-[10vh] flex h-[70vh] w-[44rem] overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg"
      >
        <div className="w-40 shrink-0 border-r border-hairline bg-surface-dim p-2">
          <p className="px-2.5 pb-2 pt-1 text-[13px] font-semibold">Settings</p>
          <SectionButton id="general" label="General" active={section === 'general'} onClick={setSection} />
          <SectionButton id="ai" label="AI" active={section === 'ai'} onClick={setSection} />
          <SectionButton id="data" label="Data" active={section === 'data'} onClick={setSection} />
          <SectionButton id="templates" label="Templates" active={section === 'templates'} onClick={setSection} />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {section === 'general' && <GeneralSection />}
          {section === 'ai' && <AiSection />}
          {section === 'data' && <DataSection />}
          {section === 'templates' && <TemplatesSection />}
        </div>
      </div>
    </div>
  )
}
