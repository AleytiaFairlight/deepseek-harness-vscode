# DeepSeek Harness for VS Code

VS Code extension that hosts **DeepSeek Harness (DSH)** agent chat inside the editor and lets you browse **opencode session history** (`sst/opencode` → `anomalyco/opencode` v2).

## Features

- `DSH Chat` webview: full agent chat backed by `dsh --profile acp` (Agent Client Protocol over stdio)
- `opencode History` tree: reads the global `opencode.db` SQLite store, groups by project/directory
- `Send opencode Session to DSH`: forwards a past opencode session as context into the live DSH session
- No DSH fork: spawns your installed `dsh` CLI, multi-session with `session/new`, `list`, `resume`, `prompt`, `close`

## Requirements

- Node.js `>=24.9.0` (DSH CLI requirement; this machine's DSH runtime is `24.21.0`, system Node here is `22.14.0` — upgrade Node first)
- Installed `dsh` CLI on `PATH` supporting `--profile acp` (DSH `0.2.2-rc.5` verified, npm package `@deepseek-ai/dsh`):

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.5
dsh --profile acp --help
```

If `dsh` is not on `PATH`, set `deepseekHarness.cliPath` to the full path (e.g. `C:\Users\<you>\AppData\Roaming\npm\dsh.cmd` on Windows).
- opencode history is optional; without it only DSH chat works. This machine currently has no `%USERPROFILE%\.local\share\opencode\opencode.db`, so the tree correctly shows “no sessions” until opencode v2 creates it.

### opencode history location (Windows)

Auto-detected in this order:

1. `deepseekHarness.opencodeDbPath` setting, or `$OPENCODE_DB`
2. `$XDG_DATA_HOME/opencode/opencode.db`
3. `%USERPROFILE%\.local\share\opencode\opencode.db`

Copy-on-read is used (WAL-safe): the DB is copied to a temp file before querying so a running `opencode service` is never locked. Tables supported: v2 `session_v2` / `session_message` / `session_part` / `project`, with v1 `session` / `message` fallback.

## Extension Settings

| Setting | Default | Meaning |
|---|---|---|
| `deepseekHarness.cliPath` | `dsh` | Path to DSH CLI |
| `deepseekHarness.profile` | `acp` | Profile to spawn |
| `deepseekHarness.defaultCwd` | `` | Default cwd for new sessions (empty = workspace folder) |
| `deepseekHarness.opencodeDbPath` | `` | Override opencode.db path |

## How DSH is connected

`src/dshAcp.ts` spawns:

```text
dsh --profile acp
```

stdin/stdout carry newline-delimited ACP JSON-RPC; stderr is shown in the Output channel `DeepSeek Harness`. It uses `@agentclientprotocol/sdk@1.4.0` (`client({ name })` + `connectWith`) and implements:

`initialize` → `session/new { cwd, mcpServers? }` → `session/prompt` (streaming `session/update`) → `session/close`, plus `session/list` / `session/resume`.

If the CLI is missing, the Chat view shows the exact command and settings to fix.

## Develop

```sh
npm install
npm run compile
# then F5 in VS Code (Extension Development Host)
```
