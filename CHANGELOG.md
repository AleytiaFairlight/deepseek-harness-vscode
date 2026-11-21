# Changelog

## 0.0.2

- Mini-DSH console UI: Harness-style header (DS badge, session pill, model pill, idle/running status), Chat/Trajectory tabs, avatar message cards, thinking indicator, context chip for opencode sessions, DSH-like rounded composer
- Copy buttons, live-update cards, session line in header

## 0.0.1

- Initial preview: DSH Chat webview via `dsh --profile acp` (ACP stdio, `@agentclientprotocol/sdk`)
- opencode History tree (v2 `session_v2` + v1 fallback, WAL-safe copy-on-read, `node:sqlite` with `sqlite3` CLI fallback)
- Commands: Refresh, Open session as Markdown, Send session to DSH, New DSH session
- Settings: `cliPath`, `profile`, `defaultCwd`, `opencodeDbPath`
