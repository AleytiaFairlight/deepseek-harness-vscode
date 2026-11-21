import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface OpencodeSession {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  directory?: string;
  updatedAt?: number;
  model?: string;
}

export interface OpencodeMessage {
  seq?: number;
  role: string;
  text: string;
}

/** Resolve opencode.db honoring overrides. Returns { path, source }.
 * Order: setting → OPENCODE_DB → LOCALAPPDATA (Windows) → XDG_DATA_HOME → legacy ~/.local/share.
 * Use `opencode debug paths db` (detectOpencodeDbViaCli) when unsure — see Settings tooltip.
 */
export function resolveOpencodeDbPath(configOverride = ''): { path: string; source: string } {
  if (configOverride?.trim()) return { path: configOverride.trim(), source: 'setting deepseekHarness.opencodeDbPath' };
  if (process.env.OPENCODE_DB?.trim()) {
    const v = process.env.OPENCODE_DB.trim();
    if (v === ':memory:') return { path: '', source: 'OPENCODE_DB=:memory: (ephemeral, no history)' };
    const abs = path.isAbsolute(v) ? v : path.join(xdgDataDir(), v);
    return { path: abs, source: 'env OPENCODE_DB' };
  }
  for (const c of candidateDbPaths()) {
    if (c.path && fs.existsSync(c.path)) return { path: c.path, source: c.source };
  }
  // None exists — return the most likely so the error names it.
  const first = candidateDbPaths()[0];
  return { path: first.path, source: `${first.source} (missing — run \`opencode debug paths db\`)` };
}

export function candidateDbPaths(): { path: string; source: string }[] {
  const home = os.homedir();
  const list: { path: string; source: string }[] = [];
  const localApp = process.env.LOCALAPPDATA?.trim();
  if (localApp) list.push({ path: path.join(localApp, 'opencode', 'opencode.db'), source: '%LOCALAPPDATA%\\opencode\\opencode.db' });
  list.push({ path: path.join(xdgDataDir(), 'opencode', 'opencode.db'), source: '$XDG_DATA_HOME/opencode/opencode.db' });
  const legacy = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!list.some((c) => c.path === legacy)) list.push({ path: legacy, source: '~/.local/share/opencode/opencode.db (legacy)' });
  return list;
}

function xdgDataDir(): string {
  if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
  // Windows without XDG: research shows %LOCALAPPDATA% is the real default; keep XDG fallback for portability.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA?.trim()) return process.env.LOCALAPPDATA.trim();
  return path.join(os.homedir(), '.local', 'share');
}

/** Ask the opencode CLI for its real DB path (`opencode debug paths db`). Returns '' when unavailable. */
export function detectOpencodeDbViaCli(timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile('opencode', ['debug', 'paths', 'db'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve('');
      const out = String(stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
      resolve(out[out.length - 1] ?? '');
    });
  });
}

function execOpencode(args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('opencode', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr as string) || err.message));
      else resolve(String(stdout ?? ''));
    });
  });
}

/** API-first listing: `opencode session list` / `opencode api get /api/session`. Returns null when CLI/API unavailable. */
async function tryOpencodeApiList(limit: number): Promise<OpencodeSession[] | null> {
  const attempts: string[][] = [
    ['session', 'list', '--max-count', String(limit), '--format', 'json'],
    ['api', 'get', '/api/session'],
  ];
  for (const args of attempts) {
    try {
      const out = await execOpencode(args);
      const sessions = parseOpencodeApiSessions(out, limit);
      if (sessions) return sessions;
    } catch {
      continue;
    }
  }
  return null;
}

function parseOpencodeApiSessions(out: string, limit: number): OpencodeSession[] | null {
  try {
    const text = out.trim();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    const arr: unknown[] = Array.isArray(parsed) ? parsed : (parsed as any).sessions ?? (parsed as any).data ?? [];
    if (!Array.isArray(arr) || !arr.length) return [];
    return (arr as Record<string, any>[]).slice(0, limit).map((s, i) => ({
      id: String(s.id ?? s.sessionID ?? s.session_id ?? `api-${i}`),
      title: String(s.title ?? s.name ?? '(untitled)'),
      projectId: s.projectID ?? s.project_id ?? s.projectId ?? undefined,
      projectName: s.projectName ?? s.project ?? undefined,
      directory: s.directory ?? s.workdir ?? s.cwd ?? s.worktree ?? undefined,
      updatedAt: toMs(s.time_updated ?? s.timeUpdated ?? s.updated_at ?? s.time_created ?? s.created),
    })).filter((s) => s.id);
  } catch {
    return null;
  }
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

async function tryOpencodeApiMessages(sessionId: string, limit: number): Promise<OpencodeMessage[] | null> {
  const attempts: string[][] = [
    ['session', 'export', sessionId],
    ['api', 'get', `/api/session/${sessionId}`],
    ['api', 'get', `/api/session/${sessionId}/message`],
  ];
  for (const args of attempts) {
    try {
      const out = await execOpencode(args);
      const msgs = parseOpencodeApiMessages(out, limit);
      if (msgs && msgs.length) return msgs;
    } catch {
      continue;
    }
  }
  return null;
}

function parseOpencodeApiMessages(out: string, limit: number): OpencodeMessage[] | null {
  try {
    const text = out.trim();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed as any).messages ?? (parsed as any).parts ?? (parsed as any).data ?? [];
    if (!Array.isArray(arr) || !arr.length) return null;
    return (arr as Record<string, any>[]).slice(0, limit).map((m, i) => {
      const role = String(m.role ?? m.type ?? (m.from === 'user' || m.author === 'user' ? 'user' : 'assistant'));
      const textBody = m.text ?? m.content ?? (typeof m.data === 'string' ? m.data : JSON.stringify(m).slice(0, 4000));
      return { seq: typeof m.seq === 'number' ? m.seq : i, role, text: String(textBody).slice(0, 4000) };
    });
  } catch {
    return null;
  }
}

/** Copy DB to temp (WAL-safe) and return temp path. Throws if missing. */
export function copyDbForRead(dbPath: string): string {
  if (!dbPath || !fs.existsSync(dbPath)) {
    const cands = candidateDbPaths().map((c) => `  - ${c.path} (${c.source})`).join('\n');
    throw new Error(
      `opencode.db not found at ${dbPath || '(empty)'}. Checked:\n${cands}\nRun \`opencode debug paths db\` or set deepseekHarness.opencodeDbPath / OPENCODE_DB.`
    );
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-opencode-')), 'opencode-copy.db');
  fs.copyFileSync(dbPath, tmp);
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmp + suffix);
    } catch { /* best effort */ }
  }
  return tmp;
}

function tryNodeSqlite(dbCopy: string, limit: number): OpencodeSession[] | null {
  try {
    // Node 22+ built-in; may be absent on older Electron/Node — caller falls back.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as any;
    const db = new sqlite.DatabaseSync(dbCopy, { readOnly: true });
    try {
      const tables = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name)
      );
      const cols = (table: string): string[] => {
        try {
          return (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[]).map((r) => r.name);
        } catch {
          return [];
        }
      };
      const pick = (available: string[], wants: string[]): string | undefined => wants.find((w) => available.includes(w));
      const orderByTime = (available: string[]): string => {
        const c = pick(available, ['time_updated', 'timeUpdated', 'updated_at', 'updatedAt', 'time_created', 'timeCreated', 'created_at', 'createdAt', 'created']);
        return c ? `ORDER BY "${c}" DESC` : '';
      };
      if (tables.has('session_v2')) {
        const sc = cols('session_v2');
        const idC = pick(sc, ['id']) ?? 'id';
        const titleC = pick(sc, ['title']);
        const projC = pick(sc, ['project_id', 'projectId', 'project']);
        const dirC = pick(sc, ['directory', 'workdir', 'cwd', 'worktree', 'path']);
        const updC = pick(sc, ['time_updated', 'timeUpdated', 'updated_at', 'updatedAt', 'time_created', 'timeCreated', 'created_at', 'createdAt', 'created']);
        const hasProject = tables.has('project');
        const pc = hasProject ? cols('project') : [];
        const pname = pick(pc, ['name', 'title']);
        const pwork = pick(pc, ['worktree', 'workdir', 'path', 'directory']);
        const join = hasProject && projC ? ` LEFT JOIN project p ON p.id = s."${projC}"` : '';
        const projSel = hasProject && projC
          ? `s."${projC}" AS projectId${pname || pwork ? `, COALESCE(${[pname ? `p."${pname}"` : '', pwork ? `p."${pwork}"` : ''].filter(Boolean).join(', ')}) AS projectName` : ''}`
          : 'NULL AS projectId';
        const rows = db
          .prepare(
            `SELECT s."${idC}" AS id${titleC ? `, s."${titleC}" AS title` : `, '(untitled)' AS title`}${dirC ? `, s."${dirC}" AS directory` : `, NULL AS directory`}${updC ? `, s."${updC}" AS updatedAt` : `, NULL AS updatedAt`}, ${projSel} FROM session_v2 s${join} ${updC ? `ORDER BY s."${updC}" DESC` : ''} LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[];
        return rows.map((r) => ({
          id: String(r.id ?? ''),
          title: String(r.title || '(untitled)'),
          projectId: r.projectId ? String(r.projectId) : undefined,
          projectName: (r as any).projectName ? String((r as any).projectName) : undefined,
          directory: r.directory ? String(r.directory) : undefined,
          updatedAt: typeof r.updatedAt === 'number' ? (r.updatedAt > 1e12 ? r.updatedAt : r.updatedAt * 1000) : undefined,
        }));
      }
      if (tables.has('session')) {
        const sc = cols('session');
        const order = orderByTime(sc);
        const rows = db
          .prepare(`SELECT id, title, directory FROM session ${order} LIMIT ?`)
          .all(limit) as Record<string, unknown>[];
        return rows.map((r) => ({
          id: String(r.id ?? ''),
          title: String(r.title || '(untitled)'),
          directory: r.directory ? String(r.directory) : undefined,
        }));
      }
      return [];
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function sqliteCli(dbCopy: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', [dbCopy, sql], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`sqlite3 CLI failed: ${stderr || err.message}. Install sqlite3 or open the DB copy at ${dbCopy}.`));
      else resolve(stdout);
    });
  });
}

export async function listOpencodeSessions(dbPath: string, limit = 100): Promise<OpencodeSession[]> {
  // API-first (live, safest): `opencode session list` / `opencode api get /api/session`.
  try {
    const viaApi = await tryOpencodeApiList(limit);
    if (viaApi && viaApi.length) return viaApi;
  } catch { /* fall through to SQLite */ }
  const dbCopy = copyDbForRead(dbPath);
  const viaBuiltin = tryNodeSqlite(dbCopy, limit);
  if (viaBuiltin) return viaBuiltin;
  // Fallback: sqlite3 CLI, v2 then v1.
  const sep = '\t';
  try {
    const out = await sqliteCli(
      dbCopy,
      `.separator ${sep}\nSELECT s.id, COALESCE(s.title,'(untitled)'), COALESCE(s.directory,''), COALESCE(s.time_updated,0) FROM session_v2 s ORDER BY s.time_updated DESC LIMIT ${limit};`
    );
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [id, title, directory, updated] = line.split(sep);
      return { id, title, directory: directory || undefined, updatedAt: Number(updated) || undefined };
    });
  } catch {
    const out = await sqliteCli(dbCopy, `.separator ${sep}\nSELECT id, COALESCE(title,'(untitled)'), COALESCE(directory,'') FROM session LIMIT ${limit};`);
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [id, title, directory] = line.split(sep);
      return { id, title, directory: directory || undefined };
    });
  }
}

export async function readOpencodeSessionMessages(dbPath: string, sessionId: string, limit = 200): Promise<OpencodeMessage[]> {
  // API-first: `opencode session export <id>` / `opencode api get /api/session/<id>...`.
  try {
    const viaApi = await tryOpencodeApiMessages(sessionId, limit);
    if (viaApi && viaApi.length) return viaApi;
  } catch { /* fall through to SQLite */ }
  const dbCopy = copyDbForRead(dbPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as any;
    const db = new sqlite.DatabaseSync(dbCopy, { readOnly: true });
    try {
      const tables = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name)
      );
      if (tables.has('session_message')) {
        const rows = db
          .prepare(`SELECT seq, type, data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?`)
          .all(sessionId, limit) as { seq: number; type: string; data: string }[];
        return rows.map((r) => ({ seq: r.seq, role: r.type, text: summarizeData(r.type, r.data) }));
      }
      if (tables.has('message')) {
        const rows = db
          .prepare(`SELECT rowid AS seq, role, data FROM message WHERE session_id = ? ORDER BY rowid LIMIT ?`)
          .all(sessionId, limit) as { seq: number; role: string; data: string }[];
        return rows.map((r) => ({ seq: r.seq, role: r.role, text: summarizeData(r.role, r.data) }));
      }
      return [];
    } finally {
      db.close();
    }
  } catch {
    const out = await sqliteCli(dbCopy, `SELECT type || char(9) || substr(data,1,2000) FROM session_message WHERE session_id='${sessionId.replace(/'/g, "''")}' ORDER BY seq LIMIT ${limit};`);
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const tab = line.indexOf('\t');
      return { seq: i, role: tab >= 0 ? line.slice(0, tab) : 'message', text: tab >= 0 ? line.slice(tab + 1) : line };
    });
  }
}

function summarizeData(role: string, data: string): string {
  try {
    const obj = JSON.parse(data) as Record<string, unknown>;
    const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    for (const k of ['text', 'content', 'body', 'message']) {
      const s = pick((obj as Record<string, unknown>)[k]);
      if (s) return s.slice(0, 4000);
    }
    const content = (obj as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .map((c) => (c && typeof c === 'object' && 'text' in (c as object) ? String((c as { text: unknown }).text) : ''))
        .filter(Boolean);
      if (texts.length) return texts.join('\n\n').slice(0, 4000);
    }
    return JSON.stringify(obj).slice(0, 4000);
  } catch {
    return `${role}: ${data.slice(0, 4000)}`;
  }
}

export function formatSessionForDsh(session: OpencodeSession, messages: OpencodeMessage[]): string {
  const header = `# Past opencode session\n- id: ${session.id}\n- title: ${session.title}\n` +
    (session.directory ? `- directory: ${session.directory}\n` : '') +
    (session.projectName ? `- project: ${session.projectName}\n` : '');
  const body = messages.map((m) => `## ${m.role}\n${m.text}`).join('\n\n');
  return `${header}\n${body}`.slice(0, 24000);
}
