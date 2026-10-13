import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tests must never reach the real state directory (or its pre-rename location), even by a default.
process.env.HOME = mkdtempSync(join(tmpdir(), "skulk-home-"))
delete process.env.SKULK_HOME
delete process.env.WAKE_HOME
