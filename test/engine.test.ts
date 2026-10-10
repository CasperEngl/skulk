import { describe, expect, test } from "bun:test"
import { pollWatch, timerWatch } from "../src/create.ts"
import { Limits } from "../src/watch.ts"
import { Harness, ok, SESSION } from "./helpers.ts"

const minute = 60_000
const hour = 60 * minute

function timer(h: Harness, inMs: number, name = "standup") {
  const watch = timerWatch({ id: `wk_${name}`, name, sessionID: SESSION, instruction: "Post the standup notes.", now: h.now, at: h.now + inMs })
  h.store.insert(watch)
  return watch
}

function poll(h: Harness, options: Partial<Parameters<typeof pollWatch>[0]> = {}) {
  const watch = pollWatch({
    id: "wk_ramp",
    name: "ramp-mac",
    sessionID: SESSION,
    instruction: "Finish the CyberLynk checkout if approved.",
    now: h.now,
    command: ["/bin/sh", "-c", "ramp requests get 01a1 | jq -r .status"],
    condition: { type: "changes", from: "SUBMITTED" },
    intervalMs: 5 * minute,
    ...options,
  })
  h.store.insert(watch)
  return watch
}

describe("timers", () => {
  test("fire once at the due time with the instruction and how to inspect", async () => {
    const h = new Harness()
    const watch = timer(h, 30 * minute)
    h.advance(29 * minute)
    await h.tick()
    expect(h.server.messages.size).toBe(0)
    h.advance(minute)
    await h.tick()
    await h.tick()
    h.advance(hour)
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    const [message] = h.server.messages.values()
    expect(message!.sessionID).toBe(SESSION)
    expect(message!.text).toContain("standup")
    expect(message!.text).toContain("Next: Post the standup notes.")
    expect(message!.text).toContain(`wake logs ${watch.id}`)
    expect(message!.metadata).toEqual({ source: "wake", watchID: watch.id, outcome: "timer" })
    expect(h.get(watch.id).status).toBe("done")
  })

  test("a timer missed while the Mac was off coalesces into one late wake", async () => {
    const h = new Harness()
    timer(h, 10 * minute)
    h.advance(3 * 24 * hour)
    await Promise.all([h.tick(), h.tick(), h.tick()])
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("late")
  })
})

describe("polls", () => {
  test("wake once when the value changes from the expected one, reporting old → new", async () => {
    const h = new Harness()
    const watch = poll(h)
    h.results = [ok("SUBMITTED\n"), ok("SUBMITTED"), ok("APPROVED\n")]
    await h.tick()
    for (let i = 0; i < 3; i++) {
      h.advance(5 * minute)
      await h.tick()
    }
    expect(h.runs.length).toBe(3)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("Changed: SUBMITTED → APPROVED")
    expect(h.server.texts[0]).toContain("Next: Finish the CyberLynk checkout if approved.")
    h.advance(hour)
    await h.tick()
    expect(h.runs.length).toBe(3)
    expect(h.get(watch.id)).toMatchObject({ status: "done", outcome: "met", lastValue: "APPROVED", checks: 3 })
  })

  test("changes without --from compares against the first reading", async () => {
    const h = new Harness()
    poll(h, { condition: { type: "changes" } })
    h.results = [ok("in transit"), ok("in transit"), ok("delivered")]
    for (let i = 0; i < 3; i++) {
      await h.tick()
      h.advance(5 * minute)
    }
    expect(h.server.texts[0]).toContain("Changed: in transit → delivered")
  })

  test("equals, matches and succeeds", async () => {
    for (const [condition, results, expected] of [
      [{ type: "equals", value: "success" }, [ok("pending"), ok("success")], "pending → success"],
      [{ type: "matches", pattern: "^(completed|failure)$" }, [ok("queued"), ok("completed")], "queued → completed"],
      [{ type: "succeeds" }, [ok("", 1), ok("ready")], "now exits 0"],
    ] as const) {
      const h = new Harness()
      poll(h, { condition })
      h.results = [...results]
      await h.tick()
      expect(h.server.messages.size).toBe(0)
      h.advance(5 * minute)
      await h.tick()
      expect(h.server.texts[0]).toContain(expected)
    }
  })

  test("checks no more often than the interval, and coalesce after a long sleep", async () => {
    const h = new Harness()
    poll(h, { intervalMs: Limits.minIntervalMs })
    h.results = Array.from({ length: 10 }, () => ok("SUBMITTED"))
    await h.tick()
    h.advance(30_000)
    await h.tick()
    expect(h.runs.length).toBe(1)
    h.advance(30_000)
    await h.tick()
    expect(h.runs.length).toBe(2)
    h.advance(8 * hour)
    await h.tick()
    await h.tick()
    expect(h.runs.length).toBe(3)
  })

  test("the deadline wakes the session once with the last value and stops checking", async () => {
    const h = new Harness()
    const watch = poll(h, { deadlineMs: hour })
    h.results = Array.from({ length: 20 }, () => ok("SUBMITTED"))
    for (let elapsed = 0; elapsed <= 2 * hour; elapsed += 5 * minute) {
      await h.tick()
      h.advance(5 * minute)
    }
    expect(h.runs.length).toBe(12)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("deadline reached")
    expect(h.server.texts[0]).toContain("Last value: SUBMITTED")
    expect(h.get(watch.id).status).toBe("expired")
  })

  test("N consecutive failures wake the session with the error; a success resets the count", async () => {
    const h = new Harness()
    const watch = poll(h, { maxFailures: 3 })
    const failure = { exitCode: 1, stdout: "", stderr: "error: not logged in\n", timedOut: false }
    h.results = [failure, failure, ok("SUBMITTED"), failure, failure, ok(""), ok("never read")]
    for (let i = 0; i < 7; i++) {
      await h.tick()
      h.advance(5 * minute)
    }
    expect(h.runs.length).toBe(6)
    expect(h.server.messages.size).toBe(1)
    expect(h.server.texts[0]).toContain("3 consecutive failed checks")
    expect(h.server.texts[0]).toContain("empty output")
    expect(h.get(watch.id).status).toBe("failed")
  })

  test("a timed-out check counts as a failure, never as a change", async () => {
    const h = new Harness()
    poll(h, { maxFailures: 1 })
    h.results = [{ exitCode: null, stdout: "partial", stderr: "", timedOut: true }]
    await h.tick()
    expect(h.server.texts[0]).toContain("timed out")
  })

  test("cancelling during a running check discards its result", async () => {
    const h = new Harness()
    const watch = poll(h)
    h.results = [ok("APPROVED")]
    const tick = h.tick()
    h.store.update({ ...h.get(watch.id), status: "cancelled" }, "active")
    await tick
    expect(h.server.messages.size).toBe(0)
    expect(h.get(watch.id).status).toBe("cancelled")
  })

  test("wake text is truncated and redacted", async () => {
    const h = new Harness()
    poll(h, { condition: { type: "changes" } })
    h.results = [ok("x"), ok(`token=supersecretvalue123 ${"y".repeat(5000)}`)]
    await h.tick()
    h.advance(5 * minute)
    await h.tick()
    const text = h.server.texts[0]!
    expect(text).not.toContain("supersecretvalue123")
    expect(text).toContain("token=[redacted]")
    expect(text.length).toBeLessThan(2000)
  })
})

describe("restarts and delivery", () => {
  test("a pending watch survives a restart and fires once", async () => {
    const h = new Harness()
    const watch = poll(h)
    h.results = [ok("SUBMITTED")]
    await h.tick()
    h.restart()
    h.advance(5 * minute)
    h.results = [ok("APPROVED")]
    await h.tick()
    h.restart()
    await h.tick()
    expect(h.server.messages.size).toBe(1)
    expect(h.get(watch.id).status).toBe("done")
  })

  test("a crash after OpenCode admitted the wake does not duplicate it after restart", async () => {
    const h = new Harness()
    const watch = timer(h, minute)
    h.advance(minute)
    h.server.script = ["crash"]
    await h.tick()
    expect(h.get(watch.id).status).toBe("firing")
    h.restart()
    await h.tick()
    expect(h.server.attempts.length).toBe(2)
    expect(h.server.attempts[0]!.messageID).toBe(h.server.attempts[1]!.messageID)
    expect(h.server.messages.size).toBe(1)
    expect(h.get(watch.id).status).toBe("done")
    h.restart()
    h.advance(hour)
    await h.tick()
    expect(h.server.attempts.length).toBe(2)
  })

  test("delivery retries with backoff and the same message ID while OpenCode is down", async () => {
    const h = new Harness()
    const watch = timer(h, minute)
    h.advance(minute)
    h.server.script = ["down", "down", "ok"]
    await h.tick()
    await h.tick()
    expect(h.server.attempts.length).toBe(1)
    h.advance(15_000)
    await h.tick()
    h.advance(30_000)
    await h.tick()
    expect(h.server.attempts.length).toBe(3)
    expect(new Set(h.server.attempts.map((attempt) => attempt.messageID)).size).toBe(1)
    expect(h.get(watch.id)).toMatchObject({ status: "done", deliveryAttempts: 3 })
  })

  test("a deleted target session ends the watch as undeliverable", async () => {
    const h = new Harness()
    const watch = timer(h, minute)
    h.advance(minute)
    h.server.script = ["missing"]
    await h.tick()
    h.advance(hour)
    await h.tick()
    expect(h.server.attempts.length).toBe(1)
    expect(h.get(watch.id).status).toBe("undeliverable")
  })

  test("nextWakeAt tracks the earliest due watch", () => {
    const h = new Harness()
    expect(h.engine.nextWakeAt()).toBeUndefined()
    timer(h, 2 * hour, "late")
    timer(h, hour, "early")
    expect(h.engine.nextWakeAt()).toBe(h.now + hour)
  })
})
