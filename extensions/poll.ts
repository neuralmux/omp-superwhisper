import { existsSync, readFileSync, watch } from "node:fs"
import { dirname, basename } from "node:path"
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./constants"

export type WaitResult =
  | { kind: "response"; text: string }
  | { kind: "empty" }
  | { kind: "cancelled" }
  | { kind: "timeout" }

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
}

const EMPTY_GRACE_MS = 2_000

/**
 * Wait for a response file to appear and contain text. Uses `fs.watch` on the
 * parent directory so it reacts within milliseconds, with a periodic fallback
 * for filesystems where watch events are flaky.
 *
 * - File missing for the full timeout → `timeout`
 * - File created and stays empty for EMPTY_GRACE_MS → `empty` (Superwhisper X / double-ESC)
 * - File created with text → `response`
 * - `signal` aborts → `cancelled`
 *
 * The grace period prevents a race where Superwhisper creates an empty
 * placeholder file before writing the transcription.
 */
export function waitForResponse(
  path: string,
  options: WaitOptions = {},
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const { signal } = options

  const dir = dirname(path)
  const file = basename(path)

  function tryReadText(): string | null {
    try {
      if (!existsSync(path)) return null
      const raw = readFileSync(path, "utf8")
      return raw
    } catch {
      return null
    }
  }

  return new Promise<WaitResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "cancelled" })
      return
    }

    let settled = false
    let watcher: ReturnType<typeof watch> | undefined
    let intervalId: ReturnType<typeof setInterval> | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    let emptySeenAt: number | null = null

    const finish = (result: WaitResult) => {
      if (settled) return
      settled = true
      try {
        watcher?.close()
      } catch {}
      if (intervalId) clearInterval(intervalId)
      if (timeoutId) clearTimeout(timeoutId)
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler)
      resolve(result)
    }

    const check = () => {
      if (settled) return
      const text = tryReadText()
      if (text === null) {
        emptySeenAt = null
        return
      }
      const trimmed = text.trim()
      if (trimmed.length > 0) {
        finish({ kind: "response", text: trimmed })
        return
      }
      if (emptySeenAt === null) {
        emptySeenAt = Date.now()
      } else if (Date.now() - emptySeenAt >= EMPTY_GRACE_MS) {
        finish({ kind: "empty" })
      }
    }

    check()

    try {
      watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename === file) check()
      })
    } catch {
      // dir missing or watch unsupported — interval is enough
    }

    intervalId = setInterval(check, intervalMs)
    timeoutId = setTimeout(() => finish({ kind: "timeout" }), timeoutMs)

    if (signal) {
      abortHandler = () => finish({ kind: "cancelled" })
      signal.addEventListener("abort", abortHandler, { once: true })
    }
  })
}
