# wake

Wake an OpenCode session later: at a time, when a built-in trigger completes, or when a polled command's output changes. One small daemon (a `launchd` or `systemd --user` service) owns every watch, persists it in SQLite, and queues exactly one message into the target session through `opencode api`.

```bash
wake in 2h --do "Check whether the deploy finished and report."
wake at "tomorrow 9:00" --session ses_… --name standup --do "Post standup notes."

# Wait for a GitHub Actions workflow run (or PR checks, or an npm publish)
wake when gh-run --repo anomalyco/opencode --workflow publish.yml --sha 41b03dea0f --name publish-41b03d \
  --do "If publish succeeded, wait for @opencode/client@dev on npm; if failed, run gh-fail."
wake when pr-checks --repo anomalyco/opencode --pr 54218 --name ci-54218 \
  --do "CI finished: fix failures, or merge if green."
wake when npm --package @opencode/client --tag dev --changes --name opencode-client-dev \
  --do "Bump OpenCode and @effect/* to the newly published dev version."

# Run a blocking command and wake when it exits
wake when exits --name gh-watch --do "Inspect the finished run." -- gh run watch 38007696000 --exit-status

# Custom poll when no built-in covers the check
wake poll --every 5m --changes --from PENDING --name deploy-approval \
  --do "Approval decided: continue the rollout if approved." \
  -- 'my-deploy-cli status --json | jq -r ".status"'

wake list                    # open watches with next check and last value
wake show deploy-approval    # full state: last check, last value, failures, delivery
wake logs deploy-approval    # per-check log (-f to follow)
wake cancel deploy-approval
wake status                  # is the daemon running?
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
# GitHub Actions workflow runs and PR checks (adaptive 10–15s polling)
wake when gh-run --repo anomalyco/opencode --workflow publish.yml --sha 41b03dea0f \
  --do "Check the publish conclusion; if green, wait for @opencode/client on npm."
wake when gh-run --repo anomalyco/opencode --pr 54198 --workflow publish.yml --do "…"
wake when gh-run --repo anomalyco/opencode --run 38007696000 --do "…"
wake when pr-checks --repo anomalyco/opencode --pr 54275 --do "Check PR CI results."

# npm package publishes (default 15s polling; reports version and publish timestamp)
wake when npm --package @opencode/client --tag dev --changes --do "…"
wake when npm --package @opencode/client --newer-than 0.0.0-dev-20800 --do "…"
wake when npm --package @opencode/client --published-after 2026-10-10T07:55:00Z --do "…"

# Any command that blocks until an event (re-runs across daemon restarts)
wake when exits --timeout 30m --do "Run finished." -- gh run watch 38007696000 --exit-status

# Run heavy work when the machine has room, one job at a time
wake when capacity --slot heavy --name perf-proofs \
  --do "Capacity granted: run the native and CLI proofs, then wake release."

# Continue when other sessions finish, or when other watches end
wake when idle ses_perf ses_arch --do "Both agents are done: review and push their branches."
wake when done perf-proofs --do "Proofs finished; summarize."
```

| Condition | Holds when |
| --- | --- |
| `gh-run` | the GitHub Actions run (`--run ID`, `--workflow FILE --sha SHA`, or `--pr N [--workflow FILE]` on `--repo OWNER/REPO`) appears and reaches `completed`. Polls every 10s while waiting/queued and 15s while `in_progress`; reports conclusion, failed job names and the run URL. |
| `pr-checks` | every check on `--repo OWNER/REPO --pr N` (or `--required` checks) has finished (`bucket != pending`). Default every 15s; reports pass and fail check names. |
| `npm` | `--package NAME` has a new version on `--tag TAG --changes [--from V]`, a version `--newer-than VERSION`, or a version `--published-after TIME`. Default every 15s; reports version and publish time. |
| `exits` | the blocking command after `--` exits (with any exit code), reporting the exit code and output tail. Re-runs if the daemon restarts while waiting, and respects `--timeout` and `--deadline`. |
| `capacity` | CPU ≤ `--cpu` (70%), at most `--builds` (1) running builds, ≥ `--disk` (20) GB free, continuously for `--stable` (3m). Optional: needs a probe, see below. |
| `idle ses_…` | every listed OpenCode session has finished its run (`time.idle ≥ time.updated`) and stayed idle for `--stable` (2m) |
| `done <watch>…` | every listed watch has ended: fired, expired, failed or cancelled |

An unreadable probe or a missing session is a failed check, never a pass.

`wake when capacity` is a hook for your own load signal. `$WAKE_CAPACITY_COMMAND` must print JSON such as `{"cpu": 40, "builds": 0, "diskGB": 80}`: `cpu` is a recent busy percentage, `builds` the number of heavy jobs running, `diskGB` free space. A portable starting point (macOS and Linux), saved as an executable `~/bin/wake-capacity`:

```sh
#!/bin/sh
cores=$(getconf _NPROCESSORS_ONLN)
load=$(uptime | awk -F'averages?: ' '{ split($2, a, /[, ]+/); print a[1] }')
cpu=$(awk -v l="$load" -v c="$cores" 'BEGIN { p = int(l / c * 100); print (p > 100 ? 100 : p) }')
builds=$(pgrep -f 'cargo build|xcodebuild' | wc -l | tr -d ' ')
disk=$(df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }')
printf '{"cpu": %s, "builds": %s, "diskGB": %s}\n' "$cpu" "$builds" "$disk"
```

Then set `WAKE_CAPACITY_COMMAND=~/bin/wake-capacity` in your shell and in the daemon's environment (plist or unit file). The default, `mac-sim-lease --status`, is the author's own Mac probe.

**Slots** stop several waiters from piling onto the same opening. With `--slot NAME` (on `when` or `poll`), a watch whose condition holds waits for a place in `NAME` before it wakes its session:

- First come, first served: only the oldest waiter in a slot can be granted.
- Each grant restarts the other waiters' `--stable` window, so the next grant sees the CPU after the first job has started.
- A place is held until `wake release <watch>` (or `wake release` for every hold of the calling session), the woken session goes idle after a 2-minute grace period, or `--hold` expires (default 2h, max 12h).
- `heavy` has two places (`$WAKE_HEAVY_SLOT_SIZE`); other slots have one. `wake slot NAME --size N` changes that, and `wake slots` shows holders and queues.

## Foreground waits

A woken session needs to have ended its turn. Agents that cannot do that (a subagent ends when its turn ends) can block instead:

```sh
wake when pr-checks --repo owner/repo --pr 123 --wait      # prints the result; exit 1 unless it fired
wake in 10m --wait                                           # without --do nothing is queued into a session
wake wait ci-123                                             # follow an existing watch
wake run --slot heavy -- cargo build --release               # wait for capacity and a slot place, run, release
```

`--wait` with `--do` also queues the wake as usual. Ctrl-C cancels a watch the waiting process created. If the waiting process dies, the daemon cancels its watch and releases any slot place it held.

## Guarantees and guardrails

- **One wake, then done.** Met, expired and failed watches each send one message and stop.
- **Durable.** Watches live in `~/.local/state/wake/wake.db`. The service starts the daemon at login and restarts it if it dies. After a restart, overdue timers fire once (flagged "late" if more than five minutes late) and overdue polls run one catch-up check, not a backlog.
- **No duplicate wakes.** The wake's text and OpenCode message ID are stored before posting. A retry or restart re-posts the same ID, which OpenCode admits once. Verified against the live server: re-posting a delivered wake returned the original message and created no new user turn.
- **Delivery retries.** If OpenCode is unreachable, delivery retries with backoff (15s doubling to 10m) for 24h. A deleted target session ends the watch as `undeliverable`.
- **Cancellation.** `wake cancel` stops a running poll or `exits` command: SIGTERM to its process group, then SIGKILL after 2s. Stopping the daemon does the same, but leaves the watch active so the command runs again after the restart.
- **Concurrency.** Up to 8 checks and deliveries run at once. Blocking `exits` commands don't count toward that, so they never hold up timers or other checks.
- **Retention.** Ended watches and their logs are deleted 30 days after they end.
- **Limits.** Custom polls check at most every 60s (built-in triggers every 5s at most). Deadline defaults to 48h, max 14 days (also the max timer distance). At most 20 open watches. Per-check timeout defaults to min(interval, 2m), max 10m, and kills the whole process group. After 5 consecutive failed checks (`--failures`), the session is woken with the last error.
- **Messages.** Each wake names the watch, says what changed (`` `old` → `new` ``), repeats the `--do` instruction, and says how to inspect it (`wake show`, `wake logs`). Values are clipped to 300 characters and the instruction to 1500.

## Security

`wake poll` and `wake when exits` store a command that the **daemon** runs later as your user. That happens outside OpenCode's permission prompt, so a blanket shell rule such as `wake *` → allow would let an agent run anything unprompted. Everything else (timers, built-in triggers, `list`, `show`, `logs`, `wait`, `cancel`, `release`, `slots`) never runs a user-supplied command, and refuses one after `--`. `wake run` runs its command immediately, in the calling shell.

For unattended agents, allow only the subcommands that cannot run commands, and leave `wake poll`, `wake when exits` and `wake run` on ask, where the prompt shows the full command:

```jsonc
// opencode.json (V2 permissions); repeat for each safe pattern
"permissions": [
  { "action": "shell", "resource": "wake in *", "effect": "allow" },
  { "action": "shell", "resource": "wake at *", "effect": "allow" },
  { "action": "shell", "resource": "wake when gh-run *", "effect": "allow" },
  { "action": "shell", "resource": "wake when pr-checks *", "effect": "allow" },
  { "action": "shell", "resource": "wake when npm *", "effect": "allow" },
  { "action": "shell", "resource": "wake when capacity *", "effect": "allow" },
  { "action": "shell", "resource": "wake when idle *", "effect": "allow" },
  { "action": "shell", "resource": "wake when done *", "effect": "allow" },
  { "action": "shell", "resource": "wake wait *", "effect": "allow" },
  { "action": "shell", "resource": "wake list*", "effect": "allow" },
  { "action": "shell", "resource": "wake show *", "effect": "allow" },
  { "action": "shell", "resource": "wake logs *", "effect": "allow" },
  { "action": "shell", "resource": "wake cancel *", "effect": "allow" },
  { "action": "shell", "resource": "wake release*", "effect": "allow" }
]
```

- **No shell is not the boundary.** A single argument after `--` runs through `/bin/sh -c`; several run as argv. Requiring argv would not narrow anything (`-- sh -c '…'` is still argv), so wake keeps the shell form and relies on the permission rule above.
- **Disable commands entirely** with `WAKE_ALLOW_EXEC=0` in the daemon's environment (the plist's `EnvironmentVariables`). The daemon then fails command watches with an explanation instead of running them, and the CLI refuses to create them when the variable is set in its own environment. Timers and built-in triggers keep working.
- **Prompts.** `--do` text, and `--session` to target another session, let anyone who can run `wake` queue a prompt into a session. Treat allowing it like allowing an agent to message that session.
- **Audit.** Each watch records the creating session (`createdBy`), the directory and the exact command; `wake show` and `wake logs` display them.
- **Environment.** Commands run in the directory where the watch was created, with the daemon's environment (the plist's `HOME` and `PATH`) plus the `PATH` captured at creation. They do not get the creating shell's other variables, so a command that needs a token should fetch it itself (keychain, `op read`, a CLI's own login), not inline it. The command is stored in the database; don't put secrets in it.
- **Private state.** The state directory, database and logs are owner-only (`0700`/`0600`; the daemon runs with umask `077`). Logs record values and error lines, clipped and passed through best-effort redaction of common token shapes (`Bearer …`, `ghp_…`, `npm_…`, `sk-…`, `xox…-…`, JWTs, URL credentials, `token=…`). The environment is never logged.
- **Untrusted values.** Values observed from GitHub, npm or a command (check names, output) are wrapped in backticks in the wake message (with backticks and newlines neutralized), apart from the `Next:` instruction. A hostile check name can still say anything, so treat quoted values as data.

## Install

```bash
git clone https://github.com/kitlangton/wake.git
cd wake && bun install && bun link        # puts `wake` on PATH (~/.bun/bin)
```

**macOS (launchd):**

```bash
wake launchd > ~/Library/LaunchAgents/dev.kitlangton.wake.plist   # --label or $WAKE_LABEL to rename
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.kitlangton.wake.plist
wake status
```

Uninstall: `launchctl bootout gui/$(id -u)/dev.kitlangton.wake`, then remove the plist. After updating the code, restart it with `launchctl kickstart -k gui/$(id -u)/dev.kitlangton.wake`.

**Linux (systemd user service):** save as `~/.config/systemd/user/wake.service`, adjusting the paths:

```ini
[Unit]
Description=wake daemon

[Service]
ExecStart=%h/.bun/bin/bun %h/code/wake/src/cli.ts daemon
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
UMask=0077
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now wake
loginctl enable-linger "$USER"   # keep it running when you are logged out
```

Daemon output goes to `~/.local/state/wake/daemon.log` on macOS and to `journalctl --user -u wake` on Linux.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_SESSION_ID` | *(set by OpenCode)* | Default target session when `--session` is omitted |
| `WAKE_HOME` | `~/.local/state/wake` | State directory (`wake.db`, `daemon.pid`, `daemon.log`, `logs/`) |
| `WAKE_OPENCODE` | `opencode` | Path or name of the `opencode` CLI binary |
| `WAKE_GH` | `gh` | Path or name of the GitHub CLI binary |
| `WAKE_NPM` | `npm` | Path or name of the `npm` CLI binary |
| `WAKE_CAPACITY_COMMAND` | `mac-sim-lease --status` | Command probed by `wake when capacity` (JSON, see above) |
| `WAKE_HEAVY_SLOT_SIZE` | `2` | Default concurrency limit for the `heavy` slot |
| `WAKE_LABEL` | `dev.kitlangton.wake` | Default LaunchAgent label for `wake launchd` |
| `WAKE_ALLOW_EXEC` | `1` | `0` stops the daemon (and CLI) from running `wake poll` / `wake when exits` commands |

## Why a daemon and not an OpenCode plugin

A V2 plugin can register a tool that sees the calling session's ID, and it can post prompts through `ctx.session.prompt`. It cannot host durable background polling:

- Plugins are instantiated per location (`packages/core/src/plugin/supervisor.ts` is a location node). A global plugin runs once per active directory, so an in-plugin poller would run several times over unless it coordinated through a lock.
- Idle locations are evicted after 60 minutes without session activity (`location-activity.ts`), which tears down their plugins. Waiting for something for hours is exactly that idle case.
- After a server restart, a location's plugins load only when something touches that location again, so pending watches would not resume on their own.
- Polling inside the shared service also ties watch commands to that service's environment and lifetime, and restarting it to deploy plugin changes interrupts everyone's sessions.

The CLI loses little: `$OPENCODE_SESSION_ID` already gives the creating session, and shell permissions already gate it. A thin plugin that exposes `wake_*` tools by writing to the same database could come later, for agents without shell access.

## Development

```bash
bun run test      # engine, built-ins, cancellation, foreground waits, units, and real-daemon tests
bun run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
