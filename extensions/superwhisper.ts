import { appendFileSync } from "node:fs"
import { basename } from "node:path"
import { $ } from "bun"
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent"

import { LOG_PREFIX, MESSAGE_DIR } from "./constants"
import {
  extractLastAssistantText,
  getLastAssistant,
  isEndTurn,
  extractSummary,
} from "./message"
import { getHostOps, type HostOps } from "./host"

async function getGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const result = await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.quiet()
    const trimmed = result.text().trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

export default async function superwhisperExtension(pi: ExtensionAPI): Promise<void> {
  const host: HostOps = getHostOps()
  const { scheme } = await host.detect()

  const DEBUG = !!process.env.SUPERWHISPER_DEBUG
  const LOG_FILE = `${MESSAGE_DIR}/debug.log`

  function log(level: "debug" | "info" | "warn" | "error", message: string) {
    if (!DEBUG) return
    try {
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] [${level}] ${LOG_PREFIX} ${message}\n`,
      )
    } catch {}
  }

  // --- Session id ---

  // Derived from the session file path so it survives reloads/forks and stays
  // consistent across separate runs that resume the same session. Falls back
  // to a pid-based id only when a session file hasn't been bound yet.
  function deriveSessionId(ctx: ExtensionContext): string {
    // OMP's sessionManager may expose the session file path; fall back to pid
    const sm = ctx.sessionManager as any
    const file = typeof sm.getSessionFile === "function" ? sm.getSessionFile() : undefined
    if (file) return basename(file).replace(/[^a-zA-Z0-9_.-]/g, "_")
    return `omp-${process.pid}`
  }

  // --- State ---

  const activePolls = new Map<string, AbortController>()

  // Sessions explicitly disabled via the toggle tool / slash command.
  // We cache in-process to avoid unnecessary bridge round-trips.
  const disabledSessions = new Set<string>()

  async function isSessionDisabled(sessionId: string): Promise<boolean> {
    if (disabledSessions.has(sessionId)) return true
    return host.isSessionDisabled(sessionId)
  }

  async function disableSession(sessionId: string): Promise<void> {
    disabledSessions.add(sessionId)
    try {
      await host.setSessionDisabled(sessionId, true)
    } catch (err) {
      log("error", `Failed to set disabled flag for session=${sessionId}: ${err}`)
    }
  }

  async function enableSession(sessionId: string): Promise<void> {
    disabledSessions.delete(sessionId)
    try {
      await host.setSessionDisabled(sessionId, false)
    } catch (err) {
      log("error", `Failed to remove disabled flag for session=${sessionId}: ${err}`)
    }
  }

  function cancelPoll(sessionId: string, source: string): boolean {
    const ctrl = activePolls.get(sessionId)
    if (ctrl) {
      ctrl.abort()
      activePolls.delete(sessionId)
      log("debug", `Poll cancelled for session=${sessionId} (${source})`)
      return true
    }
    return false
  }

  function sendDismiss(sessionId: string, source: string) {
    log("debug", `Sending dismiss via inbox (${source}) for session=${sessionId}`)
    host.deliverPayload({ kind: "dismiss", sessionId }, scheme).catch((err) => {
      log("error", `Failed to send dismiss for session=${sessionId}: ${err}`)
    })
  }

  // --- Notification ---

  type NotifyOutcome =
    | { kind: "response"; text: string }
    | { kind: "empty" }
    | { kind: "cancelled" }
    | { kind: "timeout" }

  async function sendNotification(params: {
    sessionId: string
    status: string
    summary: string
    messageContent: string
    cwd: string
    title?: string
  }): Promise<NotifyOutcome> {
    const { sessionId, status, summary, messageContent, cwd, title } = params

    cancelPoll(sessionId, "new-notification")

    try {
      await host.writeMessage(sessionId, messageContent)
    } catch (err) {
      log("error", `Failed to write message file for session=${sessionId}: ${err}`)
      return { kind: "timeout" }
    }

    // Remove any stale response file before sending the new notification
    try {
      await host.deleteResponse(sessionId)
    } catch {}

    const branch = await getGitBranch(cwd)
    const projectName = basename(cwd) || "omp"

    try {
      await host.deliverPayload(
        {
          kind: "update",
          agent: "omp",
          status,
          sessionId,
          summary,
          messageFile: `${MESSAGE_DIR}/${sessionId}-message.txt`,
          responseFile: `${MESSAGE_DIR}/${sessionId}-response.txt`,
          cwd,
          project: projectName,
          branch,
          title,
          hookPid: process.pid,
        },
        scheme,
      )
    } catch (err) {
      log("error", `Failed to deliver Superwhisper payload — ${err}`)
      return { kind: "timeout" }
    }

    log("info", `Notification sent: status=${status} session=${sessionId}`)

    const ctrl = new AbortController()
    activePolls.set(sessionId, ctrl)

    const result = await host.waitForResponse(sessionId, ctrl.signal)

    if (activePolls.get(sessionId) === ctrl) activePolls.delete(sessionId)

    try {
      await host.deleteResponse(sessionId)
      await host.deleteMessage(sessionId)
    } catch {}

    return result
  }

  // --- Event handlers ---

  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    // A new turn started — any prior notification poll is stale. Kill it so
    // we don't re-inject an old voice response into this fresh turn.
    const sessionId = deriveSessionId(ctx)
    cancelPoll(sessionId, "agent_start")
  })

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    const sessionId = deriveSessionId(ctx)
    const cwd = ctx.cwd

    if (await isSessionDisabled(sessionId)) {
      log("debug", `Skipping agent_end for session=${sessionId} (disabled)`)
      return
    }

    const messages = event.messages ?? []
    const lastAssistant = getLastAssistant(messages)
    const fullMessage = extractLastAssistantText(messages)

    if (!fullMessage) {
      log("info", `Skipping empty completion for session=${sessionId}`)
      return
    }

    if (!isEndTurn(lastAssistant)) {
      log(
        "info",
        `Skipping non-end-turn agent_end for session=${sessionId} (stopReason=${lastAssistant?.stopReason})`,
      )
      return
    }

    const summary = extractSummary(fullMessage)
    const title = ctx.sessionManager.getSessionName?.() as string | undefined

    const outcome = await sendNotification({
      sessionId,
      status: "completed",
      summary,
      messageContent: fullMessage,
      cwd,
      title,
    })

    switch (outcome.kind) {
      case "response":
        try {
          pi.sendUserMessage(outcome.text)
          log("info", `Voice response sent back to omp for session=${sessionId}`)
        } catch (err) {
          log("error", `Failed to sendUserMessage: ${err}`)
        }
        return
      case "empty":
        log("info", `User dismissed notification for session=${sessionId}`)
        return
      case "cancelled":
        log("info", `Notification cancelled for session=${sessionId}`)
        return
      case "timeout":
        log("info", `Poll timed out for session=${sessionId}`)
        sendDismiss(sessionId, "completed-timeout")
        return
    }
  })

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    const sessionId = deriveSessionId(ctx)
    log("info", `session_shutdown for session=${sessionId}`)
    if (cancelPoll(sessionId, "session_shutdown")) {
      sendDismiss(sessionId, "session_shutdown")
    }
  })

  // --- Tool ---

  const { z } = pi.zod

  pi.registerTool({
    name: "superwhisper_toggle",
    label: "Superwhisper",
    description:
      "Enable or disable Superwhisper voice notifications for this session. " +
      "Use action='disable' when the user wants to turn Superwhisper off, " +
      "and action='enable' when they want to turn it back on.",
    parameters: z.object({
      action: z.enum(["enable", "disable"]),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = deriveSessionId(ctx)
      if (params.action === "disable") {
        await disableSession(sessionId)
        log("info", `Superwhisper disabled for session=${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: "Superwhisper voice notifications disabled for this session.",
            },
          ],
          details: undefined,
          isError: false,
        }
      } else {
        await enableSession(sessionId)
        log("info", `Superwhisper re-enabled for session=${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: "Superwhisper voice notifications re-enabled for this session.",
            },
          ],
          details: undefined,
          isError: false,
        }
      }
    },
  })

  // --- Slash command ---

  pi.registerCommand("superwhisper", {
    description: "Enable, disable, or test Superwhisper voice notifications for this session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = deriveSessionId(ctx)
      const action = args.trim().toLowerCase()

      if (action === "off" || action === "disable") {
        await disableSession(sessionId)
        ctx.ui.notify("Superwhisper disabled for this session", "info")
        return
      }
      if (action === "on" || action === "enable") {
        await enableSession(sessionId)
        ctx.ui.notify("Superwhisper enabled for this session", "info")
        return
      }
      if (action === "test") {
        const summary = "OMP Superwhisper test"
        const message = "This is an OMP Superwhisper test notification."
        ctx.ui.notify("Sent Superwhisper test notification", "info")
        sendNotification({
          sessionId,
          status: "completed",
          summary,
          messageContent: message,
          cwd: ctx.cwd,
          title: ctx.sessionManager.getSessionName?.() as string | undefined,
        })
          .then((outcome) => {
            log("info", `Test notification outcome: ${outcome.kind}`)
            if (outcome.kind === "response") {
              try {
                pi.sendUserMessage(outcome.text)
              } catch (err) {
                log("error", `Failed to sendUserMessage: ${err}`)
              }
            }
          })
          .catch((err) => log("error", `Test notification failed: ${err}`))
        return
      }
      if (action === "" || action === "status") {
        const disabled = await isSessionDisabled(sessionId)
        ctx.ui.notify(
          `Superwhisper is ${disabled ? "disabled" : "enabled"} for this session. Usage: /superwhisper [on|off|test|status]`,
          "info",
        )
        return
      }
      ctx.ui.notify("Usage: /superwhisper [on|off|test|status]", "info")
    },
  })
}
