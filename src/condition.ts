import type { Condition } from "./watch.ts"

export interface RunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error?: string
}

export type Check =
  | { readonly type: "error"; readonly error: string; readonly value?: string }
  | { readonly type: "pending"; readonly value: string; readonly baseline?: string }
  | { readonly type: "met"; readonly value: string; readonly from?: string }

/** The compared value: trimmed stdout. */
export const valueOf = (result: RunResult) => result.stdout.trim()

/**
 * Classify one command run. A run is an error when the command could not run or timed out. For value
 * conditions it is also an error when the command exits non-zero or prints nothing, so a broken or
 * logged-out CLI never reads as "changed". For `succeeds`, a non-zero exit just means "not yet".
 */
export function evaluate(condition: Condition, result: RunResult, baseline: string | undefined): Check {
  const value = valueOf(result)
  if (result.error !== undefined) return { type: "error", error: result.error }
  if (result.timedOut) return { type: "error", error: "timed out", value }
  if (condition.type === "succeeds") return result.exitCode === 0 ? { type: "met", value } : { type: "pending", value }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? ""
    return { type: "error", error: `exit ${result.exitCode}${detail ? `: ${detail}` : ""}`, value }
  }
  if (value === "") return { type: "error", error: "empty output" }
  switch (condition.type) {
    case "changes": {
      const from = condition.from ?? baseline
      if (from === undefined) return { type: "pending", value, baseline: value }
      return value !== from ? { type: "met", value, from } : { type: "pending", value }
    }
    case "equals":
      return value === condition.value ? { type: "met", value } : { type: "pending", value }
    case "matches":
      return new RegExp(condition.pattern).test(value) ? { type: "met", value } : { type: "pending", value }
    default:
      return { type: "error", error: `${condition.type} is evaluated by the daemon, not a command` }
  }
}
