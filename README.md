# omp-superwhisper

Superwhisper voice integration extension for [Oh My Pi](https://github.com/neuralmux/oh-my-pi).

Get voice notifications when your AI coding tasks complete, and respond with your voice. Your voice response is sent back to OMP as the next prompt, creating a hands-free coding loop.

## Requirements

- [Oh My Pi](https://github.com/neuralmux/oh-my-pi) (`@oh-my-pi/pi-coding-agent`) installed
- [Superwhisper](https://superwhisper.com) app for macOS

## Installation

### Via OMP extension discovery

Place this package under `~/.omp/agent/extensions/` or `<project>/.omp/extensions/`. OMP auto-discovers `.ts` extension modules from these locations.

```bash
# user-level (available in all sessions)
mkdir -p ~/.omp/agent/extensions
cp -r extensions/superwhisper.ts extensions/host.ts extensions/constants.ts \
      extensions/message.ts extensions/poll.ts extensions/inbox.ts \
      ~/.omp/agent/extensions/

# project-level (available in this project only)
mkdir -p .omp/extensions
cp extensions/*.ts .omp/extensions/
```

Restart OMP to activate.

## How It Works

```
You speak → OMP works → Extension notifies Superwhisper → You speak back → loop
```

1. **Task completes** → OMP fires `agent_end` with `stopReason: "stop"`
2. **Extension extracts the response** → reads the last assistant text content
3. **Extension notifies Superwhisper** → writes message to temp file, opens deeplink
4. **Superwhisper shows notification** → displays summary with voice recording UI
5. **You speak your response** → Superwhisper transcribes and writes to response file
6. **Extension reads response** → polls the response file, sends back to OMP via `pi.sendUserMessage`
7. **OMP continues** → processes your voice input as the next instruction

## Events

| OMP Event         | Superwhisper Status | Description                  |
|-------------------|---------------------|------------------------------|
| `agent_end` (stop)| `completed`         | Task finished                |

OMP has no built-in permission popups or elicitation system, so only end-of-turn completions are surfaced today.

## Using from Devcontainers / Docker

When running OMP inside a devcontainer or Docker container, the extension cannot directly access the host's Superwhisper app. You need to run the **bridge daemon** on the macOS host to proxy communication.

### 1. Start the bridge daemon on your macOS host

**Quick start (foreground):**

```bash
bun run bin/superwhisper-bridge.ts
```

**Install as a background service (starts on login):**

```bash
bun run bin/install-bridge-service.ts
```

You'll see:

```
✓ Wrote ~/Library/LaunchAgents/com.superwhisper.bridge.plist
✓ Service loaded: com.superwhisper.bridge.plist
```

The daemon is now running and will restart automatically on login.

Check it's running:

```bash
launchctl list | grep superwhisper
```

View logs:

```bash
tail -f /tmp/superwhisper-bridge.log
```

**Uninstall the service:**

```bash
bun run bin/install-bridge-service.ts --uninstall
```

**Enable debug logging:**

```bash
bun run bin/install-bridge-service.ts --debug
```

### 2. Configure your devcontainer

In your `.devcontainer/devcontainer.json` or `docker-compose.yml`, set the environment variable inside the container:

```json
{
  "containerEnv": {
    "SUPERWHISPER_BRIDGE_URL": "http://host.docker.internal:19550"
  }
}
```

Or in a `docker-compose.yml`:

```yaml
services:
  dev:
    environment:
      - SUPERWHISPER_BRIDGE_URL=http://host.docker.internal:19550
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### 3. That's it

When the extension detects `SUPERWHISPER_BRIDGE_URL`, it automatically switches to bridge mode. All Superwhisper interactions (inbox delivery, message/response file I/O, deeplink wakes) are proxied through the host daemon.

> **Note:** You need one bridge daemon per Mac. Multiple devcontainers can share the same daemon.

## Controlling Superwhisper During a Session

You can ask the agent to enable or disable Superwhisper voice notifications at any time during a session. The extension exposes a `superwhisper_toggle` tool the agent will use automatically when instructed.

**Disable Superwhisper for the current session:**
> "Disable Superwhisper" / "Turn off voice notifications" / "Stop Superwhisper"

**Re-enable Superwhisper for the current session:**
> "Enable Superwhisper" / "Turn voice notifications back on" / "Re-enable Superwhisper"

The toggle is session-scoped — it only affects the current OMP session and resets when you start a new one.

## Slash Commands

```
/superwhisper on       — enable voice notifications
/superwhisper off      — disable voice notifications
/superwhisper test     — send a test notification
/superwhisper status   — show current state
```

## Environment Variables

| Variable                    | Default | Description                                                          |
|-----------------------------|---------|----------------------------------------------------------------------|
| `SUPERWHISPER_DEBUG`        | unset   | Set to `1` to write debug logs to `/tmp/superwhisper-agent/debug.log`|
| `SUPERWHISPER_SCHEME`       | auto    | Override deeplink scheme (`superwhisper` vs `superwhisper-debug`)    |
| `SUPERWHISPER_BRIDGE_URL`   | unset   | Bridge daemon URL for devcontainer support (e.g. `http://host.docker.internal:19550`) |

**Bridge daemon env vars** (set on the macOS host, not in the container):

| Variable                    | Default | Description                                                          |
|-----------------------------|---------|----------------------------------------------------------------------|
| `SUPERWHISPER_BRIDGE_PORT`  | `19550` | Port for the bridge daemon to listen on                              |
| `SUPERWHISPER_BRIDGE_HOST`  | `127.0.0.1` | Bind address for the bridge daemon                              |
| `SUPERWHISPER_DEBUG`        | unset   | Set to `1` for verbose bridge daemon logging to stderr               |

## Project Structure

```
extensions/
  superwhisper.ts  # Extension entry — OMP loads this directly
  host.ts          # HostOps abstraction (direct vs bridge mode)
  constants.ts     # Constants and shared types
  inbox.ts         # Inbox payload writes
  message.ts       # AgentMessage helpers (extract text, summary, end-turn)
  poll.ts          # Response file polling
bin/
  superwhisper-bridge.ts        # Host bridge daemon for devcontainer support
  install-bridge-service.ts     # Launchd service installer
  com.superwhisper.bridge.plist # Launchd plist template
```

## License

MIT
