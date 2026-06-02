import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

export interface InboxPayload {
  kind: "update" | "dismiss"
  sessionId?: string
  requestId?: string
  agent?: string
  status?: string
  summary?: string
  message?: string
  messageFile?: string
  responseFile?: string
  cwd?: string
  project?: string
  branch?: string
  title?: string
  hookPid?: number
}

let INBOX_DIR = join(
  homedir(),
  "Library/Application Support/superwhisper/agent/inbox",
)

export function __setInboxDirForTest(dir: string): void {
  INBOX_DIR = dir
}

export function writeInboxPayload(payload: InboxPayload): boolean {
  try {
    mkdirSync(INBOX_DIR, { recursive: true })
  } catch {
    return false
  }

  const id = crypto.randomUUID()
  const tmpPath = join(INBOX_DIR, `${id}.json.tmp`)
  const finalPath = join(INBOX_DIR, `${id}.json`)

  try {
    writeFileSync(tmpPath, JSON.stringify(payload))
    renameSync(tmpPath, finalPath)
    return true
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {}
    return false
  }
}

export async function isSuperwhisperRunning(): Promise<boolean> {
  try {
    await $`pgrep -x superwhisper`.quiet()
    return true
  } catch {
    return false
  }
}

export async function fireAgentWake(scheme: string): Promise<void> {
  const url = `${scheme}://agent-wake`
  try {
    await $`open ${url}`.quiet()
  } catch {
    // wake is best-effort
  }
}

export async function deliverAgentPayload(
  payload: InboxPayload,
  scheme: string,
): Promise<boolean> {
  const wrote = writeInboxPayload(payload)
  const running = await isSuperwhisperRunning()
  if (!running) {
    await fireAgentWake(scheme)
  }
  return wrote
}
