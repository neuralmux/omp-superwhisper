/**
 * HostOps — abstraction over host-specific Superwhisper operations.
 *
 * Two implementations:
 *   DirectHostOps  – runs on macOS, talks to Superwhisper via filesystem + open
 *   BridgeHostOps  – runs inside a container, proxies to a host daemon via HTTP
 *
 * Selection is automatic:
 *   - If SUPERWHISPER_BRIDGE_URL is set → BridgeHostOps
 *   - Otherwise → DirectHostOps
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { $ } from "bun"
import type { InboxPayload } from "./inbox"
import { deliverAgentPayload } from "./inbox"
import { waitForResponse, type WaitResult } from "./poll"
import { MESSAGE_DIR } from "./constants"

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HostOps {
  /** Detect the Superwhisper deeplink scheme and whether the app is running. */
  detect(): Promise<{ scheme: string; running: boolean }>

  /** Deliver an inbox payload (update or dismiss). */
  deliverPayload(payload: InboxPayload, scheme: string): Promise<boolean>

  /** Write per-session message file. */
  writeMessage(sessionId: string, content: string): Promise<void>

  /** Read per-session message file; null if missing. */
  readMessage(sessionId: string): Promise<string | null>

  /** Remove per-session message file. */
  deleteMessage(sessionId: string): Promise<void>

  /**
   * Wait for Superwhisper to write a response file.
   * Returns { kind: "response", text } | { kind: "empty" } |
   *         { kind: "timeout" } | { kind: "cancelled" }
   */
  waitForResponse(sessionId: string, signal?: AbortSignal): Promise<WaitResult>

  /** Remove per-session response file. */
  deleteResponse(sessionId: string): Promise<void>

  /** Is this session disabled for Superwhisper notifications? */
  isSessionDisabled(sessionId: string): Promise<boolean>

  /** Enable or disable Superwhisper for this session. */
  setSessionDisabled(sessionId: string, disabled: boolean): Promise<void>
}

// ---------------------------------------------------------------------------
// Direct (on-host) implementation
// ---------------------------------------------------------------------------

class DirectHostOps implements HostOps {
  private scheme: string | null = null

  async detect(): Promise<{ scheme: string; running: boolean }> {
    const envScheme = process.env.SUPERWHISPER_SCHEME
    if (envScheme) {
      this.scheme = envScheme
    } else if (!this.scheme) {
      try {
        await $`pgrep -f DerivedData.*superwhisper.app`.quiet()
        this.scheme = "superwhisper-debug"
      } catch {
        this.scheme = "superwhisper"
      }
    }
    const running = await this.checkRunning()
    return { scheme: this.scheme, running }
  }

  private async checkRunning(): Promise<boolean> {
    try {
      await $`pgrep -x superwhisper`.quiet()
      return true
    } catch {
      return false
    }
  }

  async deliverPayload(payload: InboxPayload, scheme: string): Promise<boolean> {
    return deliverAgentPayload(payload, scheme)
  }

  async writeMessage(sessionId: string, content: string): Promise<void> {
    mkdirSync(MESSAGE_DIR, { recursive: true })
    writeFileSync(`${MESSAGE_DIR}/${sessionId}-message.txt`, content)
  }

  async readMessage(sessionId: string): Promise<string | null> {
    try {
      return readFileSync(`${MESSAGE_DIR}/${sessionId}-message.txt`, "utf8")
    } catch {
      return null
    }
  }

  async deleteMessage(sessionId: string): Promise<void> {
    try { unlinkSync(`${MESSAGE_DIR}/${sessionId}-message.txt`) } catch {}
  }

  async waitForResponse(sessionId: string, signal?: AbortSignal): Promise<WaitResult> {
    const path = `${MESSAGE_DIR}/${sessionId}-response.txt`
    return waitForResponse(path, { signal })
  }

  async deleteResponse(sessionId: string): Promise<void> {
    try { unlinkSync(`${MESSAGE_DIR}/${sessionId}-response.txt`) } catch {}
  }

  async isSessionDisabled(sessionId: string): Promise<boolean> {
    return existsSync(`${MESSAGE_DIR}/disabled-${sessionId}`)
  }

  async setSessionDisabled(sessionId: string, disabled: boolean): Promise<void> {
    mkdirSync(MESSAGE_DIR, { recursive: true })
    const flag = `${MESSAGE_DIR}/disabled-${sessionId}`
    if (disabled) {
      writeFileSync(flag, "")
    } else {
      try { unlinkSync(flag) } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge (container → host daemon) implementation
// ---------------------------------------------------------------------------

class BridgeHostOps implements HostOps {
  private url: string
  private cachedScheme: string | null = null

  constructor(bridgeUrl: string) {
    this.url = bridgeUrl.replace(/\/+$/, "")
  }

  async detect(): Promise<{ scheme: string; running: boolean }> {
    const res = await fetch(`${this.url}/health`)
    const data = await res.json() as { scheme: string; running: boolean }
    this.cachedScheme = data.scheme
    return { scheme: data.scheme, running: data.running }
  }

  async deliverPayload(payload: InboxPayload, _scheme: string): Promise<boolean> {
    const res = await fetch(`${this.url}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = await res.json() as { ok: boolean }
    return data.ok === true
  }

  async writeMessage(sessionId: string, content: string): Promise<void> {
    await fetch(`${this.url}/session/${encodeURIComponent(sessionId)}/message`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: content,
    })
  }

  async readMessage(sessionId: string): Promise<string | null> {
    const res = await fetch(
      `${this.url}/session/${encodeURIComponent(sessionId)}/message`,
    )
    return res.status === 200 ? await res.text() : null
  }

  async deleteMessage(sessionId: string): Promise<void> {
    await fetch(`${this.url}/session/${encodeURIComponent(sessionId)}/message`, {
      method: "DELETE",
    })
  }

  async waitForResponse(sessionId: string, signal?: AbortSignal): Promise<WaitResult> {
    const res = await fetch(
      `${this.url}/session/${encodeURIComponent(sessionId)}/response?timeout=1800000`,
      { signal },
    )
    return (await res.json()) as WaitResult
  }

  async deleteResponse(sessionId: string): Promise<void> {
    await fetch(`${this.url}/session/${encodeURIComponent(sessionId)}/response`, {
      method: "DELETE",
    })
  }

  async isSessionDisabled(sessionId: string): Promise<boolean> {
    const res = await fetch(
      `${this.url}/session/${encodeURIComponent(sessionId)}/disabled`,
    )
    const data = await res.json() as { disabled: boolean }
    return data.disabled === true
  }

  async setSessionDisabled(sessionId: string, disabled: boolean): Promise<void> {
    await fetch(
      `${this.url}/session/${encodeURIComponent(sessionId)}/disabled`,
      { method: disabled ? "PUT" : "DELETE" },
    )
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _hostOps: HostOps | null = null

export function createHostOps(): HostOps {
  const bridgeUrl = process.env.SUPERWHISPER_BRIDGE_URL
  if (bridgeUrl) {
    return new BridgeHostOps(bridgeUrl)
  }
  return new DirectHostOps()
}

/** Singleton accessor — creates on first call, returns cached thereafter. */
export function getHostOps(): HostOps {
  if (!_hostOps) _hostOps = createHostOps()
  return _hostOps
}

/** Reset singleton (useful for testing). */
export function __resetHostOpsForTest(): void {
  _hostOps = null
}
