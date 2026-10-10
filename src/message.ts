import { clip, formatDuration, formatTime } from "./text.ts"
import { describeCondition, type Outcome, type Watch } from "./watch.ts"

/** Shell-string watches are stored as `/bin/sh -c <string>`; show just the string. */
export const displayCommand = (argv: readonly string[]) =>
  argv.length === 3 && argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2]! : argv.join(" ")

/** The text queued into the target session. Values are redacted and truncated. */
export function wakeText(watch: Watch, outcome: Outcome, now: number) {
  const age = formatDuration(now - watch.createdAt)
  const lines: string[] = []
  if (outcome === "timer") {
    const late = now - watch.dueAt
    lines.push(`⏰ Wake: ${watch.name}: timer set ${age} ago for ${formatTime(watch.dueAt)}.`)
    if (late > 5 * 60_000) lines.push(`Fired ${formatDuration(late)} late (the Mac was asleep or off, or wake was stopped).`)
  } else {
    const command = watch.command ? clip(displayCommand(watch.command), 200) : undefined
    const condition = describeCondition(watch.condition)
    if (outcome === "met") {
      lines.push(`👀 Wake: ${watch.name}: condition met after ${age} (${watch.checks} checks).`)
      if (watch.condition?.type === "succeeds") {
        lines.push("The command now exits 0.")
        if (watch.lastValue) lines.push(`Output: ${clip(watch.lastValue)}`)
      } else if (watch.previousValue !== undefined && watch.previousValue !== watch.lastValue)
        lines.push(`Changed: ${clip(watch.previousValue)} → ${clip(watch.lastValue ?? "")}`)
      else lines.push(`Value: ${clip(watch.lastValue ?? "")}`)
    } else if (outcome === "expired") {
      lines.push(`⌛ Wake: ${watch.name}: deadline reached after ${age}; the condition (${condition}) never held.`)
      if (watch.lastValue !== undefined) lines.push(`Last value: ${clip(watch.lastValue)}`)
    } else {
      lines.push(
        `⚠️ Wake: ${watch.name}: stopped after ${watch.consecutiveFailures === 1 ? "a failed check" : `${watch.consecutiveFailures} consecutive failed checks`} (${condition}).`,
      )
      if (watch.lastError) lines.push(`Last error: ${clip(watch.lastError)}`)
    }
    lines.push(command === undefined ? `Condition: ${condition}` : `Command: \`${command}\``)
    if (outcome === "met" && watch.slot)
      lines.push(
        `Slot: you hold a place in \`${watch.slot}\` until ${formatTime(watch.holdExpiresAt ?? now)}. Run \`wake release ${watch.id}\` as soon as the heavy work ends; it is also released when this session goes idle.`,
      )
  }
  lines.push(`${outcome === "met" || outcome === "timer" ? "Next" : "Originally asked"}: ${clip(watch.instruction, 1500)}`)
  lines.push(`Inspect: \`wake show ${watch.id}\` · \`wake logs ${watch.id}\``)
  return lines.join("\n")
}
