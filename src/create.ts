import type { Condition } from "./watch.ts"
import { Limits, type Watch } from "./watch.ts"

interface Common {
  readonly id: string
  readonly name?: string
  readonly sessionID: string
  readonly instruction: string
  readonly now: number
  readonly createdBy?: string
}

const base = (input: Common) => ({
  id: input.id,
  name: input.name?.trim() || input.id,
  sessionID: input.sessionID,
  instruction: input.instruction,
  createdAt: input.now,
  createdBy: input.createdBy,
  status: "active" as const,
  checks: 0,
  consecutiveFailures: 0,
  deliveryAttempts: 0,
})

function validateCommon(input: Common) {
  if (!/^ses_[A-Za-z0-9]+$/.test(input.sessionID)) throw new Error(`not a session ID: ${input.sessionID}`)
  if (!input.instruction.trim()) throw new Error("say what to do on wake with --do")
  if (input.name !== undefined && !/^[\w.:-]{1,64}$/.test(input.name))
    throw new Error("--name may use letters, digits, . _ : - (max 64)")
}

export function timerWatch(input: Common & { readonly at: number }): Watch {
  validateCommon(input)
  if (input.at <= input.now) throw new Error("the wake time is in the past")
  if (input.at - input.now > Limits.maxDeadlineMs) throw new Error("timers can be at most 14 days out")
  return { ...base(input), kind: "timer", dueAt: input.at, deadlineAt: input.at }
}

export function pollWatch(
  input: Common & {
    readonly command: readonly string[]
    readonly condition: Condition
    readonly intervalMs: number
    readonly deadlineMs?: number
    readonly timeoutMs?: number
    readonly maxFailures?: number
    readonly cwd?: string
    readonly path?: string
  },
): Watch {
  validateCommon(input)
  if (input.command.length === 0) throw new Error("give the command to poll after --")
  if (input.intervalMs < Limits.minIntervalMs) throw new Error("--every must be at least 60s")
  const deadlineMs = input.deadlineMs ?? Limits.defaultDeadlineMs
  if (deadlineMs <= 0 || deadlineMs > Limits.maxDeadlineMs) throw new Error("--deadline must be between 0 and 14d")
  const timeoutMs = input.timeoutMs ?? Math.min(input.intervalMs, Limits.defaultTimeoutMs)
  if (timeoutMs <= 0 || timeoutMs > Limits.maxTimeoutMs) throw new Error("--timeout must be at most 10m")
  const maxFailures = input.maxFailures ?? Limits.defaultMaxFailures
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) throw new Error("--failures must be 1–100")
  if (input.condition.type === "matches") new RegExp(input.condition.pattern)
  return {
    ...base(input),
    kind: "poll",
    command: [...input.command],
    cwd: input.cwd,
    path: input.path,
    condition: input.condition,
    intervalMs: input.intervalMs,
    timeoutMs,
    maxFailures,
    dueAt: input.now,
    deadlineAt: input.now + deadlineMs,
  }
}
