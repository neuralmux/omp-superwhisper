#!/usr/bin/env bun
/**
 * superwhisper-bridge — HTTP daemon that runs on the macOS host.
 *
 * It acts as a proxy between OMP extensions running inside devcontainers (or
 * any other isolated environment) and the Superwhisper macOS app. The daemon
 * manages the inbox, message/response files, and deeplink wakes on the host
 * filesystem so the containerized extension doesn't need host access.
 *
 * Usage:
 *   bun run bin/superwhisper-bridge.ts [--port PORT]
 *
 * Environment:
 *   SUPERWHISPER_BRIDGE_PORT  – port to listen on (default: 19550)
 *   SUPERWHISPER_BRIDGE_HOST  – bind address   (default: 127.0.0.1)
 *   SUPERWHISPER_SCHEME       – override scheme (default: auto-detect)
 *   SUPERWHISPER_DEBUG        – enable debug logging
 *
 * API:
 *   GET  /health                                     → { running, scheme, version }
 *   POST /inbox            body: InboxPayload (JSON)  → { ok: bool }
 *   GET  /session/:id/message                         → 200 text/plain | 404
 *   PUT  /session/:id/message   body: text            → 204
 *   DELETE /session/:id/message                       → 204
 *   GET  /session/:id/response?timeout=MS             → 200 { kind, text? } | 408
 *   DELETE /session/:id/response                      → 204
 *   GET  /session/:id/disabled                        → { disabled: bool }
 *   PUT  /session/:id/disabled                        → 204 (set disabled)
 *   DELETE /session/:id/disabled                      → 204 (clear disabled)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { $ } from "bun"

// Re-use the existing extension modules for inbox and polling logic.
import type { InboxPayload } from "../extensions/inbox"
import { deliverAgentPayload } from "../extensions/inbox"
import { waitForResponse } from "../extensions/poll"
import { MESSAGE_DIR } from "../extensions/constants"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SUPERWHISPER_BRIDGE_PORT || "19550", 10)
const HOST = process.env.SUPERWHISPER_BRIDGE_HOST || "127.0.0.1"
const DEBUG = !!process.env.SUPERWHISPER_DEBUG
const VERSION = "1.0.0"

function debugLog(level: string, msg: string) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] [${level}] [superwhisper-bridge] ${msg}\n`)
}

// ---------------------------------------------------------------------------
// Scheme detection
// ---------------------------------------------------------------------------

let cachedScheme: string | null = process.env.SUPERWHISPER_SCHEME || null

async function detectScheme(): Promise<string> {
  if (cachedScheme) return cachedScheme
  try {
    await $`pgrep -f DerivedData.*superwhisper.app`.quiet()
    cachedScheme = "superwhisper-debug"
  } catch {
    cachedScheme = "superwhisper"
  }
  return cachedScheme
}

async function checkRunning(): Promise<boolean> {
  try {
    await $`pgrep -x superwhisper`.quiet()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function messagePath(sessionId: string) {
  return `${MESSAGE_DIR}/${sessionId}-message.txt`
}
function responsePath(sessionId: string) {
  return `${MESSAGE_DIR}/${sessionId}-response.txt`
}
function disabledPath(sessionId: string) {
  return `${MESSAGE_DIR}/disabled-${sessionId}`
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  }
}

function extractSessionId(url: URL): string | null {
  // /session/<id>/(message|response|disabled)
  const m = url.pathname.match(/^\/session\/([^/]+)\/(message|response|disabled)/)
  return m ? decodeURIComponent(m[1]) : null
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const method = req.method.toUpperCase()

  debugLog("info", `${method} ${url.pathname}${url.search}`)

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  try {
    // ---- /health ----
    if (url.pathname === "/health" && method === "GET") {
      const scheme = await detectScheme()
      const running = await checkRunning()
      return jsonResponse({ running, scheme, version: VERSION })
    }

    // ---- /inbox ----
    if (url.pathname === "/inbox" && method === "POST") {
      let payload: InboxPayload
      try {
        payload = await req.json()
      } catch {
        return jsonResponse({ error: "invalid JSON" }, 400)
      }
      const scheme = await detectScheme()
      // Override hookPid with the bridge's own PID so Superwhisper can
      // validate it against running host processes. Container PIDs would
      // otherwise be silently rejected.
      payload.hookPid = process.pid
      const ok = await deliverAgentPayload(payload, scheme)
      return jsonResponse({ ok }, ok ? 200 : 500)
    }

    // ---- /session/:id/message ----
    const sessionId = extractSessionId(url)
    if (sessionId && url.pathname.endsWith("/message")) {
      mkdirSync(MESSAGE_DIR, { recursive: true })

      if (method === "GET") {
        try {
          const content = readFileSync(messagePath(sessionId), "utf8")
          return textResponse(content)
        } catch {
          return jsonResponse({ error: "not found" }, 404)
        }
      }

      if (method === "PUT") {
        const body = await req.text()
        writeFileSync(messagePath(sessionId), body)
        return emptyResponse()
      }

      if (method === "DELETE") {
        try { unlinkSync(messagePath(sessionId)) } catch {}
        return emptyResponse()
      }
    }

    // ---- /session/:id/response ----
    if (sessionId && url.pathname.endsWith("/response")) {
      mkdirSync(MESSAGE_DIR, { recursive: true })

      if (method === "GET") {
        const timeoutParam = url.searchParams.get("timeout")
        const timeoutMs = timeoutParam ? parseInt(timeoutParam, 10) : 1_800_000

        const rp = responsePath(sessionId)

        // Long-poll: waitForResponse handles fs.watch + interval internally.
        const result = await waitForResponse(rp, {
          timeoutMs,
          signal: undefined,
        })

        return jsonResponse(result)
      }

      if (method === "DELETE") {
        try { unlinkSync(responsePath(sessionId)) } catch {}
        return emptyResponse()
      }
    }

    // ---- /session/:id/disabled ----
    if (sessionId && url.pathname.endsWith("/disabled")) {
      mkdirSync(MESSAGE_DIR, { recursive: true })

      if (method === "GET") {
        return jsonResponse({ disabled: existsSync(disabledPath(sessionId)) })
      }

      if (method === "PUT") {
        writeFileSync(disabledPath(sessionId), "")
        return emptyResponse()
      }

      if (method === "DELETE") {
        try { unlinkSync(disabledPath(sessionId)) } catch {}
        return emptyResponse()
      }
    }

    // ---- 404 ----
    return jsonResponse({ error: "not found" }, 404)
  } catch (err) {
    debugLog("error", `Request failed: ${err}`)
    return jsonResponse({ error: "internal server error" }, 500)
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

mkdirSync(MESSAGE_DIR, { recursive: true })

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const res = handleRequest(req)
    // Attach CORS headers to every response
    return res.then((r) => {
      for (const [k, v] of Object.entries(corsHeaders())) {
        r.headers.set(k, v)
      }
      return r
    })
  },
})

console.log(`superwhisper-bridge v${VERSION} listening on http://${HOST}:${PORT}`)
console.log(`Health check: http://${HOST}:${PORT}/health`)
console.log(`Message dir:  ${MESSAGE_DIR}`)
if (process.env.SUPERWHISPER_BRIDGE_URL) {
  console.log(`⚠  SUPERWHISPER_BRIDGE_URL is set — this daemon should NOT be run with that variable.`)
}

// Graceful shutdown
process.on("SIGINT", () => {
  debugLog("info", "Shutting down...")
  server.stop()
  process.exit(0)
})
process.on("SIGTERM", () => {
  debugLog("info", "Shutting down...")
  server.stop()
  process.exit(0)
})
