export type Condition =
  | { readonly type: "changes"; readonly from?: string }
  | { readonly type: "equals"; readonly value: string }
  | { readonly type: "matches"; readonly pattern: string }
  | { readonly type: "succeeds" }

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
} as const

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
  }
}
