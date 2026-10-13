import { clip, formatDuration, formatTime } from "./text.ts"
import { describeCondition, type Outcome, type Watch } from "./watch.ts"

/** Shell-string watches are stored as `/bin/sh -c <string>`; show just the string. */
export const displayCommand = (argv: readonly string[]) =>
  argv.length === 3 && argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2]! : argv.join(" ")

/** Observed values come from outside (CLIs, GitHub, npm): quote them so they read as data, not instructions. */
const quote = (value: string) => `\`${clip(value).replace(/`/g, "'")}\``

/** The text queued into the target session. Values are redacted, truncated and quoted. */
export function wakeText(watch: Watch, outcome: Outcome, now: number) {
  const age = formatDuration(now - watch.createdAt)
  const lines: string[] = []
  if (outcome === "timer") {
    const late = now - watch.dueAt
    lines.push(`⏰ Skulk: ${watch.name}: timer set ${age} ago for ${formatTime(watch.dueAt)}.`)
    if (late > 5 * 60_000) lines.push(`Fired ${formatDuration(late)} late (the Mac was asleep or off, or skulk was stopped).`)
  } else {
    const command = watch.command ? clip(displayCommand(watch.command), 200) : undefined
    const condition = describeCondition(watch.condition)
    if (outcome === "met") {
      lines.push(`👀 Skulk: ${watch.name}: condition met after ${age} (${watch.checks} checks).`)
      if (watch.condition?.type === "succeeds") {
        lines.push("The command now exits 0.")
        if (watch.lastValue) lines.push(`Output: ${quote(watch.lastValue)}`)
      } else if (watch.condition?.type === "exits") {
        lines.push(`The command exited with code ${watch.lastExit ?? 0}.`)
        const tail = (watch.lastValue ?? "").replace(/^exit -?\d+(?::\s*)?/, "")
        if (tail) lines.push(`Output tail: ${quote(tail)}`)
      } else if (watch.previousValue !== undefined && watch.previousValue !== watch.lastValue)
        lines.push(`Changed: ${quote(watch.previousValue)} → ${quote(watch.lastValue ?? "")}`)
      else lines.push(`Value: ${quote(watch.lastValue ?? "")}`)
    } else if (outcome === "expired") {
      lines.push(`⌛ Skulk: ${watch.name}: deadline reached after ${age}; the condition (${condition}) never held.`)
      if (watch.lastValue !== undefined) lines.push(`Last value: ${quote(watch.lastValue)}`)
    } else {
      lines.push(
        `⚠️ Skulk: ${watch.name}: stopped after ${watch.consecutiveFailures === 1 ? "a failed check" : `${watch.consecutiveFailures} consecutive failed checks`} (${condition}).`,
      )
      if (watch.lastError) lines.push(`Last error: ${quote(watch.lastError)}`)
    }
    lines.push(command === undefined ? `Condition: ${condition}` : `Command: \`${command}\``)
    if (outcome === "met" && watch.slot)
      lines.push(
        `Slot: you hold a place in \`${watch.slot}\` until ${formatTime(watch.holdExpiresAt ?? now)}. Run \`skulk release ${watch.id}\` as soon as the heavy work ends; it is also released when this session goes idle.`,
      )
  }
  lines.push(`${outcome === "met" || outcome === "timer" ? "Next" : "Originally asked"}: ${clip(watch.instruction, 1500)}`)
  lines.push(`Inspect: \`skulk show ${watch.id}\` · \`skulk logs ${watch.id}\``)
  return lines.join("\n")
}
