const secretPatterns: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b((?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;)\]}]+/gi,
]

/** Best-effort masking of common credential shapes before anything is logged or sent. */
export function redact(text: string) {
  return secretPatterns.reduce(
    (current, pattern) =>
      current.replace(pattern, (match, prefix?: string) =>
        typeof prefix === "string" && match.startsWith(prefix) && /[:=]/.test(prefix) ? `${prefix}[redacted]` : "[redacted]",
      ),
    text,
  )
}

export function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [${text.length - max} more chars]`
}

/** Single-line, redacted, truncated rendering for logs and messages. */
export function clip(text: string, max = 300) {
  return truncate(redact(text).replace(/\s*\n\s*/g, " ⏎ "), max)
}

const units: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 }

/** Parse durations like `90s`, `5m`, `2h30m`, `1d`. Bare numbers are seconds. */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text.replace(/\s+/g, ""))
    throw new Error(`invalid duration: ${input} (use e.g. 90s, 5m, 2h30m, 1d)`)
  return parts.reduce((total, part) => total + Number(part[1]) * (part[2] === "ms" ? 1 : units[part[2]!]!), 0)
}

/**
 * Parse a wall-clock time in local time: `15:30`, `3pm`, `tomorrow 9:00`, `2026-10-10 09:00`, or an ISO
 * timestamp. A bare time of day means its next occurrence.
 */
export function parseTime(input: string, now: number): number {
  const text = input.trim().toLowerCase()
  const clock = text.match(/^(today\s+|tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (clock) {
    let hour = Number(clock[2])
    const minute = Number(clock[3] ?? 0)
    if (clock[4] === "pm" && hour < 12) hour += 12
    if (clock[4] === "am" && hour === 12) hour = 0
    if (hour > 23 || minute > 59 || (!clock[3] && !clock[4])) throw new Error(`invalid time: ${input}`)
    const date = new Date(now)
    date.setHours(hour, minute, 0, 0)
    if (clock[1]?.trim() === "tomorrow") date.setDate(date.getDate() + 1)
    else if (!clock[1] && date.getTime() <= now) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/)
  if (local) return new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])).getTime()
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) throw new Error(`invalid time: ${input} (use e.g. 15:30, 3pm, tomorrow 9:00, 2026-10-10 09:00)`)
  return parsed
}

export function formatDuration(ms: number) {
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export const relative = (ms: number, now: number) =>
  ms >= now ? `in ${formatDuration(ms - now)}` : `${formatDuration(now - ms)} ago`
