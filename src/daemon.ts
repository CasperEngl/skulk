import { chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Engine, fileLogger } from "./engine.ts"
import { Store } from "./store.ts"
import { deliverViaOpencode, messageID, probeCapacity, runWatch, sessionState } from "./system.ts"

export const pidPath = (root: string) => join(root, "daemon.pid")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The running daemon's PID, if any. */
export function daemonPID(root: string) {
  if (!existsSync(pidPath(root))) return undefined
  const pid = Number(readFileSync(pidPath(root), "utf8").trim())
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined
}

/** Ask a running daemon to look at the store now (after create or cancel). */
export function nudge(root: string) {
  const pid = daemonPID(root)
  if (pid === undefined) return false
  try {
    process.kill(pid, "SIGUSR1")
    return true
  } catch {
    return false
  }
}

function acquireLock(root: string) {
  for (const attempt of [1, 2]) {
    try {
      const fd = openSync(pidPath(root), "wx", 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 2) throw error
      if (daemonPID(root) !== undefined) return false
      unlinkSync(pidPath(root))
    }
  }
  return false
}

const stamp = () => new Date().toISOString()

export async function runDaemon(store: Store) {
  const root = store.root
  if (!acquireLock(root)) {
    console.log(`${stamp()} wake daemon already running (pid ${daemonPID(root)}); exiting`)
    return
  }
  // launchd creates its StandardOutPath before applying the plist's Umask.
  if (existsSync(join(root, "daemon.log"))) chmodSync(join(root, "daemon.log"), 0o600)
  const release = () => {
    if (daemonPID(root) === process.pid) unlinkSync(pidPath(root))
  }
  const engine = new Engine({
    store,
    now: Date.now,
    run: runWatch,
    deliver: deliverViaOpencode,
    newMessageID: messageID,
    log: fileLogger(root),
    builtin: { capacity: probeCapacity, sessionState, watchStatus: (ref) => store.find(ref)?.status },
  })
  let wakeUp: (() => void) | undefined
  let stopping = false
  process.on("SIGUSR1", () => wakeUp?.())
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => {
      stopping = true
      release()
      console.log(`${stamp()} wake daemon stopping (${signal})`)
      process.exit(0)
    })
  process.on("exit", release)

  const open = store.open()
  console.log(`${stamp()} wake daemon started (pid ${process.pid}, ${open.length} open watches, state ${root})`)
  while (!stopping) {
    // Not awaited: a slow check must not hold up other watches' timers.
    void engine.tick().catch((error) => console.error(`${stamp()} tick failed: ${error}`))
    const next = engine.nextWakeAt()
    const delay = Math.max(1000, Math.min(30_000, next === undefined ? 30_000 : next - Date.now()))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      wakeUp = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
