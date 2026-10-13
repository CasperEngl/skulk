import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { timerWatch, whenWatch } from "../src/create.ts"
import { Limits, type Builtin } from "../src/watch.ts"
import { capacityLine, Harness, SESSION, tempRoot } from "./helpers.ts"

const minute = 60_000
const capacity: Builtin = { type: "capacity", cpu: 70, builds: 1, diskGB: 20, stableMs: 0 }

describe("foreground waits in the engine", () => {
  test("a wait without --do needs no instruction, and an ordinary watch still does", () => {
    const now = Date.now()
    expect(timerWatch({ id: "wk_a", sessionID: SESSION, instruction: "", now, at: now + minute, noDeliver: true })).toMatchObject({ noDeliver: true, instruction: "(foreground wait)" })
    expect(() => timerWatch({ id: "wk_b", sessionID: SESSION, instruction: " ", now, at: now + minute })).toThrow("--do")
  })

  test("resolves in the store without prompting any session", async () => {
    const h = new Harness()
    const watch = timerWatch({ id: "wk_fg", name: "fg", sessionID: "ses_localwait", instruction: "", now: h.now, at: h.now + minute, noDeliver: true })
    h.store.insert(watch)
    h.advance(minute)
    await h.tick()
    expect(h.server.attempts.length).toBe(0)
    expect(h.get(watch.id)).toMatchObject({ status: "done", outcome: "timer" })
    expect(h.get(watch.id).wakeText).toContain("Wake: fg")
  })

  test("a granted foreground slot is not released when its session looks idle, only by its owner", async () => {
    const h = new Harness()
    h.capacity = capacityLine(10, 0, 60)
    const watch = whenWatch({ id: "wk_run", name: "run", sessionID: SESSION, instruction: "(wake run)", now: h.now, condition: capacity, slot: "heavy", noDeliver: true })
    h.store.insert({ ...watch, ownerPID: 4242 })
    await h.tick()
    expect(h.get(watch.id).status).toBe("done")
    expect(h.store.holds("heavy").map((hold) => hold.watchID)).toEqual([watch.id])
    h.sessions.set(SESSION, "idle")
    h.advance(Limits.holdGraceMs + minute)
    await h.engine.sweepHolds()
    expect(h.store.holds("heavy").length).toBe(1)
    h.deadPIDs.add(4242)
    await h.engine.sweepHolds()
    expect(h.store.holds("heavy").length).toBe(0)
    expect(h.logs.some((line) => line.includes("waiting process 4242 exited"))).toBe(true)
  })

  test("a waiter whose process died is cancelled, so it stops holding its queue place", async () => {
    const h = new Harness()
    h.capacity = capacityLine(95, 0, 60)
    const watch = whenWatch({ id: "wk_gone", name: "gone", sessionID: SESSION, instruction: "", now: h.now, condition: capacity, slot: "heavy", noDeliver: true })
    h.store.insert({ ...watch, ownerPID: 777 })
    await h.tick()
    expect(h.get(watch.id).status).toBe("active")
    h.deadPIDs.add(777)
    h.advance(minute)
    await h.tick()
    expect(h.get(watch.id).status).toBe("cancelled")
    expect(h.store.holds().length).toBe(0)
  })
})

/** `opencode api` stand-in: sessions exist, prompts are appended to $FAKE_LOG. */
const fakeOpencode = `#!/usr/bin/env bash
if [ "$2" = "get" ]; then echo '{"data":{"title":"Scratch"}}'; exit 0; fi
printf '%s\\n' "$5" >> "$FAKE_LOG"
`

function setup() {
  const root = tempRoot()
  const fake = join(root, "fake-opencode")
  writeFileSync(fake, fakeOpencode)
  chmodSync(fake, 0o700)
  const posts = join(root, "posts.jsonl")
  const env: Record<string, string | undefined> = {
    ...process.env,
    WAKE_HOME: root,
    WAKE_OPENCODE: fake,
    FAKE_LOG: posts,
    WAKE_CAPACITY_COMMAND: `echo '{"cpu": 10, "builds": 0, "diskGB": 500}'`,
    OPENCODE_SESSION_ID: undefined,
  }
  const cli = join(import.meta.dir, "..", "src", "cli.ts")
  const daemon = Bun.spawn([process.execPath, cli, "daemon"], { env, stdout: "ignore", stderr: "ignore" })
  const wake = (...args: string[]) => Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const done = async (child: ReturnType<typeof wake>) => ({
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  })
  return { root, posts, daemon, wake, done }
}

describe("foreground waits from the CLI, against a real daemon", () => {
  test("--wait blocks until the timer fires and prints the result; wake wait follows an existing watch", async () => {
    const { posts, daemon, wake, done } = setup()
    try {
      await Bun.sleep(300)
      const waiting = await done(wake("in", "2s", "--wait", "--name", "fg-timer"))
      expect(waiting.code).toBe(0)
      expect(waiting.stdout).toContain("Wake: fg-timer")

      const later = await done(wake("in", "2s", "--wait", "--name", "fg-other", "--json"))
      expect(JSON.parse(later.stdout)).toMatchObject({ status: "done", noDeliver: true })
      const followed = await done(wake("wait", "fg-other"))
      expect(followed.code).toBe(0)
      expect(existsSync(posts)).toBe(false)
    } finally {
      daemon.kill("SIGTERM")
      await daemon.exited
    }
  }, 20_000)

  test("wake run waits for a slot place, runs the command, exits with its code, and releases the place", async () => {
    const { root, daemon, wake, done } = setup()
    try {
      await Bun.sleep(300)
      const marker = join(root, "ran")
      const run = await done(wake("run", "--slot", "heavy", "--stable", "0", "--name", "proof", "--", `echo ran > ${marker}; echo hello; exit 3`))
      expect(run.code).toBe(3)
      expect(run.stdout).toContain("hello")
      expect(readFileSync(marker, "utf8").trim()).toBe("ran")
      const slots = await done(wake("slots", "--json"))
      expect(JSON.parse(slots.stdout)).toContainEqual(expect.objectContaining({ slot: "heavy", holds: [] }))
      const log = await done(wake("logs", "proof"))
      expect(log.stdout).toContain("released slot heavy: wake run finished")
    } finally {
      daemon.kill("SIGTERM")
      await daemon.exited
    }
  }, 20_000)

  test("verbs that do not run a command refuse one after --", async () => {
    const { daemon, wake, done } = setup()
    daemon.kill("SIGTERM")
    await daemon.exited
    const result = await done(wake("in", "5m", "--session", "ses_x1", "--do", "hi", "--", "touch", "/tmp/nope"))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("takes no command after --")
    const gh = await done(wake("when", "pr-checks", "--repo", "a/b", "--pr", "1", "--do", "x", "--", "evil"))
    expect(gh.stderr).toContain("`wake when pr-checks` takes no command after --")
    const cli = join(import.meta.dir, "..", "src", "cli.ts")
    const blocked = Bun.spawnSync([process.execPath, cli, "when", "exits", "--session", "ses_x1", "--do", "x", "--", "true"], {
      env: { ...process.env, WAKE_HOME: tempRoot(), WAKE_ALLOW_EXEC: "0" },
    })
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr.toString()).toContain("WAKE_ALLOW_EXEC=0")
  })
})
