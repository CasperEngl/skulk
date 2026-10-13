import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RunResult } from "../src/condition.ts"
import { exitsWatch, pollWatch, timerWatch } from "../src/create.ts"
import { processAlive } from "../src/engine.ts"
import { runCommand } from "../src/system.ts"
import { Harness, ok, SESSION, tempRoot } from "./helpers.ts"

const minute = 60_000

/** Waits until aborted, like a blocking `gh run watch` that is stopped. */
const blockUntilAborted = (_watch: unknown, signal?: AbortSignal) =>
  new Promise<RunResult>((resolve) => {
    signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false }), { once: true })
  })

async function waitFor(predicate: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (predicate()) return true
    await Bun.sleep(25)
  }
  return predicate()
}

function exits(h: Harness, name: string) {
  const watch = exitsWatch({ id: `wk_${name}`, name, sessionID: SESSION, instruction: "Inspect.", now: h.now, command: ["gh", "run", "watch", "1"] })
  h.store.insert(watch)
  return watch
}

describe("runCommand abort", () => {
  test("stops the whole process group", async () => {
    const root = tempRoot()
    const pidFile = join(root, "child.pid")
    const controller = new AbortController()
    const running = runCommand(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 60_000, signal: controller.signal })
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true)
    const grandchild = Number(readFileSync(pidFile, "utf8"))
    controller.abort()
    await running
    expect(await waitFor(() => !processAlive(grandchild))).toBe(true)
  })

  test("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    const root = tempRoot()
    const pidFile = join(root, "child.pid")
    const controller = new AbortController()
    const started = Date.now()
    const running = runCommand(["/bin/sh", "-c", `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 60_000, signal: controller.signal, killGraceMs: 300 })
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true)
    const grandchild = Number(readFileSync(pidFile, "utf8"))
    controller.abort()
    await running
    expect(await waitFor(() => !processAlive(grandchild))).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe("cancelling running commands", () => {
  test("wake cancel stops a running exits command on the next tick and sends no wake", async () => {
    const h = new Harness()
    let aborted = false
    h.runner = (watch, signal) => {
      signal?.addEventListener("abort", () => (aborted = true))
      return blockUntilAborted(watch, signal)
    }
    const watch = exits(h, "blocking")
    const first = h.tick()
    h.store.update({ ...h.get(watch.id), status: "cancelled" }, "active")
    await h.tick()
    await first
    expect(aborted).toBe(true)
    expect(h.server.attempts.length).toBe(0)
    expect(h.get(watch.id).status).toBe("cancelled")
  })

  test("stopping the engine stops commands and leaves their watches to re-run after a restart", async () => {
    const h = new Harness()
    h.runner = blockUntilAborted
    const watch = exits(h, "survivor")
    const first = h.tick()
    await h.engine.stop(1000)
    await first
    expect(h.server.attempts.length).toBe(0)
    expect(h.get(watch.id)).toMatchObject({ status: "active", checks: 0 })
    h.restart()
    h.runner = undefined
    h.results = [ok("done\n")]
    await h.tick()
    expect(h.server.texts[0]).toContain("The command exited with code 0.")
  })
})

describe("concurrency", () => {
  test("blocking exits commands do not count against the check limit, so timers and polls still run", async () => {
    const h = new Harness()
    Object.assign(h.options, { maxConcurrent: 2 })
    h.engine = h.makeEngine()
    h.runner = async (watch, signal) => (watch.condition?.type === "exits" ? blockUntilAborted(watch, signal) : ok("PENDING"))
    for (const name of ["a", "b", "c", "d"]) exits(h, name)
    const timer = timerWatch({ id: "wk_t", name: "t", sessionID: SESSION, instruction: "Ping.", now: h.now, at: h.now + minute })
    const poll = pollWatch({ id: "wk_p", name: "p", sessionID: SESSION, instruction: "Go.", now: h.now, command: ["true"], condition: { type: "equals", value: "DONE" }, intervalMs: minute })
    h.store.insert(timer)
    h.store.insert(poll)
    void h.tick()
    h.advance(minute)
    await h.tick()
    expect(h.get(timer.id).status).toBe("done")
    expect(h.get(poll.id).checks).toBeGreaterThanOrEqual(1)
    expect(h.runs.filter((watch) => watch.condition?.type === "exits").length).toBe(4)
    await h.engine.stop(1000)
  })
})

describe("SKULK_ALLOW_EXEC=0", () => {
  test("command watches fail with a clear error instead of running", async () => {
    const h = new Harness()
    Object.assign(h.options, { allowExec: false })
    h.engine = h.makeEngine()
    const watch = exits(h, "nope")
    await h.tick()
    expect(h.runs.length).toBe(0)
    expect(h.get(watch.id).status).toBe("failed")
    expect(h.server.texts[0]).toContain("SKULK_ALLOW_EXEC=0")
  })
})
