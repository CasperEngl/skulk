import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { evaluate, type RunResult } from "./condition.ts"
import { wakeText } from "./message.ts"
import { logDirectory, type Store } from "./store.ts"
import { clip } from "./text.ts"
import { Limits, type Outcome, type Status, type Watch } from "./watch.ts"

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly permanent: boolean; readonly error: string }

export interface Delivery {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly metadata: Record<string, string>
}

export interface EngineDeps {
  readonly store: Store
  readonly now: () => number
  readonly run: (watch: Watch) => Promise<RunResult>
  readonly deliver: (delivery: Delivery) => Promise<DeliveryResult>
  readonly newMessageID: (now: number) => string
  readonly log?: (watchID: string, line: string) => void
  readonly maxConcurrent?: number
}

export const logPath = (root: string, watchID: string) => join(logDirectory(root), `${watchID}.log`)

export function fileLogger(root: string) {
  return (watchID: string, line: string) =>
    appendFileSync(logPath(root, watchID), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
}

const finalStatus: Record<Outcome, Status> = { met: "done", timer: "done", expired: "expired", failed: "failed" }

export function deliveryBackoff(attempt: number) {
  return Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000)
}

/**
 * Processes due watches. Every state transition is persisted before its side effect, and each wake is
 * posted with a message ID chosen once and stored. Re-posting the same ID is idempotent in OpenCode, so a
 * crash or restart between posting and recording delivery cannot produce a second wake.
 */
export class Engine {
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: EngineDeps) {}

  private log(watchID: string, line: string) {
    this.deps.log?.(watchID, line)
  }

  /** Starts work for every due watch not already in progress, and resolves when that work finishes. */
  tick() {
    const now = this.deps.now()
    const limit = this.deps.maxConcurrent ?? 8
    const due = this.deps.store
      .open()
      .filter((watch) => !this.inFlight.has(watch.id))
      .filter((watch) =>
        watch.status === "firing" ? (watch.nextDeliveryAt ?? 0) <= now : watch.dueAt <= now || watch.deadlineAt <= now,
      )
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(0, limit - this.inFlight.size))
    return Promise.all(
      due.map(async (watch) => {
        this.inFlight.add(watch.id)
        try {
          if (watch.status === "firing") await this.deliver(watch)
          else await this.process(watch)
        } catch (error) {
          this.log(watch.id, `internal error: ${clip(String(error))}`)
        } finally {
          this.inFlight.delete(watch.id)
        }
      }),
    ).then(() => undefined)
  }

  /** When the daemon should look again, at the latest. */
  nextWakeAt() {
    const times = this.deps.store
      .open()
      .filter((watch) => !this.inFlight.has(watch.id))
      .map((watch) => (watch.status === "firing" ? (watch.nextDeliveryAt ?? 0) : Math.min(watch.dueAt, watch.deadlineAt)))
    return times.length === 0 ? undefined : Math.min(...times)
  }

  private async process(watch: Watch) {
    if (watch.kind === "timer") return this.fire(watch, "timer")
    if (this.deps.now() >= watch.deadlineAt) return this.fire(watch, "expired")
    const result = await this.deps.run(watch)
    const now = this.deps.now()
    const check = evaluate(watch.condition!, result, watch.baseline)
    const next: Watch = { ...watch, checks: watch.checks + 1, lastCheckAt: now, lastExit: result.exitCode ?? undefined }
    if (check.type === "error") {
      next.consecutiveFailures = watch.consecutiveFailures + 1
      next.lastError = check.error
      this.log(watch.id, `check ${next.checks}: error (${next.consecutiveFailures}/${watch.maxFailures}): ${clip(check.error)}`)
      if (next.consecutiveFailures >= (watch.maxFailures ?? Limits.defaultMaxFailures)) return this.fire(next, "failed", watch.status)
    } else {
      next.consecutiveFailures = 0
      next.lastError = undefined
      next.previousValue = check.type === "met" ? (check.from ?? watch.lastValue) : watch.lastValue
      next.lastValue = check.value.slice(0, 4000)
      if (check.type === "pending" && check.baseline !== undefined) next.baseline = check.baseline
      const changed = watch.lastValue !== next.lastValue ? "" : " (unchanged)"
      this.log(watch.id, `check ${next.checks}: exit ${result.exitCode} value ${clip(check.value, 200)}${changed}${check.type === "met" ? " → condition met" : ""}`)
      if (check.type === "met") return this.fire(next, "met", watch.status)
    }
    // Coalesce: schedule from now, so a long sleep yields one catch-up check rather than a backlog.
    next.dueAt = now + (watch.intervalMs ?? Limits.minIntervalMs)
    if (!this.deps.store.update(next, "active")) this.log(watch.id, "watch changed during check (cancelled?); result discarded")
  }

  private async fire(watch: Watch, outcome: Outcome, expected: Status = watch.status) {
    const now = this.deps.now()
    const firing: Watch = {
      ...watch,
      status: "firing",
      outcome,
      firedAt: now,
      wakeMessageID: this.deps.newMessageID(now),
      wakeText: wakeText(watch, outcome, now),
      deliveryAttempts: 0,
      nextDeliveryAt: now,
    }
    if (!this.deps.store.update(firing, expected)) return this.log(watch.id, "watch changed before firing; skipped")
    this.log(watch.id, `${outcome}: queueing wake into ${watch.sessionID} as ${firing.wakeMessageID}`)
    await this.deliver(firing)
  }

  private async deliver(watch: Watch) {
    const result = await this.deps.deliver({
      sessionID: watch.sessionID,
      messageID: watch.wakeMessageID!,
      text: watch.wakeText!,
      metadata: { source: "wake", watchID: watch.id, outcome: watch.outcome ?? "" },
    })
    const now = this.deps.now()
    const attempts = watch.deliveryAttempts + 1
    let next: Watch
    if (result.ok) {
      next = { ...watch, status: finalStatus[watch.outcome!], deliveredAt: now, endedAt: now, deliveryAttempts: attempts, nextDeliveryAt: undefined }
      this.log(watch.id, `delivered to ${watch.sessionID} (attempt ${attempts}); watch ${next.status}`)
    } else if (result.permanent || now - (watch.firedAt ?? now) >= Limits.deliveryWindowMs) {
      next = { ...watch, status: "undeliverable", endedAt: now, deliveryAttempts: attempts, lastDeliveryError: result.error }
      this.log(watch.id, `could not deliver, giving up: ${clip(result.error)}`)
    } else {
      next = { ...watch, deliveryAttempts: attempts, lastDeliveryError: result.error, nextDeliveryAt: now + deliveryBackoff(attempts) }
      this.log(watch.id, `delivery attempt ${attempts} failed, retrying in ${Math.round(deliveryBackoff(attempts) / 1000)}s: ${clip(result.error)}`)
    }
    if (!this.deps.store.update(next, "firing")) this.log(watch.id, "watch changed during delivery (cancelled?)")
  }
}
