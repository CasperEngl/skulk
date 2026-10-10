#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { evaluate } from "./condition.ts"
import { displayCommand } from "./message.ts"
import { pollWatch, timerWatch } from "./create.ts"
import { daemonPID, nudge, runDaemon } from "./daemon.ts"
import { fileLogger, logPath } from "./engine.ts"
import { Store } from "./store.ts"
import { runWatch, sessionExists, watchID } from "./system.ts"
import { clip, formatDuration, formatTime, parseDuration, parseTime, redact, relative } from "./text.ts"
import { describeCondition, isOpen, Limits, type Condition, type Watch } from "./watch.ts"

const usage = `wake: wake an OpenCode session at a time, or when a polled command's output changes.

Timers
  wake in <duration> --do <instruction> [--name N] [--session S]
  wake at <time>     --do <instruction> [--name N] [--session S]
      duration: 90s, 20m, 2h30m, 1d     time: 15:30, 3pm, tomorrow 9:00, 2026-10-10 09:00

Polls (one wake when the condition holds, then the watch ends)
  wake poll --every <duration> <condition> --do <instruction> [options] -- <command...>
      conditions: --changes [--from VALUE]  output differs from VALUE (or from the first reading)
                  --equals VALUE            output equals VALUE
                  --matches REGEX           output matches REGEX
                  --succeeds                command exits 0
      options:    --deadline 48h   give up after this long (max 14d); the session is told
                  --failures 5     wake with an error after this many consecutive failed checks
                  --timeout 2m     per-check timeout (max 10m)
                  --cwd DIR        working directory for the command (default: current)
                  --no-check       skip the check that runs once at creation
      A single argument after -- runs through /bin/sh -c; several run as argv. The compared value is
      trimmed stdout. For value conditions a non-zero exit or empty output counts as a failed check.

Manage
  wake list [--all] [--json]       open watches (--all adds finished ones)
  wake show <id|name> [--json]
  wake cancel <id|name>...
  wake logs <id|name> [-n 50] [--follow]
  wake status                      daemon state
  wake daemon                      run the supervisor (launchd runs this)
  wake launchd [--label L]         print the LaunchAgent plist (honours $WAKE_HOME)

The target session defaults to $OPENCODE_SESSION_ID (the calling OpenCode session). Limits: checks at
most every 60s, ${Limits.maxActive} open watches, deadlines up to 14 days. State and logs live in
${"$"}WAKE_HOME (default ~/.local/state/wake), owner-only.`

function fail(message: string): never {
  console.error(`wake: ${message}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const separator = argv.indexOf("--")
const own = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

const { values: flags, positionals } = (() => {
  try {
    return parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        do: { type: "string" },
        name: { type: "string" },
        session: { type: "string" },
        every: { type: "string" },
        changes: { type: "boolean" },
        from: { type: "string" },
        equals: { type: "string" },
        matches: { type: "string" },
        succeeds: { type: "boolean" },
        deadline: { type: "string" },
        failures: { type: "string" },
        timeout: { type: "string" },
        cwd: { type: "string" },
        "no-check": { type: "boolean" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        follow: { type: "boolean", short: "f" },
        n: { type: "string", short: "n" },
        label: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    fail(`${(error as Error).message}\n\n${usage}`)
  }
})()

const [verb, ...rest] = positionals
if (!verb || flags.help || verb === "help") {
  console.log(usage)
  process.exit(0)
}

const store = new Store()

function resolveWatch(ref: string | undefined) {
  if (!ref) fail("which watch? give an ID or name")
  return store.find(ref) ?? fail(`no watch ${ref}`)
}

function daemonWarning() {
  return daemonPID(store.root) === undefined
    ? "\n⚠ the wake daemon is not running, so nothing will fire until it starts (see `wake status`)."
    : ""
}

async function targetSession() {
  const sessionID = flags.session ?? process.env.OPENCODE_SESSION_ID
  if (!sessionID) fail("no target session: pass --session ses_… (or run inside OpenCode)")
  const found = await sessionExists(sessionID).catch((error: Error) => fail(error.message))
  if (!found.exists) fail(`session ${sessionID} does not exist`)
  return { sessionID, title: found.title }
}

function summary(watch: Watch, title: string | undefined) {
  const target = `${watch.sessionID}${title ? ` (${title})` : ""}`
  if (watch.kind === "timer")
    return `Created ${watch.id} (${watch.name}): wakes ${target} at ${formatTime(watch.dueAt)} (${relative(watch.dueAt, Date.now())}).`
  const lines = [
    `Created ${watch.id} (${watch.name}): checks every ${formatDuration(watch.intervalMs!)} ${describeCondition(watch.condition)}, then wakes ${target}.`,
    `Deadline ${formatTime(watch.deadlineAt)} (${relative(watch.deadlineAt, Date.now())}).`,
  ]
  if (watch.lastValue) lines.push(`Current value: ${clip(watch.lastValue, 200)}`)
  return lines.join("\n")
}

function created(watch: Watch, title: string | undefined) {
  store.insertChecked(watch, Limits.maxActive)
  fileLogger(store.root)(
    watch.id,
    `created ${watch.kind} ${watch.name} for ${watch.sessionID}` +
      (watch.command ? `: ${clip(displayCommand(watch.command), 500)} ${describeCondition(watch.condition)} every ${formatDuration(watch.intervalMs!)}` : ` at ${new Date(watch.dueAt).toISOString()}`),
  )
  if (watch.checks > 0)
    fileLogger(store.root)(watch.id, `check 1 (at creation): exit ${watch.lastExit} value ${clip(watch.lastValue ?? "", 200)}`)
  nudge(store.root)
  if (flags.json) console.log(JSON.stringify(watch, null, 2))
  else console.log(summary(watch, title) + daemonWarning())
}

function condition(): Condition {
  const chosen = [flags.changes, flags.equals !== undefined, flags.matches !== undefined, flags.succeeds].filter(Boolean)
  if (chosen.length !== 1) fail("pick exactly one of --changes, --equals, --matches, --succeeds")
  if (flags.from !== undefined && !flags.changes) fail("--from goes with --changes")
  if (flags.changes) return { type: "changes", from: flags.from }
  if (flags.equals !== undefined) return { type: "equals", value: flags.equals }
  if (flags.matches !== undefined) return { type: "matches", pattern: flags.matches }
  return { type: "succeeds" }
}

function parseOr<T>(parse: () => T) {
  try {
    return parse()
  } catch (error) {
    fail((error as Error).message)
  }
}

async function createTimer(at: number) {
  const target = await targetSession()
  const watch = parseOr(() =>
    timerWatch({ id: watchID(), name: flags.name, sessionID: target.sessionID, instruction: flags.do ?? "", now: Date.now(), at, createdBy: process.env.OPENCODE_SESSION_ID }),
  )
  created(watch, target.title)
}

async function createPoll() {
  if (!flags.every) fail("--every is required")
  const cond = condition()
  const target = await targetSession()
  const now = Date.now()
  const watch = parseOr(() =>
    pollWatch({
      id: watchID(),
      name: flags.name,
      sessionID: target.sessionID,
      instruction: flags.do ?? "",
      now,
      createdBy: process.env.OPENCODE_SESSION_ID,
      command: command.length === 1 ? ["/bin/sh", "-c", command[0]!] : command,
      condition: cond,
      intervalMs: parseDuration(flags.every!),
      deadlineMs: flags.deadline ? parseDuration(flags.deadline) : undefined,
      timeoutMs: flags.timeout ? parseDuration(flags.timeout) : undefined,
      maxFailures: flags.failures ? Number(flags.failures) : undefined,
      cwd: resolve(flags.cwd ?? process.cwd()),
      path: process.env.PATH,
    }),
  )
  if (!flags["no-check"]) {
    const result = await runWatch(watch)
    const check = evaluate(cond, result, undefined)
    if (check.type === "error")
      fail(`the first check failed (${clip(check.error)}); fix the command, or pass --no-check to start anyway`)
    if (check.type === "met")
      fail(`the condition already holds (value: ${clip(check.value, 200)}); nothing to wait for`)
    Object.assign(watch, {
      checks: 1,
      lastCheckAt: Date.now(),
      lastExit: result.exitCode ?? undefined,
      lastValue: check.value.slice(0, 4000),
      baseline: check.baseline,
      dueAt: Date.now() + watch.intervalMs!,
    })
  }
  created(watch, target.title)
}

function row(watch: Watch, now: number) {
  const next =
    watch.status === "active"
      ? watch.kind === "timer"
        ? `fires ${relative(watch.dueAt, now)}`
        : `next check ${relative(watch.dueAt, now)}`
      : watch.status === "firing"
        ? "delivering"
        : `${watch.status} ${relative(watch.endedAt ?? watch.firedAt ?? watch.createdAt, now)}`
  const value = watch.kind === "poll" ? clip(watch.lastValue ?? "–", 40) : ""
  return [watch.id, watch.name, watch.sessionID, next, value]
}

function list() {
  const watches = flags.all ? store.list(undefined, 50) : store.open()
  if (flags.json) return console.log(JSON.stringify(watches, null, 2))
  if (watches.length === 0) return console.log(`No ${flags.all ? "" : "open "}watches.${daemonWarning()}`)
  const now = Date.now()
  const rows = [["ID", "NAME", "SESSION", "STATE", "LAST VALUE"], ...watches.map((watch) => row(watch, now))]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((cells) => cells[column]!.length)))
  for (const cells of rows) console.log(cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
  const warning = daemonWarning()
  if (warning) console.log(warning.trim())
}

function show(watch: Watch) {
  if (flags.json) return console.log(JSON.stringify(watch, null, 2))
  const now = Date.now()
  const at = (ms: number | undefined) => (ms === undefined ? "–" : `${formatTime(ms)} (${relative(ms, now)})`)
  const lines: [string, string | undefined][] = [
    ["Watch", `${watch.id} (${watch.name})`],
    ["Status", watch.status + (watch.outcome ? `, ${watch.outcome}` : "")],
    ["Session", watch.sessionID],
    ["Created", at(watch.createdAt)],
    ["Instruction", watch.instruction],
  ]
  if (watch.kind === "timer") lines.push(["Fires", at(watch.dueAt)])
  else
    lines.push(
      ["Command", redact(displayCommand(watch.command!))],
      ["Directory", watch.cwd],
      ["Condition", `${describeCondition(watch.condition)}, every ${formatDuration(watch.intervalMs!)}`],
      ["Deadline", at(watch.deadlineAt)],
      ["Next check", watch.status === "active" ? at(watch.dueAt) : "–"],
      ["Last check", at(watch.lastCheckAt)],
      ["Last value", watch.lastValue === undefined ? "–" : clip(watch.lastValue, 500)],
      ["Baseline", watch.baseline === undefined ? undefined : clip(watch.baseline, 200)],
      ["Checks", `${watch.checks} (${watch.consecutiveFailures} consecutive failures, limit ${watch.maxFailures})`],
      ["Last error", watch.lastError === undefined ? undefined : clip(watch.lastError, 500)],
    )
  if (watch.firedAt !== undefined)
    lines.push(
      ["Fired", at(watch.firedAt)],
      ["Delivered", watch.deliveredAt === undefined ? `no (${watch.deliveryAttempts} attempts)` : at(watch.deliveredAt)],
      ["Delivery error", watch.lastDeliveryError === undefined ? undefined : clip(watch.lastDeliveryError, 300)],
      ["Message", watch.wakeMessageID],
    )
  lines.push(["Log", logPath(store.root, watch.id)])
  const width = Math.max(...lines.map(([label]) => label.length))
  for (const [label, value] of lines) if (value !== undefined) console.log(`${label.padEnd(width)}  ${value}`)
}

function cancel(refs: readonly string[]) {
  if (refs.length === 0) fail("which watch? give an ID or name")
  for (const ref of refs) {
    const watch = resolveWatch(ref)
    if (!isOpen(watch)) {
      console.log(`${watch.id} (${watch.name}) is already ${watch.status}`)
      continue
    }
    const now = Date.now()
    if (!store.update({ ...watch, status: "cancelled", endedAt: now }, watch.status)) fail(`${watch.id} changed meanwhile; try again`)
    fileLogger(store.root)(watch.id, "cancelled")
    console.log(`Cancelled ${watch.id} (${watch.name}).`)
  }
  nudge(store.root)
}

async function logs(watch: Watch) {
  const path = logPath(store.root, watch.id)
  if (!existsSync(path)) return console.log(`No log yet for ${watch.id}.`)
  if (flags.follow) {
    const tail = Bun.spawn(["tail", "-n", flags.n ?? "50", "-f", path], { stdout: "inherit", stderr: "inherit" })
    await tail.exited
    return
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n")
  console.log(lines.slice(-Number(flags.n ?? 50)).join("\n"))
}

function status() {
  const pid = daemonPID(store.root)
  const open = store.open()
  console.log(pid ? `Daemon running (pid ${pid}).` : "Daemon NOT running. Start it with launchd (see README) or `wake daemon`.")
  console.log(`${open.length}/${Limits.maxActive} open watches. State: ${store.root}`)
}

function plist() {
  const home = process.env.HOME!
  const bun = process.execPath
  const cli = resolve(import.meta.dir, "cli.ts")
  const path = [`${home}/.bun/bin`, `${home}/.local/bin`, `${home}/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
  const log = join(store.root, "daemon.log")
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${flags.label ?? "dev.kitlangton.wake"}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>${cli}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${path}</string>
${process.env.WAKE_HOME ? `    <key>WAKE_HOME</key>\n    <string>${store.root}</string>\n` : ""}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>`)
}

switch (verb) {
  case "in":
    await createTimer(Date.now() + parseOr(() => parseDuration(rest.join(" ") || fail("wake in <duration>"))))
    break
  case "at":
    await createTimer(parseOr(() => parseTime(rest.join(" ") || fail("wake at <time>"), Date.now())))
    break
  case "poll":
    await createPoll()
    break
  case "list":
  case "ls":
    list()
    break
  case "show":
    show(resolveWatch(rest[0]))
    break
  case "cancel":
  case "rm":
    cancel(rest)
    break
  case "logs":
  case "log":
    await logs(resolveWatch(rest[0]))
    break
  case "status":
    status()
    break
  case "daemon":
    await runDaemon(store)
    break
  case "launchd":
    plist()
    break
  default:
    fail(`unknown command ${verb}\n\n${usage}`)
}
