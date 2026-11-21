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

/** Resolve opencode.db honoring overrides. Returns { path, source }. */
export function resolveOpencodeDbPath(configOverride = ''): { path: string; source: string } {
  if (configOverride?.trim()) return { path: configOverride.trim(), source: 'setting deepseekHarness.opencodeDbPath' };
  if (process.env.OPENCODE_DB?.trim()) {
    const v = process.env.OPENCODE_DB.trim();
    if (v === ':memory:') return { path: '', source: 'OPENCODE_DB=:memory: (ephemeral, no history)' };
    const abs = path.isAbsolute(v) ? v : path.join(dataDir(), v);
    return { path: abs, source: 'env OPENCODE_DB' };
  }
  const p = path.join(dataDir(), 'opencode', 'opencode.db');
  return { path: p, source: 'default XDG data dir' };
}

function dataDir(): string {
  if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
  return path.join(os.homedir(), '.local', 'share');
}

/** Copy DB to temp (WAL-safe) and return temp path. Throws if missing. */
export function copyDbForRead(dbPath: string): string {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(
      `opencode.db not found at ${dbPath || '(empty)'}. ` +
        `Look for %USERPROFILE%\\.local\\share\\opencode\\opencode.db or set deepseekHarness.opencodeDbPath / OPENCODE_DB.`
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
      if (tables.has('session_v2')) {
        const rows = db
          .prepare(
            `SELECT s.id, s.title, s.project_id AS projectId, s.directory, s.time_updated AS updatedAt,
                    COALESCE(p.name, p.worktree, '') AS projectName
             FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id
             ORDER BY s.time_updated DESC LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[];
        return rows.map((r) => ({
          id: String(r.id ?? ''),
          title: String(r.title || '(untitled)'),
          projectId: r.projectId ? String(r.projectId) : undefined,
          projectName: r.projectName ? String(r.projectName) : undefined,
          directory: r.directory ? String(r.directory) : undefined,
          updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
        }));
      }
      if (tables.has('session')) {
        const rows = db
          .prepare(`SELECT id, title, directory FROM session ORDER BY time_updated DESC LIMIT ?`)
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
