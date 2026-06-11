import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { ChatMeta } from '@shared/types'

type ChatRow = {
  id: string
  title: string
  provider_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

export type ChatMessageRole = 'user' | 'assistant' | 'toolResult'

export interface ChatMessageRow {
  id: string
  idx: number
  role: ChatMessageRole
  /** Parsed pi-ai message object (stored verbatim as content_json). */
  content: unknown
  createdAt: number
}

function toMeta(row: ChatRow): ChatMeta {
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createChatsRepo(db: Database.Database) {
  const getStmt = db.prepare(`SELECT * FROM chats WHERE id = ?`)
  const touch = db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`)
  const nextIdx = db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM chat_messages WHERE chat_id = ?`)
  const insertMsg = db.prepare(
    `INSERT INTO chat_messages (id, chat_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  )

  return {
    create(input?: { title?: string }): ChatMeta {
      const id = uuidv7()
      const now = Date.now()
      db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
        id,
        input?.title ?? 'New chat',
        now,
        now
      )
      return this.get(id)!
    },

    get(id: string): ChatMeta | null {
      const row = getStmt.get(id) as ChatRow | undefined
      return row ? toMeta(row) : null
    },

    list(): ChatMeta[] {
      return (db.prepare(`SELECT * FROM chats ORDER BY updated_at DESC`).all() as ChatRow[]).map(toMeta)
    },

    delete(id: string): void {
      db.prepare(`DELETE FROM chats WHERE id = ?`).run(id) // messages cascade
    },

    updateTitle(id: string, title: string): void {
      db.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id)
    },

    /** Model is locked at first send: only writes when provider/model are still NULL. */
    setModel(id: string, providerId: string, modelId: string): void {
      db.prepare(
        `UPDATE chats SET provider_id = ?, model_id = ? WHERE id = ? AND provider_id IS NULL`
      ).run(providerId, modelId, id)
    },

    /** Append a pi-ai message verbatim; idx = max+1 (created_at collides on fast tool turns). */
    appendMessage(chatId: string, role: ChatMessageRole, message: unknown): { id: string; idx: number } {
      const id = uuidv7()
      const now = Date.now()
      const run = db.transaction((): { id: string; idx: number } => {
        const { idx } = nextIdx.get(chatId) as { idx: number }
        insertMsg.run(id, chatId, idx, role, JSON.stringify(message), now)
        touch.run(now, chatId)
        return { id, idx }
      })
      return run()
    },

    messages(chatId: string): ChatMessageRow[] {
      const rows = db
        .prepare(`SELECT id, idx, role, content_json, created_at FROM chat_messages WHERE chat_id = ? ORDER BY idx`)
        .all(chatId) as { id: string; idx: number; role: ChatMessageRole; content_json: string; created_at: number }[]
      return rows.map((r) => ({
        id: r.id,
        idx: r.idx,
        role: r.role,
        content: JSON.parse(r.content_json) as unknown,
        createdAt: r.created_at
      }))
    }
  }
}

export type ChatsRepo = ReturnType<typeof createChatsRepo>
