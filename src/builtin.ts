import type { Check, RunResult } from "./condition.ts"
import type { Builtin, Status, Watch } from "./watch.ts"

export type SessionState = "idle" | "busy" | "missing"

export interface BuiltinDeps {
  /** Runs the capacity probe (`mac-sim-lease --status` by default). */
  readonly capacity: (watch: Watch) => Promise<RunResult>
  readonly sessionState: (sessionID: string) => Promise<SessionState>
  readonly watchStatus: (ref: string) => Status | undefined
}

export interface Capacity {
  readonly cpu: number | undefined
  readonly builds: number
  readonly diskGB: number
}

/** Reads the one-line summary printed by `mac-sim-lease --status`. */
export function parseCapacity(text: string): Capacity | undefined {
  const cpu = /cpu (\d+)% busy/.exec(text)
  const builds = /xcodebuild (\d+)/.exec(text)
  const disk = /disk (\d+) GB free/.exec(text)
  if (!builds || !disk || !/cpu \d*% busy/.test(text)) return undefined
  return { cpu: cpu ? Number(cpu[1]) : undefined, builds: Number(builds[1]), diskGB: Number(disk[1]) }
}

export const describeCapacity = (capacity: Capacity) =>
  `cpu ${capacity.cpu ?? "?"}% · ${capacity.builds} xcodebuild · ${capacity.diskGB} GB free`

export interface BuiltinCheck {
  readonly check: Check
  readonly heldSince?: number
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m`

/**
 * A steady condition must hold continuously for `stableMs`. The window also restarts at the slot's last
 * grant, so a job started by one waiter is reflected in CPU before the next waiter can be granted.
 */
function steady(value: string, holds: boolean, stableMs: number, previous: number | undefined, now: number, restartAt = 0): BuiltinCheck {
  if (!holds) return { check: { type: "pending", value } }
  const since = previous ?? now
  const start = Math.max(since, restartAt)
  const held = now - start
  if (held >= stableMs) return { check: { type: "met", value }, heldSince: since }
  return { check: { type: "pending", value: `${value} · steady ${minutes(held)}/${minutes(stableMs)}` }, heldSince: since }
}

export async function checkBuiltin(watch: Watch, condition: Builtin, deps: BuiltinDeps, now: number, restartAt?: number): Promise<BuiltinCheck> {
  switch (condition.type) {
    case "capacity": {
      const result = await deps.capacity(watch)
      if (result.error !== undefined) return { check: { type: "error", error: result.error } }
      if (result.timedOut) return { check: { type: "error", error: "capacity probe timed out" } }
      if (result.exitCode !== 0) return { check: { type: "error", error: `capacity probe exit ${result.exitCode}: ${result.stderr.trim().split("\n").at(-1) ?? ""}` } }
      const capacity = parseCapacity(result.stdout)
      if (!capacity) return { check: { type: "error", error: "could not read the capacity summary" } }
      if (capacity.cpu === undefined) return { check: { type: "error", error: "no recent CPU reading", value: describeCapacity(capacity) } }
      const holds = capacity.cpu <= condition.cpu && capacity.builds <= condition.builds && capacity.diskGB >= condition.diskGB
      return steady(describeCapacity(capacity), holds, condition.stableMs, watch.heldSince, now, restartAt)
    }
    case "idle": {
      let states: (readonly [string, SessionState])[]
      try {
        states = await Promise.all(condition.sessions.map(async (session) => [session, await deps.sessionState(session)] as const))
      } catch (error) {
        return { check: { type: "error", error: (error as Error).message } }
      }
      const missing = states.find(([, state]) => state === "missing")
      if (missing) return { check: { type: "error", error: `session ${missing[0]} not found` } }
      const value = states.map(([session, state]) => `${session} ${state}`).join(" · ")
      return steady(value, states.every(([, state]) => state === "idle"), condition.stableMs, watch.heldSince, now)
    }
    case "done": {
      const states = condition.watches.map((ref) => [ref, deps.watchStatus(ref)] as const)
      const missing = states.find(([, status]) => status === undefined)
      if (missing) return { check: { type: "error", error: `no watch ${missing[0]}` } }
      const value = states.map(([ref, status]) => `${ref} ${status}`).join(" · ")
      const ended = states.every(([, status]) => status !== "active" && status !== "firing")
      return { check: ended ? { type: "met", value } : { type: "pending", value } }
    }
  }
}
