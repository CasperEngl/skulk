import { Database } from "bun:sqlite"
import { chmodSync, closeSync, existsSync, openSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { env } from "./env.ts"
import { daemonPID } from "./pid.ts"
import { defaultSlotSize, Limits, type Status, type Watch } from "./watch.ts"

export interface Hold {
  readonly watchID: string
  readonly slot: string
  readonly sessionID: string
  readonly acquiredAt: number
  readonly expiresAt: number
}

export type Grant =
  | { readonly ok: true; readonly held: number; readonly size: number }
  | { readonly ok: false; readonly reason: string }

/** Pre-rename names: state lived in ~/.local/state/wake/wake.db until the CLI became skulk. */
export const databaseFile = "skulk.db"
export const legacyDatabaseFile = "wake.db"

/** Explicit $SKULK_HOME (or the pre-rename $WAKE_HOME) wins; otherwise ~/.local/state/skulk. */
export function stateDirectory() {
  return env("HOME") ?? join(process.env.HOME ?? "", ".local/state/skulk")
}

/** The pre-rename default directory, migrated automatically when no state directory is set explicitly. */
export function legacyStateDirectory() {
  return env("HOME") === undefined ? join(process.env.HOME ?? "", ".local/state/wake") : undefined
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

/** Folds the WAL into the main file, so the database is one file that can be renamed safely. False if busy. */
function checkpoint(path: string) {
  const db = new Database(path)
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const [busy] = db.query("PRAGMA wal_checkpoint(TRUNCATE)").values()[0] ?? []
    if (busy) return false
  } finally {
    db.close()
  }
  if (!existsSync(path + "-wal") || statSync(path + "-wal").size === 0)
    for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true })
  return true
}

const moved = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

/** Moves `from`'s entries into `to` without overwriting anything already there. */
function mergeDirectory(from: string, to: string) {
  mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (entry === "daemon.pid") rmSync(source, { force: true })
    else if (statSync(source).isDirectory() && existsSync(target)) mergeDirectory(source, target)
    else if (!existsSync(target)) renameSync(source, target)
    else if (entry === "daemon.log") renameSync(source, join(to, "daemon.wake.log"))
  }
  try {
    rmdirSync(from)
  } catch {}
}

/**
 * Migrates pre-rename state: ~/.local/state/wake moves to ~/.local/state/skulk, and wake.db becomes
 * skulk.db. Watches, IDs, slots and logs are kept as they are. Idempotent, and safe to call from every
 * process: while a pre-rename daemon is still running it changes nothing and returns the old location.
 */
export function migrateState(root: string, legacyRoot: string | undefined): { root: string; database: string } {
  const database = join(root, databaseFile)
  const pending = () =>
    !existsSync(database) &&
    ((legacyRoot !== undefined && legacyRoot !== root && existsSync(join(legacyRoot, legacyDatabaseFile))) || existsSync(join(root, legacyDatabaseFile)))
  if (!pending() && !(legacyRoot && legacyRoot !== root && existsSync(legacyRoot))) return { root, database }
  return withMigrationLock(root, () => migrateUnlocked(root, legacyRoot))
}

/** Serializes migrations across processes, so no process writes the old database while another moves it. */
function withMigrationLock<T>(root: string, run: () => T): T {
  const lock = `${root}.migrating`
  mkdirSync(dirname(root), { recursive: true })
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      closeSync(openSync(lock, "wx", 0o600))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true })
      } catch {}
      if (Date.now() > deadline) throw new Error(`state migration is locked by ${lock}; remove it if no skulk process is running`)
      Bun.sleepSync(25)
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { force: true })
  }
}

function migrateUnlocked(root: string, legacyRoot: string | undefined): { root: string; database: string } {
  const database = join(root, databaseFile)
  if (legacyRoot && legacyRoot !== root && existsSync(legacyRoot)) {
    const legacyDatabase = join(legacyRoot, legacyDatabaseFile)
    if (existsSync(legacyDatabase) && !existsSync(database)) {
      if (daemonPID(legacyRoot) !== undefined) return { root: legacyRoot, database: legacyDatabase }
      if (!checkpoint(legacyDatabase)) return { root: legacyRoot, database: legacyDatabase }
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 })
        renameSync(legacyDatabase, database)
      } catch (error) {
        if (!moved(error) || !existsSync(database)) throw error
      }
    }
    if (!existsSync(legacyDatabase)) {
      try {
        mergeDirectory(legacyRoot, root)
      } catch (error) {
        if (!moved(error)) throw error
      }
    }
  }
  const legacyDatabase = join(root, legacyDatabaseFile)
  if (!existsSync(database) && existsSync(legacyDatabase)) {
    if (daemonPID(root) !== undefined) return { root, database: legacyDatabase }
    if (!checkpoint(legacyDatabase)) return { root, database: legacyDatabase }
    try {
      renameSync(legacyDatabase, database)
    } catch (error) {
      if (!moved(error) || !existsSync(database)) throw error
    }
  }
  return { root, database }
}

export class Store {
  readonly db: Database
  readonly root: string

  constructor(root?: string) {
    const state = migrateState(root ?? stateDirectory(), root === undefined ? legacyStateDirectory() : undefined)
    this.root = ensureStateDirectory(state.root)
    this.db = new Database(state.database, { create: true })
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
    this.db.exec("CREATE TABLE IF NOT EXISTS slots (name TEXT PRIMARY KEY, size INTEGER, last_grant_at INTEGER)")
    this.db.exec(`CREATE TABLE IF NOT EXISTS holds (
      watch_id TEXT PRIMARY KEY,
      slot TEXT NOT NULL,
      session_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`)
    // Version 1 is the schema above; bump it with a migration when the schema changes.
    if (this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version === 0) this.db.exec("PRAGMA user_version = 1")
    chmodSync(state.database, 0o600)
  }

  /** Deletes ended watches (and returns their IDs) that ended before `before`. */
  prune(before: number) {
    return this.db.transaction(() => {
      const ended = this.list(["done", "expired", "failed", "cancelled", "undeliverable"]).filter((watch) => (watch.endedAt ?? watch.firedAt ?? watch.createdAt) < before)
      const remove = this.db.query("DELETE FROM watches WHERE id = ?")
      for (const watch of ended) remove.run(watch.id)
      return ended.map((watch) => watch.id)
    }).immediate()
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
        throw new Error(`too many open watches (${open.length}/${maxOpen}); cancel some with \`skulk cancel\``)
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

  slotSize(slot: string) {
    const row = this.db.query<{ size: number | null }, [string]>("SELECT size FROM slots WHERE name = ?").get(slot)
    return row?.size ?? defaultSlotSize(slot)
  }

  setSlotSize(slot: string, size: number) {
    this.db
      .query("INSERT INTO slots (name, size) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET size = excluded.size")
      .run(slot, size)
  }

  lastGrantAt(slot: string) {
    return this.db.query<{ last_grant_at: number | null }, [string]>("SELECT last_grant_at FROM slots WHERE name = ?").get(slot)?.last_grant_at ?? undefined
  }

  /**
   * Grant `watch` a place in its slot, atomically. Waiters are served first come, first served: only the
   * oldest active waiter for the slot can be granted, and only while the slot has room.
   */
  acquire(watch: Watch, now: number): Grant {
    const slot = watch.slot!
    return this.db.transaction((): Grant => {
      this.db.query("DELETE FROM holds WHERE expires_at <= ?").run(now)
      const size = this.slotSize(slot)
      const held = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM holds WHERE slot = ?").get(slot)!.count
      if (held >= size) return { ok: false, reason: `slot ${slot} full (${held}/${size})` }
      const first = this.open()
        .filter((other) => other.status === "active" && other.slot === slot)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
      if (first && first.id !== watch.id) return { ok: false, reason: `queued behind ${first.name}` }
      this.db
        .query("INSERT OR REPLACE INTO holds (watch_id, slot, session_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(watch.id, slot, watch.sessionID, now, now + (watch.holdMs ?? Limits.defaultHoldMs))
      this.db
        .query("INSERT INTO slots (name, last_grant_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_grant_at = excluded.last_grant_at")
        .run(slot, now)
      return { ok: true, held: held + 1, size }
    }).immediate()
  }

  holds(slot?: string): Hold[] {
    const rows = slot
      ? this.db.query<HoldRow, [string]>("SELECT * FROM holds WHERE slot = ? ORDER BY acquired_at").all(slot)
      : this.db.query<HoldRow, []>("SELECT * FROM holds ORDER BY slot, acquired_at").all()
    return rows.map((row) => ({ watchID: row.watch_id, slot: row.slot, sessionID: row.session_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at }))
  }

  release(watchID: string) {
    return this.db.query("DELETE FROM holds WHERE watch_id = ?").run(watchID).changes === 1
  }

  close() {
    this.db.close()
  }
}

interface HoldRow {
  watch_id: string
  slot: string
  session_id: string
  acquired_at: number
  expires_at: number
}
