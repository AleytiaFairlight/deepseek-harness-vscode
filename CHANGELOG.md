# Changelog

## 0.0.15

- Stale-panel proof: chat status bar shows `ext v0.0.15`, Output logs the active version, first run after update shows a notice with a one-click “Open DSH Chat” (old tabs must be closed — VS Code never refreshes open webviews on update)
- Verified end-to-end in a mocked host: activate, both sidebars, panel open, session create all complete in ms with no `dsh`/`opencode` on PATH

## 0.0.14

- FIX: clicks did nothing when `dsh` was missing — spawn no longer hangs: binary pre-flight (`where`/`which`), 20s connect/initialize timeouts, dead-child detection, 20s per-RPC timeouts, clear Output warnings + headless/error fallback instead of a frozen UI
- Chat tabs now respond (Chat shows all, Trajectory hides user turns); Send becomes ■ Stop while busy (session/cancel); model pill, effort, permission, workspace chips all wired with existence-checked handlers

## 0.0.13

- Built from upstream repo (deepseek-harness@2e39e70): chat follows ChatFlow/InputBar (user bubble right 70%/20px, assistant plain 14/24, collapsible tool groups, 28px composer card, suggestion chips, stop button via session/cancel)
- Settings Models follows upstream (DeepSeek onboarding copy, shipped-provider picker, Custom card order + acme-gateway placeholders, Fetch available models, write-only keys, green/red credential dots, env precedence launch→$cwd/.env→$DSH_HOME/.env); Permission row uses Harness strings + Full-access confirm copy

## 0.0.12

- Settings saves verified: write + read-back + exact saved values in confirmation; model/effort go through live-push setters with surfaced `session/set_config_option` errors (no silent fails)
- No command panel needed: `ensureSession` pins saved provider/model + effort on new sessions; every `prompt` re-syncs saved settings first, so Settings/Setup changes apply to the next message automatically
- Effort uses correct wire key `reasoning_effort`; setupModel asks effort after model

## 0.0.11

- Provenance fix: this machine has NEITHER `opencode` NOR `dsh` on PATH (verified) — sidebar no longer fails silently. Empty states now offer Diagnose; new `DSH: Diagnose` reports CLI presence, DB candidates, API vs SQLite, ACP initialize/list, model/effort/workspace in one Output channel
- Workspace controls: `DSH: Select Workspace` (VS Code folders + browse + current), stored as `defaultCwd`, shown as clickable cwd chip + sent as `session/new cwd` (ACP single-cwd limit documented)
- Model/effort properly: setup asks provider → key (SecretStorage/env) → model → effort (`off/low/medium/high`); pushes `model` + `reasoning_effort` (correct wire key) via `session/set_config_option`; effort + permission + cwd pills live in chat header

## 0.0.10

- Researched fixes (web-verified): opencode DB now checks `OPENCODE_DB` → `opencode debug paths db` → `%LOCALAPPDATA%/opencode/opencode.db` → XDG → legacy; API-first (`session list`/`api get /api/session`, `session export`) with SQLite WAL-copy + schema-discovery fallback
- Real ACP transport: ESM dynamic import, `ndJsonStream` + `client().onRequest(requestPermission→cancelled).onNotification(session/update)` + `connect()` + `initialize`/`authenticate`, `session/new|list|resume|close|set_config_option|prompt` via method constants with headless fallback
- Models unchanged (0.0.7 logic kept): provider picker + SecretStorage keys injected as `*_API_KEY` env

## 0.0.9

- Chat rebuilt to match the real Harness main panel: session/mode/subagents header, Chat/Trajectory tabs, file-edit cards (+/- diffs), deliverable cards, feedback + usage row, To-dos bar, Harness-style composer (plus, Full access, model/effort picker, blue send)
- User text renders as Harness prose (bullets/links/code), assistant as cards/text with timestamps; suggestion chips; 800px centered column

## 0.0.8

- History click no longer opens an editable file: it loads the transcript directly into the editor chat as bubbles; transcript file is now opt-in via right-click → Open Transcript (read-only preview)
- Sessions sidebar fixed: local session registry (new/switch remembered) merged with ACP list; empty state shows “No DSH sessions — click to start one” so the view is never blank

## 0.0.7

- Harness-accurate Models: DeepSeek key card, shipped provider picker (anthropic/openai/moonshotai/zai/gemini/groq/openrouter/opencode-gateway/custom), API key write-only with show/hide + env hints, custom API form (Provider ID/base URL/protocol/models) — latest Harness is 0.2.2-rc.5, same as yours
- Keys in SecretStorage + injected as env (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, …) into spawned `dsh`; quick `Setup Model` flow now asks key inline too
- Chat closer to Harness: 800px column, permission pill, suggestion chips, session/model/permission header sync

## 0.0.6

- Harness-style Settings tab: `DSH: Open Settings` editor panel with General / Models / Permissions / Connection / opencode / About, mirroring Harness layout (left nav + cards + Save)
- New settings: `permissionPreset` (workspace-write/danger-full-access), `reasoningEffort`, `maxTokens`; model pill + setup command write through to live ACP session
- Gear icon in Sessions title bar opens Settings

## 0.0.5

- Session rename: right-click / command renames DSH sessions (stored locally, shown in tree + chat header)
- History loads as chat: clicking opencode history renders its transcript as chat bubbles (user/assistant), no longer a prompt draft; transcript file still opens beside for reference
- Harness-style model setup: provider/model picker (`deepseek-official` + custom), persisted to settings, pushed to live ACP session, clickable model pill in chat header

## 0.0.4

- Editor-first layout: sidebar now holds `DSH Sessions` + `opencode History`; main chat moved to an editor tab (`Open DSH Chat in Editor`)
- Session switching: clicking opencode history opens the transcript file AND switches the editor chat to that context (prefill chip); DSH session rows switch via `selectDshSession`
- Per-session in-memory transcripts, session-line + status in header

## 0.0.3

- Click-to-open fixed: tree provider now implements `getChildren(element)` so grouped history expands; session rows carry stable ids and fire `openOpencodeSession` on single click
- Robust command args: accepts TreeItem or session payload, falls back to quick-pick for groups/palette; opens full session doc (title, id, directory, project + 200 messages) in a non-preview editor
- Right-click/inline actions for opencode rows (Open + Send to DSH), title-bar Refresh

## 0.0.2

- Mini-DSH console UI: Harness-style header (DS badge, session pill, model pill, idle/running status), Chat/Trajectory tabs, avatar message cards, thinking indicator, context chip for opencode sessions, DSH-like rounded composer
- Copy buttons, live-update cards, session line in header

## 0.0.1

- Initial preview: DSH Chat webview via `dsh --profile acp` (ACP stdio, `@agentclientprotocol/sdk`)
- opencode History tree (v2 `session_v2` + v1 fallback, WAL-safe copy-on-read, `node:sqlite` with `sqlite3` CLI fallback)
- Commands: Refresh, Open session as Markdown, Send session to DSH, New DSH session
- Settings: `cliPath`, `profile`, `defaultCwd`, `opencodeDbPath`
