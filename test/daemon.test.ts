import { expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pollWatch } from "../src/create.ts"
import { daemonPID, startLoop, type Loop } from "../src/daemon.ts"
import { Engine, processAlive } from "../src/engine.ts"
import { Store } from "../src/store.ts"
import { messageID } from "../src/system.ts"
import { tempRoot } from "./helpers.ts"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

/** Stands in for `opencode api`: records each admitted prompt once per message ID, like OpenCode's inbox. */
const fakeOpencode = `#!/usr/bin/env bash
if [ "$2" = "get" ]; then echo '{"data":{"title":"Scratch"}}'; exit 0; fi
id=$(printf '%s' "$5" | sed -E 's/.*"id":"(msg_[^"]+)".*/\\1/')
grep -q "$id" "$FAKE_LOG" 2>/dev/null || printf '%s\\n' "$5" >> "$FAKE_LOG"
`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("the real daemon resumes after a hard kill, refuses a second instance, and wakes exactly once", async () => {
  const root = tempRoot()
  const fake = join(root, "fake-opencode")
  const posts = join(root, "posts.jsonl")
  writeFileSync(fake, fakeOpencode)
  chmodSync(fake, 0o700)
  const env = { ...process.env, WAKE_HOME: root, WAKE_OPENCODE: fake, FAKE_LOG: posts, OPENCODE_SESSION_ID: "ses_e2eTarget1" }
  const wake = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env })

  const created = wake("in", "4s", "--name", "e2e", "--do", "Say hi.")
  expect(created.exitCode).toBe(0)
  expect(created.stdout.toString()).toContain("not running")

  const first = Bun.spawn([process.execPath, cli, "daemon"], { env, stdout: "ignore", stderr: "ignore" })
  await sleep(1000)
  first.kill("SIGKILL")
  await first.exited
  expect(existsSync(join(root, "daemon.pid"))).toBe(true)

  const second = Bun.spawn([process.execPath, cli, "daemon"], { env, stdout: "pipe", stderr: "ignore" })
  await sleep(800)
  const duplicate = Bun.spawnSync([process.execPath, cli, "daemon"], { env })
  expect(duplicate.stdout.toString()).toContain("already running")
  expect(wake("status").stdout.toString()).toContain(`pid ${second.pid}`)

  for (let i = 0; i < 40 && !existsSync(posts); i++) await sleep(250)
  await sleep(2500)
  second.kill("SIGTERM")
  await second.exited

  const lines = readFileSync(posts, "utf8").trim().split("\n")
  expect(lines.length).toBe(1)
  const body = JSON.parse(lines[0]!)
  expect(body.delivery).toBe("queue")
  expect(body.text).toContain("Wake: e2e")
  expect(body.text).toContain("Next: Say hi.")
  expect(wake("show", "e2e").stdout.toString()).toMatch(/Status\s+done, timer/)
  expect(existsSync(join(root, "daemon.pid"))).toBe(false)
}, 20_000)

test("the loop re-checks a watch at its interval even though it was in flight when the loop chose its sleep", async () => {
  const store = new Store(tempRoot())
  const runs: number[] = []
  let loop: Loop | undefined
  const engine = new Engine({
    store,
    now: Date.now,
    run: async () => {
      runs.push(Date.now())
      await sleep(20)
      return { exitCode: 0, stdout: "PENDING", stderr: "", timedOut: false }
    },
    deliver: async () => ({ ok: true }),
    newMessageID: messageID,
    onSettle: () => loop?.nudge(),
  })
  // Stands in for a 10–15s gh-run/pr-checks cadence, scaled down; the old loop slept the 30s fallback.
  const watch = pollWatch({ id: "wk_cadence", sessionID: "ses_cadence1", instruction: "x", now: Date.now(), command: ["true"], condition: { type: "equals", value: "DONE" }, intervalMs: 60_000 })
  store.insert({ ...watch, intervalMs: 200 })
  loop = startLoop(engine, { minDelayMs: 10, maxDelayMs: 30_000 })
  await sleep(1500)
  loop.stop()
  await loop.done
  expect(runs.length).toBeGreaterThanOrEqual(5)
  const gaps = runs.slice(1).map((at, index) => at - runs[index]!)
  expect(Math.max(...gaps)).toBeLessThan(600)
})

test("the PID file is ignored when its PID now belongs to an unrelated process", async () => {
  const root = tempRoot()
  const other = Bun.spawn(["sleep", "30"])
  writeFileSync(join(root, "daemon.pid"), String(other.pid))
  expect(daemonPID(root)).toBeUndefined()
  other.kill()
})

test("cancel and SIGTERM stop a running exits command's process group", async () => {
  const root = tempRoot()
  const fake = join(root, "fake-opencode")
  writeFileSync(fake, fakeOpencode)
  chmodSync(fake, 0o700)
  const env = { ...process.env, WAKE_HOME: root, WAKE_OPENCODE: fake, FAKE_LOG: join(root, "posts.jsonl"), OPENCODE_SESSION_ID: "ses_e2eTarget1" }
  const wake = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env })
  const daemon = Bun.spawn([process.execPath, cli, "daemon"], { env, stdout: "ignore", stderr: "ignore" })
  const childPID = async (file: string) => {
    for (let i = 0; i < 80 && !(existsSync(file) && readFileSync(file, "utf8").trim()); i++) await sleep(50)
    return Number(readFileSync(file, "utf8"))
  }
  const gone = async (pid: number) => {
    for (let i = 0; i < 80 && processAlive(pid); i++) await sleep(50)
    return !processAlive(pid)
  }
  try {
    await sleep(300)
    const first = join(root, "first.pid")
    expect(wake("when", "exits", "--name", "blocker", "--do", "x", "--", `sleep 60 & echo $! > ${first}; wait`).exitCode).toBe(0)
    const firstPID = await childPID(first)
    expect(processAlive(firstPID)).toBe(true)
    expect(wake("cancel", "blocker").exitCode).toBe(0)
    expect(await gone(firstPID)).toBe(true)

    const second = join(root, "second.pid")
    expect(wake("when", "exits", "--name", "survivor", "--do", "x", "--", `sleep 60 & echo $! > ${second}; wait`).exitCode).toBe(0)
    const secondPID = await childPID(second)
    daemon.kill("SIGTERM")
    await daemon.exited
    expect(await gone(secondPID)).toBe(true)
    expect(wake("show", "survivor").stdout.toString()).toMatch(/Status\s+active/)
    expect(existsSync(join(root, "posts.jsonl"))).toBe(false)
  } finally {
    daemon.kill("SIGKILL")
  }
}, 20_000)
