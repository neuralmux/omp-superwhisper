#!/usr/bin/env bun
/**
 * install-bridge-service — installs the superwhisper-bridge launchd service.
 *
 * Usage:
 *   bun run bin/install-bridge-service.ts [--uninstall] [--debug]
 *
 * Installs ~/Library/LaunchAgents/com.superwhisper.bridge.plist and
 * loads it with launchctl so the bridge daemon starts on login and
 * stays running.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents")
const PLIST_NAME = "com.superwhisper.bridge.plist"
const PLIST_DEST = join(LAUNCH_AGENTS_DIR, PLIST_NAME)

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const uninstall = args.includes("--uninstall")
const debug = args.includes("--debug")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findBunPath(): string {
  return process.execPath
}

function findScriptPath(): string {
  return join(import.meta.dir, "superwhisper-bridge.ts")
}

function loadService(): void {
  try {
    Bun.spawnSync(["launchctl", "load", PLIST_DEST], { stdio: ["inherit", "inherit", "inherit"] })
  } catch {
    // launchctl load may fail if already loaded; try bootstrap
    try {
      const uid = (process as any).getuid?.() ?? 501
      Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, PLIST_DEST], {
        stdio: ["inherit", "inherit", "inherit"],
      })
    } catch {
      console.log("⚠  Could not load the service — it may already be loaded, or you may need to log out and back in.")
    }
  }
}

function unloadService(): void {
  try {
    Bun.spawnSync(["launchctl", "unload", PLIST_DEST], { stdio: ["inherit", "inherit", "inherit"] })
  } catch {
    try {
      const uid = (process as any).getuid?.() ?? 501
      Bun.spawnSync(["launchctl", "bootout", `gui/${uid}`, PLIST_DEST], {
        stdio: ["inherit", "inherit", "inherit"],
      })
    } catch {
      // fine
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (uninstall) {
  console.log("Uninstalling superwhisper-bridge launchd service...")

  if (existsSync(PLIST_DEST)) {
    unloadService()
    unlinkSync(PLIST_DEST)
    console.log(`✓ Removed ${PLIST_DEST}`)
  } else {
    console.log("Service plist not found — nothing to uninstall.")
  }

  console.log("Done.")
  process.exit(0)
}

// --- Install ---

const bunPath = findBunPath()
const scriptPath = findScriptPath()
const templatePath = join(import.meta.dir, "com.superwhisper.bridge.plist")

if (!existsSync(scriptPath)) {
  console.error(`✗ Bridge script not found at: ${scriptPath}`)
  console.error("  Make sure bin/superwhisper-bridge.ts exists in the package.")
  process.exit(1)
}

if (!existsSync(templatePath)) {
  console.error(`✗ Plist template not found at: ${templatePath}`)
  process.exit(1)
}

// Read template and substitute
const template = readFileSync(templatePath, "utf8")
const plist = template
  .replace(/__BUN_PATH__/g, bunPath)
  .replace(/__SCRIPT_PATH__/g, scriptPath)
  .replace(/__DEBUG__/g, debug ? "1" : "")

// Write plist
mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
writeFileSync(PLIST_DEST, plist)
console.log(`✓ Wrote ${PLIST_DEST}`)

// Load service
console.log("Loading service...")
loadService()
console.log(`✓ Service loaded: ${PLIST_NAME}`)

// Done
console.log()
console.log("Bridge daemon is now running and will start automatically on login.")
console.log()
console.log("Check status:")
console.log(`  launchctl list | grep superwhisper`)
console.log()
console.log("View logs:")
console.log(`  tail -f /tmp/superwhisper-bridge.log`)
console.log()
console.log("Uninstall:")
console.log(`  bun run ${join(import.meta.dir, "install-bridge-service.ts")} --uninstall`)
