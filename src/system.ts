import type { RunResult } from "./condition.ts"
import type { Delivery, DeliveryResult } from "./engine.ts"
import { Limits, type Watch } from "./watch.ts"

const maxOutput = 64 * 1024

async function readCapped(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    if (text.length < maxOutput) text += decoder.decode(chunk, { stream: true })
  }
  return text.slice(0, maxOutput)
}

/**
 * Runs argv in its own process group, so a timeout kills the whole pipeline. The command inherits this
 * process's environment, with PATH replaced by the one recorded when the watch was created.
 */
export async function runCommand(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly path?: string; readonly timeoutMs: number },
): Promise<RunResult> {
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.path ? { PATH: options.path } : {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: String(error) }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }, options.timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([readCapped(child.stdout), readCapped(child.stderr), child.exited])
  clearTimeout(timer)
  return { exitCode, stdout, stderr, timedOut }
}

export const runWatch = (watch: Watch) =>
  runCommand(watch.command ?? [], {
    cwd: watch.cwd,
    path: watch.path,
    timeoutMs: watch.timeoutMs ?? Limits.defaultTimeoutMs,
  })

export const opencodeBinary = () => process.env.WAKE_OPENCODE ?? "opencode"

/** `opencode api` uses the same server discovery and credentials as the TUI. */
export async function opencodeApi(args: readonly string[], timeoutMs = 60_000) {
  return runCommand([opencodeBinary(), "api", ...args], { timeoutMs })
}

/** Queue a user message into a session via the shared OpenCode service. */
export async function deliverViaOpencode(delivery: Delivery): Promise<DeliveryResult> {
  const body = JSON.stringify({
    id: delivery.messageID,
    text: delivery.text,
    delivery: "queue",
    metadata: delivery.metadata,
  })
  const result = await opencodeApi(["post", `/api/session/${delivery.sessionID}/prompt`, "--data", body])
  if (result.exitCode === 0 && !result.timedOut) return { ok: true }
  const output = `${result.stdout} ${result.stderr}`.trim()
  const permanent = /SessionNotFoundError|HTTP 404|HTTP 400/.test(output)
  return { ok: false, permanent, error: result.error ?? (result.timedOut ? "opencode api timed out" : output.slice(0, 500)) }
}

export async function sessionExists(sessionID: string) {
  const result = await opencodeApi(["get", `/api/session/${sessionID}`], 30_000)
  if (result.exitCode === 0) {
    const title = (JSON.parse(result.stdout) as { data?: { title?: string } }).data?.title
    return { exists: true as const, title }
  }
  const output = `${result.stdout} ${result.stderr}`
  if (/SessionNotFoundError|HTTP 404/.test(output)) return { exists: false as const }
  throw new Error(`could not reach OpenCode to check the session: ${(result.error ?? output).trim().slice(0, 300)}`)
}

const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** Same shape as OpenCode's ascending identifiers, so the wake sorts where it was created. */
export function messageID(now: number) {
  const value = BigInt(now) * 0x1000n + 1n
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `msg_${time}${Array.from(bytes, (byte) => chars[byte % 62]).join("")}`
}

export function watchID() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `wk_${Array.from(bytes, (byte) => chars[byte % 62]).join("")}`
}
