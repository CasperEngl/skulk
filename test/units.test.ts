import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"
import { evaluate } from "../src/condition.ts"
import { pollWatch, timerWatch } from "../src/create.ts"
import { Store } from "../src/store.ts"
import { messageID, runCommand } from "../src/system.ts"
import { clip, parseDuration, parseTime, redact } from "../src/text.ts"
import { Limits } from "../src/watch.ts"
import { ok, SESSION, tempRoot } from "./helpers.ts"

describe("evaluate", () => {
  test("changes", () => {
    expect(evaluate({ type: "changes", from: "A" }, ok(" A\n"), undefined)).toEqual({ type: "pending", value: "A" })
    expect(evaluate({ type: "changes", from: "A" }, ok("B"), undefined)).toEqual({ type: "met", value: "B", from: "A" })
    expect(evaluate({ type: "changes" }, ok("A"), undefined)).toEqual({ type: "pending", value: "A", baseline: "A" })
    expect(evaluate({ type: "changes" }, ok("B"), "A")).toEqual({ type: "met", value: "B", from: "A" })
  })

  test("equals and matches", () => {
    expect(evaluate({ type: "equals", value: "done" }, ok("done\n"), undefined).type).toBe("met")
    expect(evaluate({ type: "equals", value: "done" }, ok("Done"), undefined).type).toBe("pending")
    expect(evaluate({ type: "matches", pattern: "APPROVED|REJECTED" }, ok("status: REJECTED"), undefined).type).toBe("met")
    expect(evaluate({ type: "matches", pattern: "^APPROVED$" }, ok("NOT APPROVED"), undefined).type).toBe("pending")
  })

  test("broken reads are errors for value conditions, but only 'not yet' for succeeds", () => {
    const failed = { exitCode: 2, stdout: "", stderr: "warn\nfatal: auth required\n", timedOut: false }
    expect(evaluate({ type: "changes", from: "A" }, failed, undefined)).toMatchObject({ type: "error", error: "exit 2: fatal: auth required" })
    expect(evaluate({ type: "changes", from: "A" }, ok("  \n"), undefined)).toMatchObject({ type: "error", error: "empty output" })
    expect(evaluate({ type: "succeeds" }, failed, undefined).type).toBe("pending")
    expect(evaluate({ type: "succeeds" }, ok(""), undefined).type).toBe("met")
    expect(evaluate({ type: "succeeds" }, { ...failed, timedOut: true }, undefined).type).toBe("error")
    expect(evaluate({ type: "equals", value: "x" }, { ...ok(""), exitCode: null, error: "ENOENT" }, undefined).type).toBe("error")
  })
})

describe("guardrails", () => {
  const base = { id: "wk_1", sessionID: SESSION, instruction: "do it", now: 1_000_000 }
  const pollInput = { ...base, command: ["true"], condition: { type: "succeeds" } as const, intervalMs: 60_000 }

  test("interval floor, deadline default and maximum, timeout and failure bounds", () => {
    expect(() => pollWatch({ ...pollInput, intervalMs: 59_000 })).toThrow("at least 60s")
    expect(pollWatch(pollInput).deadlineAt).toBe(base.now + 48 * 3600_000)
    expect(() => pollWatch({ ...pollInput, deadlineMs: 15 * 24 * 3600_000 })).toThrow("14d")
    expect(() => pollWatch({ ...pollInput, timeoutMs: 11 * 60_000 })).toThrow("10m")
    expect(() => pollWatch({ ...pollInput, maxFailures: 0 })).toThrow("--failures")
    expect(() => pollWatch({ ...pollInput, condition: { type: "matches", pattern: "(" } })).toThrow()
    expect(() => pollWatch({ ...pollInput, sessionID: "HOME" })).toThrow("session ID")
    expect(() => pollWatch({ ...pollInput, instruction: " " })).toThrow("--do")
    expect(pollWatch({ ...pollInput, intervalMs: 600_000 }).timeoutMs).toBe(120_000)
  })

  test("timers must be in the future and within 14 days", () => {
    expect(() => timerWatch({ ...base, at: base.now - 1 })).toThrow("past")
    expect(() => timerWatch({ ...base, at: base.now + 15 * 24 * 3600_000 })).toThrow("14 days")
    expect(timerWatch({ ...base, at: base.now + 1000 }).dueAt).toBe(base.now + 1000)
  })

  test("open-watch cap and unique open names", () => {
    const store = new Store(tempRoot())
    for (let i = 0; i < Limits.maxActive; i++)
      store.insertChecked(timerWatch({ ...base, id: `wk_${i}`, name: `t${i}`, at: base.now + 1000 }), Limits.maxActive)
    expect(() => store.insertChecked(timerWatch({ ...base, id: "wk_x", name: "x", at: base.now + 1000 }), Limits.maxActive)).toThrow("too many")
    const first = store.get("wk_0")!
    store.update({ ...first, status: "cancelled" }, "active")
    expect(() => store.insertChecked(timerWatch({ ...base, id: "wk_y", name: "t1", at: base.now + 1000 }), Limits.maxActive)).toThrow("already named")
    store.insertChecked(timerWatch({ ...base, id: "wk_z", name: "t0", at: base.now + 1000 }), Limits.maxActive)
    expect(store.find("t0")!.id).toBe("wk_z")
  })

  test("state is private", () => {
    const root = tempRoot()
    new Store(root)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, "wake.db")).mode & 0o777).toBe(0o600)
  })
})

describe("text", () => {
  test("durations and times", () => {
    expect(parseDuration("90s")).toBe(90_000)
    expect(parseDuration("2h30m")).toBe(9_000_000)
    expect(parseDuration("1d")).toBe(86_400_000)
    expect(parseDuration("120")).toBe(120_000)
    expect(() => parseDuration("soon")).toThrow()
    expect(() => parseDuration("5mx")).toThrow()
    const now = new Date(2026, 9, 9, 16, 0).getTime()
    expect(parseTime("17:30", now)).toBe(new Date(2026, 9, 9, 17, 30).getTime())
    expect(parseTime("3pm", now)).toBe(new Date(2026, 9, 10, 15, 0).getTime())
    expect(parseTime("tomorrow 9:00", now)).toBe(new Date(2026, 9, 10, 9, 0).getTime())
    expect(parseTime("2026-10-12 08:15", now)).toBe(new Date(2026, 9, 12, 8, 15).getTime())
    expect(() => parseTime("whenever", now)).toThrow()
  })

  test("redaction and clipping", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop")
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]")
    expect(redact('{"api_key": "abc123secret"}')).toBe('{"api_key": "[redacted]"}')
    expect(redact("(token=abc123secret) ok")).toBe("(token=[redacted]) ok")
    expect(redact("status APPROVED")).toBe("status APPROVED")
    expect(clip("a\nb", 10)).toBe("a ⏎ b")
    expect(clip("x".repeat(20), 5)).toBe("xxxxx… [15 more chars]")
  })

  test("message IDs sort by time like OpenCode's", () => {
    expect(messageID(1000)).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(messageID(1000) < messageID(2000)).toBe(true)
  })
})

describe("runCommand", () => {
  test("captures output and exit code", async () => {
    const result = await runCommand(["/bin/sh", "-c", "echo hi; echo err >&2; exit 3"], { timeoutMs: 5000 })
    expect(result).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "err\n", timedOut: false })
  })

  test("a timeout kills the whole pipeline", async () => {
    const started = Date.now()
    const result = await runCommand(["/bin/sh", "-c", "sleep 30 | cat; echo never"], { timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toBe("")
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("a missing program is an error, not a crash", async () => {
    const result = await runCommand(["/nonexistent/program"], { timeoutMs: 1000 })
    expect(result.error ?? result.exitCode).toBeTruthy()
  })
})
