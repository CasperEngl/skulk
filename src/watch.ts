export type Condition =
  | { readonly type: "changes"; readonly from?: string }
  | { readonly type: "equals"; readonly value: string }
  | { readonly type: "matches"; readonly pattern: string }
  | { readonly type: "succeeds" }
  // Built-in conditions are evaluated by the daemon itself; they have no user command.
  | { readonly type: "capacity"; readonly cpu: number; readonly builds: number; readonly diskGB: number; readonly stableMs: number }
  | { readonly type: "idle"; readonly sessions: readonly string[]; readonly stableMs: number }
  | { readonly type: "done"; readonly watches: readonly string[] }

export type Builtin = Extract<Condition, { readonly type: "capacity" | "idle" | "done" }>
export const isBuiltin = (condition: Condition | undefined): condition is Builtin =>
  condition?.type === "capacity" || condition?.type === "idle" || condition?.type === "done"

export type Status = "active" | "firing" | "done" | "expired" | "failed" | "cancelled" | "undeliverable"
export type Outcome = "met" | "timer" | "expired" | "failed"

export interface Watch {
  id: string
  name: string
  sessionID: string
  kind: "timer" | "poll"
  instruction: string
  createdAt: number
  createdBy?: string
  /** Next check for a poll; fire time for a timer. */
  dueAt: number
  deadlineAt: number
  status: Status
  // poll
  command?: string[]
  cwd?: string
  path?: string
  condition?: Condition
  intervalMs?: number
  timeoutMs?: number
  maxFailures?: number
  baseline?: string
  /** When a built-in condition started holding continuously. */
  heldSince?: number
  /** Queue for a shared slot; the wake fires only once a place in the slot is granted. */
  slot?: string
  holdMs?: number
  holdExpiresAt?: number
  lastValue?: string
  lastExit?: number
  lastError?: string
  lastCheckAt?: number
  checks: number
  consecutiveFailures: number
  // wake
  outcome?: Outcome
  firedAt?: number
  previousValue?: string
  wakeMessageID?: string
  wakeText?: string
  deliveryAttempts: number
  nextDeliveryAt?: number
  lastDeliveryError?: string
  deliveredAt?: number
  endedAt?: number
}

export const Limits = {
  minIntervalMs: 60_000,
  defaultDeadlineMs: 48 * 3600_000,
  maxDeadlineMs: 14 * 24 * 3600_000,
  maxActive: 20,
  defaultMaxFailures: 5,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 10 * 60_000,
  /** Keep retrying an undelivered wake (e.g. OpenCode is down) for this long. */
  deliveryWindowMs: 24 * 3600_000,
  defaultHoldMs: 2 * 3600_000,
  maxHoldMs: 12 * 3600_000,
  /** A woken session gets this long to start working before going idle releases its slot. */
  holdGraceMs: 2 * 60_000,
} as const

/** Default sizes for slots nobody has resized: `heavy` follows the mac-capacity rule of two heavy jobs. */
export const defaultSlotSize = (slot: string) => (slot === "heavy" ? 2 : 1)

export const isOpen = (watch: Watch) => watch.status === "active" || watch.status === "firing"

export const describeCondition = (condition: Condition | undefined) => {
  if (!condition) return "timer"
  switch (condition.type) {
    case "changes":
      return condition.from === undefined ? "until output changes" : `until output changes from ${JSON.stringify(condition.from)}`
    case "equals":
      return `until output equals ${JSON.stringify(condition.value)}`
    case "matches":
      return `until output matches /${condition.pattern}/`
    case "succeeds":
      return "until the command exits 0"
    case "capacity":
      return `until the Mac has capacity (CPU ≤${condition.cpu}%, ≤${condition.builds} xcodebuild, ≥${condition.diskGB} GB free, steady ${Math.round(condition.stableMs / 60_000)}m)`
    case "idle":
      return `until ${condition.sessions.join(", ")} ${condition.sessions.length === 1 ? "is" : "are"} idle`
    case "done":
      return `until ${condition.watches.join(", ")} ${condition.watches.length === 1 ? "has" : "have"} ended`
  }
}
