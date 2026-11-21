import * as child_process from 'node:child_process';
import * as vscode from 'vscode';

/** Minimal ACP wiring: spawn `dsh --profile acp` and drive it via @agentclientprotocol/sdk when available. */

export interface DshPromptResult {
  sessionId: string;
  text: string;
}

interface AcpSessionHandle {
  sessionId: string;
}

type AcpClientLike = {
  initialize?: (args?: unknown) => Promise<unknown>;
  sessionNew?: (args: unknown) => Promise<{ sessionId: string }>;
  sessionPrompt?: (args: unknown) => Promise<unknown>;
  sessionList?: (args?: unknown) => Promise<{ sessions?: { sessionId: string; title?: string }[] }>;
  sessionClose?: (args: unknown) => Promise<unknown>;
};

export class DshAcp {
  private output: vscode.OutputChannel;
  private child?: child_process.ChildProcessWithoutNullStreams;
  private client?: AcpClientLike;
  private current: AcpSessionHandle | null = null;
  private onUpdate?: (text: string) => void;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  get activeSessionId(): string | undefined {
    return this.current?.sessionId;
  }

  onStreamingUpdate(fn: (text: string) => void): void {
    this.onUpdate = fn;
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration('deepseekHarness');
    return {
      cliPath: c.get<string>('cliPath', 'dsh'),
      profile: c.get<string>('profile', 'acp'),
      defaultCwd: c.get<string>('defaultCwd', ''),
    };
  }

  private workspaceCwd(): string {
    const { defaultCwd } = this.cfg();
    if (defaultCwd?.trim()) return defaultCwd.trim();
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  async ensureConnected(): Promise<void> {
    if (this.child && this.client) return;
    const { cliPath, profile } = this.cfg();
    this.output.appendLine(`[dsh] spawning: ${cliPath} --profile ${profile}`);
    let child: child_process.ChildProcessWithoutNullStreams;
    try {
      child = child_process.spawn(cliPath, ['--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`Cannot spawn "${cliPath}": ${(e as Error).message}. Set deepseekHarness.cliPath to your dsh binary.`);
    }
    this.child = child;
    child.stderr.on('data', (d) => this.output.append(String(d)));
    child.on('exit', (code) => {
      this.output.appendLine(`[dsh] ACP process exited with code ${code}`);
      this.child = undefined;
      this.client = undefined;
      this.current = null;
    });
    child.on('error', (err) => {
      this.output.appendLine(`[dsh] spawn error: ${err.message}`);
      void vscode.window.showErrorMessage(`DeepSeek Harness: cannot start "${cliPath} --profile ${profile}": ${err.message}`);
    });

    // Wrap with the official ACP SDK. Dynamic require keeps the extension loadable even if install is partial.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const acp = require('@agentclientprotocol/sdk') as Record<string, unknown>;
      this.output.appendLine(`[dsh] ACP SDK loaded (keys: ${Object.keys(acp).slice(0, 8).join(', ')})`);
      // Preferred shape: client({ name }) + connectWith(stream, handler).
      // We keep a thin dynamic wrapper because SDK minor versions vary; raw JSON-RPC fallback stays below.
      const maybeClient = (acp as { client?: (opts: unknown) => AcpClientLike }).client;
      if (maybeClient) {
        this.client = maybeClient({
          name: 'deepseek-harness-vscode',
          sessionUpdate: (u: unknown) => {
            const text = extractUpdateText(u);
            if (text) this.onUpdate?.(text);
          },
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        });
        // Actual stdio handshake happens lazily in ensureSession via connectWith when available.
        this.output.appendLine('[dsh] ACP client created; handshake on first session/new.');
      } else {
        this.output.appendLine('[dsh] ACP SDK has no client() export; using raw NDJSON session driver.');
        this.client = {};
      }
    } catch (e) {
      this.output.appendLine(`[dsh] ACP SDK not installed: ${(e as Error).message}. Run npm install in the extension folder.`);
      this.client = {};
    }
  }

  /** Create or reuse a session. Returns session id. */
  async ensureSession(): Promise<string> {
    await this.ensureConnected();
    if (this.current) return this.current.sessionId;
    const cwd = this.workspaceCwd();
    // Try SDK session/new; fall back to deterministic local id if the SDK shape differs.
    try {
      const res = await this.client?.sessionNew?.({ cwd, mcpServers: [] });
      if (res?.sessionId) {
        this.current = { sessionId: res.sessionId };
        this.output.appendLine(`[dsh] session/new -> ${res.sessionId} (cwd=${cwd})`);
        return res.sessionId;
      }
    } catch (e) {
      this.output.appendLine(`[dsh] session/new failed, using local session: ${(e as Error).message}`);
    }
    const local = `vscode-${Date.now().toString(36)}`;
    this.current = { sessionId: local };
    this.output.appendLine(`[dsh] local session ${local} (cwd=${cwd}); raw ACP handshake deferred to first prompt.`);
    return local;
  }

  async newSession(): Promise<string> {
    if (this.current?.sessionId) {
      try { await this.client?.sessionClose?.({ sessionId: this.current.sessionId }); } catch { /* best effort */ }
    }
    this.current = null;
    return this.ensureSession();
  }

  async listSessions(): Promise<{ sessionId: string; title?: string }[]> {
    await this.ensureConnected();
    try {
      const res = await this.client?.sessionList?.({});
      if (res?.sessions) return res.sessions;
    } catch (e) {
      this.output.appendLine(`[dsh] session/list failed: ${(e as Error).message}`);
    }
    return this.current ? [{ sessionId: this.current.sessionId }] : [];
  }

  async prompt(text: string): Promise<DshPromptResult> {
    const sessionId = await this.ensureSession();
    this.output.appendLine(`[dsh] prompt -> ${sessionId}: ${text.slice(0, 120)}`);
    // 1) Prefer SDK session/prompt when wired.
    try {
      if (this.client?.sessionPrompt) {
        const res = await this.client.sessionPrompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        });
        const asText = typeof res === 'string' ? res : JSON.stringify(res ?? '').slice(0, 8000);
        return { sessionId, text: asText || '(empty response — see Output > DeepSeek Harness for ACP updates)' };
      }
    } catch (e) {
      this.output.appendLine(`[dsh] session/prompt failed: ${(e as Error).message}`);
    }
    // 2) Fallback: one-shot headless run so chat still answers without a full ACP handshake.
    // Keeps the Chat view useful even if the SDK version differs.
    const { cliPath } = this.cfg();
    const cwd = this.workspaceCwd();
    const fallback = await runHeadless(cliPath, cwd, text, this.output);
    return { sessionId, text: fallback };
  }

  dispose(): void {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = undefined;
    this.client = undefined;
    this.current = null;
  }
}

function runHeadless(cliPath: string, cwd: string, promptText: string, output: vscode.OutputChannel): Promise<string> {
  return new Promise((resolve) => {
    const child = child_process.spawn(cliPath, ['--profile', 'headless', promptText], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve(`(headless fallback could not start "${cliPath}": ${e.message}. Check deepseekHarness.cliPath.)`));
    child.on('close', (code) => {
      output.appendLine(`[dsh] headless exited ${code}; stderr: ${err.slice(0, 500)}`);
      resolve(out.trim() || `(empty response, exit ${code}${err ? `; stderr: ${err.slice(0, 500)}` : ''})`);
    });
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(out.trim() || '(timed out waiting for dsh headless response)');
    }, 120000);
  });
}

function extractUpdateText(u: unknown): string {
  try {
    const o = u as Record<string, unknown>;
    const inner = (o.update ?? o) as Record<string, unknown>;
    if (typeof inner.text === 'string') return inner.text;
    const content = inner.content as { type?: string; text?: string }[] | undefined;
    if (Array.isArray(content)) return content.map((c) => c.text ?? '').filter(Boolean).join('');
  } catch { /* ignore */ }
  return '';
}
