import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Status, Watch } from "./watch.ts"

export function stateDirectory() {
  return process.env.WAKE_HOME ?? join(process.env.HOME ?? "", ".local/state/wake")
}

export function logDirectory(root = stateDirectory()) {
  return join(root, "logs")
}

/** Creates the private state directory. Everything under it is owner-only. */
export function ensureStateDirectory(root = stateDirectory()) {
  process.umask(0o077)
  mkdirSync(logDirectory(root), { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  return root
}

export class Store {
  readonly db: Database

  constructor(readonly root = ensureStateDirectory()) {
    this.db = new Database(join(root, "wake.db"), { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(`CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )`)
    this.db.exec("CREATE INDEX IF NOT EXISTS watches_status ON watches(status)")
    chmodSync(join(root, "wake.db"), 0o600)
  }

  insert(watch: Watch) {
    this.db
      .query("INSERT INTO watches (id, name, status, created_at, data) VALUES (?, ?, ?, ?, ?)")
      .run(watch.id, watch.name, watch.status, watch.createdAt, JSON.stringify(watch))
  }

  /** Insert unless the open-watch cap or a name clash would be exceeded; checked atomically. */
  insertChecked(watch: Watch, maxOpen: number) {
    return this.db.transaction(() => {
      const open = this.open()
      if (open.length >= maxOpen)
        throw new Error(`too many open watches (${open.length}/${maxOpen}); cancel some with \`wake cancel\``)
      if (open.some((other) => other.name === watch.name))
        throw new Error(`an open watch is already named ${watch.name}; pick another --name`)
      this.insert(watch)
    }).immediate()
  }

  /**
   * Compare-and-set on status, so a watch cancelled while its check was running is never overwritten
   * by the daemon's stale copy.
   */
  update(watch: Watch, expected: Status) {
    const result = this.db
      .query("UPDATE watches SET name = ?, status = ?, data = ? WHERE id = ? AND status = ?")
      .run(watch.name, watch.status, JSON.stringify(watch), watch.id, expected)
    return result.changes === 1
  }

  get(id: string) {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM watches WHERE id = ?").get(id)
    return row ? (JSON.parse(row.data) as Watch) : undefined
  }

  /** Resolve an ID, or a name (preferring the newest open watch with that name). */
  find(ref: string) {
    const byID = this.get(ref)
    if (byID) return byID
    const row = this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM watches WHERE name = ? ORDER BY status IN ('active', 'firing') DESC, created_at DESC LIMIT 1",
      )
      .get(ref)
    return row ? (JSON.parse(row.data) as Watch) : undefined
  }

  list(statuses?: readonly Status[], limit = 200) {
    const rows = statuses
      ? this.db
          .query<{ data: string }, string[]>(
            `SELECT data FROM watches WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at DESC`,
          )
          .all(...statuses)
      : this.db.query<{ data: string }, [number]>("SELECT data FROM watches ORDER BY created_at DESC LIMIT ?").all(limit)
    return rows.map((row) => JSON.parse(row.data) as Watch)
  }

  open() {
    return this.list(["active", "firing"])
  }

  close() {
    this.db.close()
  }
}
