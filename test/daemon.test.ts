import { expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRoot } from "./helpers.ts"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

/** Stands in for `opencode api`: records each admitted prompt once per message ID, like OpenCode's inbox. */
const fakeOpencode = `#!/bin/bash
if [ "$2" = "get" ]; then echo '{"data":{"title":"Scratch"}}'; exit 0; fi
id=$(printf '%s' "$5" | /usr/bin/sed -E 's/.*"id":"(msg_[^"]+)".*/\\1/')
/usr/bin/grep -q "$id" "$FAKE_LOG" 2>/dev/null || printf '%s\\n' "$5" >> "$FAKE_LOG"
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
