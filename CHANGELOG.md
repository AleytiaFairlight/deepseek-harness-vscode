# Changelog

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
