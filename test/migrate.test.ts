import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { timerWatch } from "../src/create.ts"
import { Store } from "../src/store.ts"
import { SESSION } from "./helpers.ts"

const cli = join(import.meta.dir, "..", "src", "cli.ts")
const now = Date.now()
const hour = 3600_000
const home = process.env.HOME!

/** Writes a pre-rename database (wake.db) whose newest rows are still only in its WAL. */
function legacyState(dir: string, ids = ["wk_aaaaaaaa", "wk_bbbbbbbb"]) {
  const scratch = mkdtempSync(join(tmpdir(), "skulk-scratch-"))
  const store = new Store(scratch)
  store.db.exec("PRAGMA wal_autocheckpoint = 0")
  ids.forEach((id, index) => store.insert(timerWatch({ id, name: `t${index}`, sessionID: SESSION, instruction: "go", now, at: now + (index + 1) * hour })))
  store.setSlotSize("heavy", 3)
  mkdirSync(join(dir, "logs"), { recursive: true })
  copyFileSync(join(scratch, "skulk.db"), join(dir, "wake.db"))
  copyFileSync(join(scratch, "skulk.db-wal"), join(dir, "wake.db-wal"))
  store.db.close()
  for (const id of ids) writeFileSync(join(dir, "logs", `${id}.log`), `created ${id}\n`)
  writeFileSync(join(dir, "daemon.log"), "old daemon log\n")
  writeFileSync(join(dir, "daemon.pid"), "999999")
  return ids
}

const dueTimes = (store: Store) => Object.fromEntries(store.open().map((watch) => [watch.id, watch.dueAt]))

const legacyRoot = join(home, ".local/state/wake")
const newRoot = join(home, ".local/state/skulk")

afterEach(() => {
  delete process.env.SKULK_HOME
  delete process.env.WAKE_HOME
  Bun.spawnSync(["rm", "-rf", legacyRoot, newRoot])
})

describe("state migration from wake", () => {
  test("moves ~/.local/state/wake to ~/.local/state/skulk with every watch, slot and log", () => {
    const ids = legacyState(legacyRoot)
    const store = new Store()
    expect(store.root).toBe(newRoot)
    expect(store.db.filename).toBe(join(newRoot, "skulk.db"))
    expect(dueTimes(store)).toEqual({ [ids[0]!]: now + hour, [ids[1]!]: now + 2 * hour })
    expect(store.slotSize("heavy")).toBe(3)
    expect(readFileSync(join(newRoot, "logs", `${ids[0]}.log`), "utf8")).toContain("created")
    expect(readFileSync(join(newRoot, "daemon.log"), "utf8")).toContain("old daemon log")
    expect(existsSync(legacyRoot)).toBe(false)
    expect(existsSync(join(newRoot, "daemon.pid"))).toBe(false)
    store.db.close()
  })

  test("is idempotent and keeps watches created after the move", () => {
    legacyState(legacyRoot)
    const first = new Store()
    first.insert(timerWatch({ id: "wk_cccccccc", name: "after", sessionID: SESSION, instruction: "go", now, at: now + 3 * hour }))
    first.db.close()
    const second = new Store()
    expect(second.open().map((watch) => watch.id).sort()).toEqual(["wk_aaaaaaaa", "wk_bbbbbbbb", "wk_cccccccc"])
    second.db.close()
  })

  test("leaves state alone while a pre-rename daemon is still running", async () => {
    legacyState(legacyRoot)
    const daemon = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "daemon"], { stdout: "ignore", stderr: "ignore" })
    try {
      writeFileSync(join(legacyRoot, "daemon.pid"), String(daemon.pid))
      await Bun.sleep(100)
      const store = new Store()
      expect(store.root).toBe(legacyRoot)
      expect(store.db.filename).toBe(join(legacyRoot, "wake.db"))
      expect(store.open().length).toBe(2)
      expect(existsSync(join(newRoot, "skulk.db"))).toBe(false)
      store.db.close()
    } finally {
      daemon.kill()
      await daemon.exited
    }
    const after = new Store()
    expect(after.root).toBe(newRoot)
    expect(after.open().length).toBe(2)
    after.db.close()
  })

  test("never overwrites an existing skulk.db", () => {
    legacyState(legacyRoot, ["wk_oldoldol"])
    const fresh = new Store(newRoot)
    fresh.insert(timerWatch({ id: "wk_newnewne", name: "new", sessionID: SESSION, instruction: "go", now, at: now + hour }))
    fresh.db.close()
    const store = new Store()
    expect(store.open().map((watch) => watch.id)).toEqual(["wk_newnewne"])
    expect(existsSync(join(legacyRoot, "wake.db"))).toBe(true)
    store.db.close()
  })

  test("renames wake.db inside an explicit $SKULK_HOME or $WAKE_HOME", () => {
    for (const variable of ["SKULK_HOME", "WAKE_HOME"]) {
      const dir = mkdtempSync(join(tmpdir(), "skulk-explicit-"))
      legacyState(dir)
      process.env[variable] = dir
      const store = new Store()
      expect(store.db.filename).toBe(join(dir, "skulk.db"))
      expect(store.open().length).toBe(2)
      expect(existsSync(join(dir, "wake.db"))).toBe(false)
      store.db.close()
      delete process.env[variable]
    }
  })

  test("the CLI reads migrated state, and package.json exposes skulk with a wake alias", () => {
    legacyState(legacyRoot)
    const env = { ...process.env, HOME: home }
    const listed = Bun.spawnSync([process.execPath, cli, "list", "--json"], { env })
    expect(listed.exitCode).toBe(0)
    expect((JSON.parse(listed.stdout.toString()) as { id: string }[]).map((watch) => watch.id).sort()).toEqual(["wk_aaaaaaaa", "wk_bbbbbbbb"])
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { name: string; bin: Record<string, string> }
    expect(pkg.name).toBe("@kitlangton/skulk")
    expect(pkg.bin).toEqual({ skulk: "src/cli.ts", wake: "src/cli.ts" })
  })
})
