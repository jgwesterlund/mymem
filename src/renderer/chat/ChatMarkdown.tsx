import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import { useTabsStore } from '../stores/tabs'

/**
 * Assistant-message markdown: mymem://note/<id> citations render as chips,
 * external links open in the default browser, anything else is neutralized.
 */
const NOTE_HREF = /^mymem:\/\/note\/([0-9a-f-]{36})$/i

// react-markdown 10's defaultUrlTransform whitelists only http/https/irc(s)/mailto/xmpp,
// so mymem: hrefs would arrive empty in the 'a' override. Whitelist ONLY the exact
// mymem://note/<uuid> shape — an identity transform would re-enable javascript: URLs.
const urlTransform = (url: string): string => (NOTE_HREF.test(url) ? url : defaultUrlTransform(url))

function openNote(noteId: string, inNewTab: boolean): void {
  const tabs = useTabsStore.getState()
  if (inNewTab) tabs.openTab({ kind: 'note', noteId })
  else tabs.openInCurrentTab({ kind: 'note', noteId })
}

// 'a' override: mymem://note/<id> → CitationChip; everything else opens externally
// (target=_blank → main's setWindowOpenHandler → shell.openExternal).
const markdownComponents: Components = {
  a({ href, children }) {
    const m = href ? NOTE_HREF.exec(href) : null
    if (m) {
      const noteId = m[1]!
      return (
        <button
          onClick={(e) => openNote(noteId, e.metaKey)}
          title="Open note (⌘-click: new tab)"
          className="citation-chip"
        >
          {children}
        </button>
      )
    }
    // urlTransform-neutralized links (javascript: etc.) arrive with an empty href.
    // Render plain text — an empty-href target=_blank anchor would shell-open the
    // app's own URL through the window-open handler.
    if (!href) return <span>{children}</span>
    return (
      <a href={href} target="_blank" rel="noreferrer" title={href}>
        {children}
      </a>
    )
  }
}

export function ChatMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown urlTransform={urlTransform} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
}
