import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const pidPath = (root: string) => join(root, "daemon.pid")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * After a reboot or crash the PID file can name an unrelated process that reused the PID. Signalling
 * that process with SIGUSR1 would kill it, so check its command line (when `ps` can tell us).
 */
export function looksLikeDaemon(pid: number) {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" })
  } catch {
    return true
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) return true
  return /(^|\s)daemon\s*$/.test(String(result.stdout ?? "").trim())
}

/** The running daemon's PID, if any. */
export function daemonPID(root: string) {
  if (!existsSync(pidPath(root))) return undefined
  const pid = Number(readFileSync(pidPath(root), "utf8").trim())
  return Number.isInteger(pid) && pid > 0 && alive(pid) && looksLikeDaemon(pid) ? pid : undefined
}
