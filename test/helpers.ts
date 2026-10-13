import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunResult } from "../src/condition.ts"
import { Engine, type Delivery, type DeliveryResult, type EngineDeps } from "../src/engine.ts"
import { ensureStateDirectory, Store } from "../src/store.ts"
import { messageID } from "../src/system.ts"
import type { Watch } from "../src/watch.ts"

export const SESSION = "ses_testTarget123"

export function tempRoot() {
  return ensureStateDirectory(mkdtempSync(join(tmpdir(), "wake-test-")))
}

/** Behaves like OpenCode's inbox: the first admission of a message ID wins, retries are no-ops. */
export class FakeOpenCode {
  readonly messages = new Map<string, Delivery>()
  readonly attempts: Delivery[] = []
  /** Next results to return, in order. "crash" admits the message and then throws, like a killed daemon. */
  script: ("ok" | "down" | "missing" | "crash")[] = []

  deliver = async (delivery: Delivery): Promise<DeliveryResult> => {
    this.attempts.push(delivery)
    const step = this.script.shift() ?? "ok"
    if (step === "down") return { ok: false, permanent: false, error: "connection refused" }
    if (step === "missing") return { ok: false, permanent: true, error: "SessionNotFoundError" }
    if (!this.messages.has(delivery.messageID)) this.messages.set(delivery.messageID, delivery)
    if (step === "crash") throw new Error("daemon killed after the server admitted the wake")
    return { ok: true }
  }

  get texts() {
    return [...this.messages.values()].map((message) => message.text)
  }
}

export const ok = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: "", timedOut: false })

export class Harness {
  now = Date.UTC(2026, 9, 9, 18, 0, 0)
  readonly server = new FakeOpenCode()
  readonly runs: Watch[] = []
  readonly probes: (readonly string[])[] = []
  readonly logs: string[] = []
  results: RunResult[] = []
  probeResults: RunResult[] = []
  /** The capacity summary the probe prints, as `mac-sim-lease --status` would. */
  capacity = capacityLine(50, 0, 60)
  readonly sessions = new Map<string, "idle" | "busy" | "missing">()
  /** Replaces the scripted results, e.g. to run a real command or hold a check open. */
  runner: ((watch: Watch, signal?: AbortSignal) => Promise<RunResult>) | undefined
  readonly deadPIDs = new Set<number>()
  readonly options: Partial<EngineDeps> = {}
  store: Store
  engine: Engine

  constructor(readonly root = tempRoot()) {
    this.store = new Store(root)
    this.engine = this.makeEngine()
  }

  makeEngine() {
    return new Engine({
      store: this.store,
      now: () => this.now,
      run: async (watch, signal) => {
        this.runs.push(watch)
        if (this.runner) return this.runner(watch, signal)
        return this.results.shift() ?? ok("")
      },
      deliver: (delivery) => this.server.deliver(delivery),
      newMessageID: messageID,
      log: (id, line) => this.logs.push(`${id} ${line}`),
      builtin: {
        capacity: async () => ok(this.capacity),
        sessionState: async (session) => this.sessions.get(session) ?? "busy",
        watchStatus: (ref) => this.store.find(ref)?.status,
        exec: async (argv) => {
          this.probes.push(argv)
          return this.probeResults.shift() ?? ok("")
        },
      },
      processAlive: (pid) => !this.deadPIDs.has(pid),
      ...this.options,
    })
  }

  /** Simulate a daemon restart: a fresh store handle and engine over the same files. */
  restart() {
    this.store.close()
    this.store = new Store(this.root)
    this.engine = this.makeEngine()
  }

  advance(ms: number) {
    this.now += ms
  }

  async tick() {
    await this.engine.tick()
  }

  get(id: string) {
    return this.store.get(id)!
  }
}

export const capacityLine = (cpu: number | "", builds: number, diskGB: number) =>
  `cpu ${cpu}% busy (gate 70%) | load 12.3 | memory normal | disk ${diskGB} GB free (floor 15) | sims booted 0 | xcodebuild ${builds} | kit away, 2 leases (idle 900s)`
