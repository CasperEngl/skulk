import { describe, expect, test } from "bun:test"
import { parseCapacity } from "../src/builtin.ts"
import { whenWatch } from "../src/create.ts"
import type { Builtin } from "../src/watch.ts"
import { capacityLine, Harness, SESSION } from "./helpers.ts"

const minute = 60_000
const capacity = (stableMs = 3 * minute): Builtin => ({ type: "capacity", cpu: 70, builds: 1, diskGB: 20, stableMs })

function when(h: Harness, name: string, condition: Builtin, options: { slot?: string; holdMs?: number; sessionID?: string } = {}) {
  const watch = whenWatch({ id: `wk_${name}`, name, sessionID: options.sessionID ?? SESSION, instruction: `Run ${name}.`, now: h.now, condition, slot: options.slot, holdMs: options.holdMs })
  h.store.insert(watch)
  h.advance(1) // distinct creation order
  return watch
}

/** Advance a minute and run every due check. */
async function step(h: Harness, minutes = 1) {
  for (let index = 0; index < minutes; index++) {
    h.advance(minute)
    await h.tick()
  }
}

describe("capacity summary", () => {
  test("parses mac-sim-lease --status", () => {
    expect(parseCapacity(capacityLine(62, 1, 45))).toEqual({ cpu: 62, builds: 1, diskGB: 45 })
  })

  test("a missing CPU sample is unknown, and other text is unreadable", () => {
    expect(parseCapacity(capacityLine("", 0, 45))).toEqual({ cpu: undefined, builds: 0, diskGB: 45 })
    expect(parseCapacity("hello")).toBeUndefined()
  })
})

describe("wake when capacity", () => {
  test("fires only after capacity holds steadily, and a spike restarts the window", async () => {
    const h = new Harness()
    const watch = when(h, "proofs", capacity())
    h.capacity = capacityLine(90, 0, 60)
    await step(h)
    h.capacity = capacityLine(60, 0, 60)
    await step(h, 2)
    h.capacity = capacityLine(85, 0, 60)
    await step(h)
    expect(h.get(watch.id).heldSince).toBeUndefined()
    h.capacity = capacityLine(60, 0, 60)
    await step(h, 3)
    expect(h.server.messages.size).toBe(0)
    await step(h)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("Condition: until the Mac has capacity")
    expect(h.server.texts[0]).toContain("cpu 60% · 0 xcodebuild · 60 GB free")
  })

  test("builds and disk count as well as CPU", async () => {
    const h = new Harness()
    when(h, "proofs", capacity(0))
    h.capacity = capacityLine(10, 2, 60)
    await step(h)
    h.capacity = capacityLine(10, 0, 12)
    await step(h)
    expect(h.server.messages.size).toBe(0)
    h.capacity = capacityLine(10, 1, 60)
    await step(h)
    expect(h.server.messages.size).toBe(1)
  })

  test("an unreadable probe is a failed check, not capacity", async () => {
    const h = new Harness()
    const watch = when(h, "proofs", capacity(0))
    h.capacity = "mac-sim-lease: command not found"
    await step(h)
    expect(h.get(watch.id).consecutiveFailures).toBe(1)
    expect(h.server.messages.size).toBe(0)
  })
})

describe("slots", () => {
  test("waiters are granted in order, one place at a time", async () => {
    const h = new Harness()
    h.store.setSlotSize("heavy", 1)
    const first = when(h, "perf", capacity(0), { slot: "heavy" })
    const second = when(h, "arch", capacity(0), { slot: "heavy" })
    await step(h)
    expect([...h.server.messages.values()].map((message) => message.metadata.watchID)).toEqual([first.id])
    expect(h.server.texts[0]).toContain(`wake release ${first.id}`)
    expect(h.get(second.id).lastValue).toContain("slot heavy full (1/1)")
    h.store.release(first.id)
    await step(h)
    expect(h.server.messages.size).toBe(2)
  })

  test("a newer waiter cannot jump the queue", async () => {
    const h = new Harness()
    const older = when(h, "older", { type: "idle", sessions: ["ses_busyOne"], stableMs: 0 }, { slot: "solo" })
    const newer = when(h, "newer", capacity(0), { slot: "solo" })
    await step(h)
    expect(h.server.messages.size).toBe(0)
    expect(h.get(newer.id).lastValue).toContain(`queued behind ${older.name}`)
  })

  test("each grant restarts the other waiters' steady window", async () => {
    const h = new Harness()
    const first = when(h, "first", capacity(3 * minute), { slot: "heavy" })
    const second = when(h, "second", capacity(3 * minute), { slot: "heavy" })
    await step(h, 4)
    const granted = (id: string) => [...h.server.messages.values()].some((message) => message.metadata.watchID === id)
    expect(granted(first.id)).toBe(true)
    expect(granted(second.id)).toBe(false)
    await step(h, 2)
    expect(granted(second.id)).toBe(false)
    await step(h, 2)
    expect(granted(second.id)).toBe(true)
  })

  test("a hold ends when the woken session goes idle after its grace period, or expires", async () => {
    const h = new Harness()
    h.store.setSlotSize("heavy", 1)
    const idleSession = "ses_worker1"
    const first = when(h, "first", capacity(0), { slot: "heavy", sessionID: idleSession })
    await step(h)
    expect(h.store.holds("heavy").map((hold) => hold.watchID)).toEqual([first.id])
    h.sessions.set(idleSession, "idle")
    await step(h)
    expect(h.store.holds("heavy")).toHaveLength(1) // still within the grace period
    await step(h, 2)
    expect(h.store.holds("heavy")).toHaveLength(0)

    const second = when(h, "second", capacity(0), { slot: "heavy", holdMs: 10 * minute })
    await step(h)
    expect(h.store.holds("heavy").map((hold) => hold.watchID)).toEqual([second.id])
    await step(h, 11)
    expect(h.store.holds("heavy")).toHaveLength(0)
  })
})

describe("wake when idle and done", () => {
  test("idle waits for every session to stay idle", async () => {
    const h = new Harness()
    when(h, "push", { type: "idle", sessions: ["ses_perf", "ses_arch"], stableMs: 2 * minute })
    h.sessions.set("ses_perf", "idle")
    await step(h, 3)
    expect(h.server.messages.size).toBe(0)
    h.sessions.set("ses_arch", "idle")
    await step(h, 2)
    expect(h.server.messages.size).toBe(0)
    await step(h)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("ses_perf idle · ses_arch idle")
  })

  test("a missing session is a failed check", async () => {
    const h = new Harness()
    const watch = when(h, "push", { type: "idle", sessions: ["ses_gone"], stableMs: 0 })
    h.sessions.set("ses_gone", "missing")
    await step(h)
    expect(h.get(watch.id).lastError).toContain("not found")
  })

  test("done fires once every named watch has ended", async () => {
    const h = new Harness()
    const a = when(h, "a", capacity(0))
    const b = when(h, "b", { type: "idle", sessions: ["ses_never"], stableMs: 0 })
    const after = when(h, "after", { type: "done", watches: [a.id, b.id] })
    h.capacity = capacityLine(95, 0, 60)
    await step(h)
    h.store.update({ ...h.get(b.id), status: "cancelled" }, "active")
    h.capacity = capacityLine(10, 0, 60)
    await step(h)
    await step(h)
    const fired = [...h.server.messages.values()].map((message) => message.metadata.watchID)
    expect(fired).toContain(a.id)
    expect(fired).toContain(after.id)
  })
})

describe("validation", () => {
  test("rejects bad slots, holds and sessions", () => {
    const base = { id: "wk_x", sessionID: SESSION, instruction: "x", now: 0 }
    expect(() => whenWatch({ ...base, condition: capacity(), slot: "bad slot" })).toThrow("--slot")
    expect(() => whenWatch({ ...base, condition: capacity(), holdMs: minute })).toThrow("--hold goes with --slot")
    expect(() => whenWatch({ ...base, condition: capacity(), slot: "heavy", holdMs: 13 * 3600_000 })).toThrow("--hold")
    expect(() => whenWatch({ ...base, condition: { type: "idle", sessions: ["nope"], stableMs: 0 } })).toThrow("not a session ID")
  })
})
