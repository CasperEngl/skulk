# wake

Wake an OpenCode session later: at a time, or when a polled command's output changes. One small daemon (launchd) owns every watch, persists it in SQLite, and queues exactly one message into the target session through `opencode api`, the same path `~/code/home/bin/routine` uses.

```bash
wake in 2h --do "Check whether the deploy finished and report."
wake at "tomorrow 9:00" --session ses_… --name standup --do "Post standup notes."

wake poll --every 5m --changes --from SUBMITTED --name ramp-mac \
  --do "Ramp request decided: finish the checkout if approved (todo ef10f090)." \
  -- 'ramp requests get 01a122f9-… --agent | jq -r ".data[0].status"'

cd ~/code/open-source/opencode   # gh resolves the repo from the watch's directory
wake poll --every 2m --changes --from pending --deadline 3h --name ci-54218 \
  --do "CI finished: fix failures, or merge if green." \
  -- 'gh pr checks 54218 --json bucket -q "if any(.[]; .bucket == \"pending\") then \"pending\" else (map(.bucket) | unique | join(\",\")) end" || true'

wake list            # open watches with next check and last value
wake show ramp-mac   # full state: last check, last value, failures, delivery
wake logs ramp-mac   # per-check log (-f to follow)
wake cancel ramp-mac
wake status          # is the daemon running?
```

The target session defaults to `$OPENCODE_SESSION_ID`, which OpenCode's shell tool sets to the calling session, so an agent that runs `wake` wakes itself. Pass `--session` to wake another session (for example HOME).

## Conditions

The compared value is the command's trimmed stdout. A single argument after `--` runs through `/bin/sh -c`; several arguments run as argv.

| Flag | Fires when |
| --- | --- |
| `--changes --from V` | output is not `V` |
| `--changes` | output differs from the first reading |
| `--equals V` | output is exactly `V` |
| `--matches RE` | output matches the JavaScript regex `RE` |
| `--succeeds` | the command exits 0 |

For value conditions, a non-zero exit, empty output, or timeout is a failed check, never a change, so a logged-out CLI cannot cause a false wake. For `--succeeds`, a non-zero exit just means "not yet".

`wake poll` runs the command once at creation. It refuses to create the watch if that check fails or if the condition already holds (`--no-check` skips this), and shows the current value.

## Built-in conditions and slots

Some waits are common enough that the daemon evaluates them itself, so nobody writes a probe script:

```sh
# Run heavy work when the Mac has room, one job at a time
wake when capacity --slot heavy --name perf-proofs \
  --do "Capacity granted: run the native and CLI proofs, then wake release."

# Continue when other sessions finish, or when other watches end
wake when idle ses_perf ses_arch --do "Both agents are done: review and push their branches."
wake when done perf-proofs --do "Proofs finished; summarize."
```

| Condition | Holds when |
| --- | --- |
| `capacity` | 3-minute CPU mean ≤ `--cpu` (70), at most `--builds` (1) xcodebuilds, ≥ `--disk` (20) GB free, continuously for `--stable` (3m). Read from `mac-sim-lease --status`, which owns the Mac's capacity signals; override with `$WAKE_CAPACITY_COMMAND`. |
| `idle ses_…` | every listed OpenCode session has finished its run (`time.idle ≥ time.updated`) and stayed idle for `--stable` (2m) |
| `done <watch>…` | every listed watch has ended: fired, expired, failed or cancelled |

An unreadable probe or a missing session is a failed check, never a pass.

**Slots** stop several waiters from piling onto the same opening. With `--slot NAME` (on `when` or `poll`), a watch whose condition holds waits for a place in `NAME` before it wakes its session:

- First come, first served: only the oldest waiter in a slot can be granted.
- Each grant restarts the other waiters' `--stable` window, so the next grant sees the CPU after the first job has started.
- A place is held until `wake release <watch>` (or `wake release` for every hold of the calling session), the woken session goes idle after a 2-minute grace period, or `--hold` expires (default 2h, max 12h).
- `heavy` has two places, matching the mac-capacity rule of two heavy jobs; other slots have one. `wake slot NAME --size N` changes that, and `wake slots` shows holders and queues.

## Guarantees and guardrails

- **One wake, then done.** Met, expired and failed watches each send one message and stop.
- **Durable.** Watches live in `~/.local/state/wake/wake.db`. The launchd agent starts the daemon at login and restarts it if it dies. After a restart, overdue timers fire once (flagged "late" if more than five minutes late) and overdue polls run one catch-up check, not a backlog.
- **No duplicate wakes.** The wake's text and OpenCode message ID are stored before posting. A retry or restart re-posts the same ID, which OpenCode admits once. Verified against the live server: re-posting a delivered wake returned the original message and created no new user turn.
- **Delivery retries.** If OpenCode is unreachable, delivery retries with backoff (15s doubling to 10m) for 24h. A deleted target session ends the watch as `undeliverable`.
- **Limits.** Checks at most every 60s. Deadline defaults to 48h, max 14 days (also the max timer distance). At most 20 open watches. Per-check timeout defaults to min(interval, 2m), max 10m, and kills the whole process group. After 5 consecutive failed checks (`--failures`), the session is woken with the last error.
- **Messages.** Each wake names the watch, says what changed (`old → new`), repeats the `--do` instruction, and says how to inspect it (`wake show`, `wake logs`). Values are clipped to 300 characters and the instruction to 1500.

## Security

- Commands run as Kit, in the directory where the watch was created, with the **daemon's** environment (the launchd plist's `HOME` and `PATH`) plus the `PATH` captured when the watch was created. They do not get the creating shell's other variables, so a command that needs a token should fetch it itself (keychain, `op read`, a CLI's own login), not inline it.
- The command is stored in the database so it can run later. Don't put secrets in it.
- State, the database and logs are owner-only (directory `0700`, files `0600`; the daemon runs with umask `077`). Logs record values and error lines, clipped and passed through best-effort redaction of common token shapes (`Bearer …`, `ghp_…`, `sk-…`, `xox…-…`, JWTs, `token=…`). The environment is never logged.
- Anyone who can run `wake` can make the daemon run commands as Kit. OpenCode's shell permissions govern agents; the daemon adds no privilege beyond what the creating shell already had.

## Install

```bash
cd ~/code/open-source/wake && bun install && bun link            # puts `wake` on PATH (~/.bun/bin)
wake launchd > ~/Library/LaunchAgents/dev.kitlangton.wake.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.kitlangton.wake.plist
wake status
```

Uninstall: `launchctl bootout gui/$(id -u)/dev.kitlangton.wake`, then remove the plist. Daemon output goes to `~/.local/state/wake/daemon.log`. `WAKE_HOME` relocates all state (tests and verification use it); `WAKE_OPENCODE` overrides the `opencode` binary.

## Why a daemon and not an OpenCode plugin

A V2 plugin can register a tool that sees the calling session's ID, and it can post prompts through `ctx.session.prompt`. It cannot host durable background polling:

- Plugins are instantiated per location (`packages/core/src/plugin/supervisor.ts` is a location node). A global plugin runs once per active directory, so an in-plugin poller would run several times over unless it coordinated through a lock.
- Idle locations are evicted after 60 minutes without session activity (`location-activity.ts`), which tears down their plugins. Waiting for something for hours is exactly that idle case.
- After a server restart, a location's plugins load only when something touches that location again, so pending watches would not resume on their own.
- Polling inside the shared service also ties watch commands to that service's environment and lifetime, and restarting it to deploy plugin changes interrupts everyone's sessions.

The CLI loses little: `$OPENCODE_SESSION_ID` already gives the creating session, and shell permissions already gate it. A thin plugin that exposes `wake_*` tools by writing to the same database could come later, for agents without shell access. The long-term home is a core scheduling primitive; see Organizer todo `04a7e7ef`.

## Development

```bash
bun test          # engine (conditions, restarts, coalescing, deadlines, failures, delivery), units, and a real-daemon kill/restart test
bun run typecheck
```
