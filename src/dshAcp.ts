import * as child_process from 'node:child_process';
import * as vscode from 'vscode';

/** Real ACP wiring: spawn `dsh --profile acp` and drive it via @agentclientprotocol/sdk v1. */

export interface DshPromptResult {
  sessionId: string;
  text: string;
}

interface AcpSessionHandle {
  sessionId: string;
}

export class DshAcp {
  private output: vscode.OutputChannel;
  private child?: child_process.ChildProcessWithoutNullStreams;
  private sdk?: any;
  private agent?: any;
  private connection?: any;
  private connecting?: Promise<void>;
  private current: AcpSessionHandle | null = null;
  private onUpdate?: (text: string) => void;
  private extraEnv: Record<string, string> = {};
  private useFallback = false;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /** Provider API keys injected into spawned dsh (mirrors Harness env fallback, never logged). */
  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = { ...env };
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.extraEnv };
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
      provider: c.get<string>('provider', 'deepseek-official'),
      model: c.get<string>('model', 'deepseek-v4'),
    };
  }

  getModel(): { provider: string; model: string } {
    const { provider, model } = this.cfg();
    return { provider, model };
  }

  getEffort(): string {
    return vscode.workspace.getConfiguration('deepseekHarness').get<string>('reasoningEffort', '') ?? '';
  }

  /** Push reasoning effort like Harness Effort menu (key is `reasoning_effort` on the wire). */
  async setEffort(effort: string): Promise<boolean> {
    const c = vscode.workspace.getConfiguration('deepseekHarness');
    await c.update('reasoningEffort', effort || undefined, vscode.ConfigurationTarget.Global);
    const saved = c.get<string>('reasoningEffort', '') ?? '';
    this.output.appendLine(`[dsh] reasoning effort saved=${saved || '(default)'}`);
    try {
      const sid = this.current?.sessionId;
      if (sid && this.agent && !this.useFallback && effort) {
        const res = await this.agent.request(this.method('session/set_config_option'), { sessionId: sid, key: 'reasoning_effort', value: effort });
        this.output.appendLine(`[dsh] pushed effort to session ${sid}: ${JSON.stringify(res ?? {}).slice(0, 300)}`);
        return true;
      }
      return false;
    } catch (e) {
      const msg = `Effort live-push failed (${(e as Error).message}); saved value applies to next session.`;
      this.output.appendLine(`[dsh] ${msg}`);
      void vscode.window.showWarningMessage(`DSH: ${msg}`);
      return false;
    }
  }

  /** Harness-style model setup: persist provider/model and push to live ACP sessions. */
  async setModel(provider: string, model: string): Promise<boolean> {
    const c = vscode.workspace.getConfiguration('deepseekHarness');
    await c.update('provider', provider, vscode.ConfigurationTarget.Global);
    await c.update('model', model, vscode.ConfigurationTarget.Global);
    const saved = this.getModel();
    this.output.appendLine(`[dsh] model saved=${saved.provider}/${saved.model}`);
    if (saved.provider !== provider || saved.model !== model) {
      const msg = `Settings write verification failed (wanted ${provider}/${model}, got ${saved.provider}/${saved.model}). Check Settings sync / file permissions.`;
      this.output.appendLine(`[dsh] ${msg}`);
      void vscode.window.showWarningMessage(`DSH: ${msg}`);
      return false;
    }
    try {
      const sid = this.current?.sessionId;
      if (sid && this.agent && !this.useFallback) {
        const res = await this.rpc('session/set_config_option', { sessionId: sid, key: 'model', value: { provider, model } });
        this.output.appendLine(`[dsh] pushed model to session ${sid}: ${JSON.stringify(res ?? {}).slice(0, 300)}`);
        return true;
      }
      return false;
    } catch (e) {
      const msg = `Model live-push failed (${(e as Error).message}); saved ${provider}/${model} applies to next session/new prompt.`;
      this.output.appendLine(`[dsh] ${msg}`);
      void vscode.window.showWarningMessage(`DSH: ${msg}`);
      return false;
    }
  }

  private workspaceCwd(): string {
    const { defaultCwd } = this.cfg();
    if (defaultCwd?.trim()) return defaultCwd.trim();
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private method(name: string): string {
    try {
      const m = this.sdk?.methods;
      const parts = name.split('/');
      // e.g. session/new -> m.agent.session.new ; initialize -> m.agent.initialize
      if (parts.length === 1 && m?.agent?.[parts[0]]) return m.agent[parts[0]];
      if (parts.length === 2 && (m?.agent as any)?.[parts[0]]?.[parts[1]]) return (m.agent as any)[parts[0]][parts[1]];
      if (parts.length === 2 && (m?.client as any)?.[parts[0]]?.[parts[1]]) return (m.client as any)[parts[0]][parts[1]];
    } catch { /* ignore */ }
    return name;
  }

  private async rpc(methodName: string, params: any): Promise<any> {
    await this.ensureConnected();
    if (!this.agent || this.useFallback) throw new Error('ACP not connected (fallback active)');
    const method = this.method(methodName);
    return this.agent.request(method, params);
  }

  async ensureConnected(): Promise<void> {
    if (this.agent && this.child) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInner().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectInner(): Promise<void> {
    const { cliPath, profile } = this.cfg();
    this.output.appendLine(`[dsh] spawning: ${cliPath} --profile ${profile}`);
    let child: child_process.ChildProcessWithoutNullStreams;
    try {
      child = child_process.spawn(cliPath, ['--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'], env: this.spawnEnv() });
    } catch (e) {
      throw new Error(`Cannot spawn "${cliPath}": ${(e as Error).message}. Set deepseekHarness.cliPath to your dsh binary.`);
    }
    this.child = child;
    child.stderr.on('data', (d) => this.output.append(String(d)));
    child.on('exit', (code) => {
      this.output.appendLine(`[dsh] ACP process exited with code ${code}`);
      this.child = undefined;
      this.agent = undefined;
      this.connection = undefined;
      this.current = null;
    });
    child.on('error', (err) => {
      this.output.appendLine(`[dsh] spawn error: ${err.message}`);
      void vscode.window.showErrorMessage(`DeepSeek Harness: cannot start "${cliPath} --profile ${profile}": ${err.message}`);
    });

    // Real SDK path: ESM dynamic import (require() fails on ESM packages).
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const importer = new Function('m', 'return import(m);') as (m: string) => Promise<any>;
      const sdk = await importer('@agentclientprotocol/sdk');
      this.sdk = sdk;
      const { Writable, Readable } = require('node:stream') as typeof import('node:stream');
      const toWebWritable = (Writable as any).toWeb(child.stdin);
      const toWebReadable = (Readable as any).toWeb(child.stdout);
      if (!toWebWritable || !toWebReadable || !sdk.ndJsonStream || !sdk.client) {
        throw new Error('SDK missing ndJsonStream/client (unexpected version)');
      }
      const stream = sdk.ndJsonStream(toWebWritable, toWebReadable);
      const app = sdk.client({ name: 'deepseek-harness-vscode', version: '0.0.10' });
      app.onRequest(sdk.methods?.client?.session?.requestPermission ?? 'session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } }));
      app.onNotification(sdk.methods?.client?.session?.update ?? 'session/update', async (n: any) => {
        const text = extractUpdateText(n?.params ?? n);
        if (text) this.onUpdate?.(text);
      });
      this.output.appendLine('[dsh] ACP SDK loaded; connecting stdio…');
      const connection = await app.connect(stream);
      this.connection = connection;
      this.agent = connection.agent;
      const protocolVersion = sdk.PROTOCOL_VERSION ?? 1;
      await this.agent.request(sdk.methods?.agent?.initialize ?? 'initialize', {
        protocolVersion,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      try {
        await this.agent.request(sdk.methods?.agent?.authenticate ?? 'authenticate', {});
      } catch { /* immediate-success servers may not need it */ }
      this.useFallback = false;
      this.output.appendLine('[dsh] ACP initialize ok (real transport).');
    } catch (e) {
      this.output.appendLine(`[dsh] ACP SDK connect failed, using headless fallback: ${(e as Error).message}`);
      this.useFallback = true;
      this.agent = undefined;
      // Keep child running (server still speaks ACP); chat falls back to headless per prompt.
    }
  }

  /** Create or reuse a session. Returns session id. Saved settings apply automatically — no command panel needed. */
  async ensureSession(): Promise<string> {
    await this.ensureConnected();
    if (this.current) return this.current.sessionId;
    const cwd = this.workspaceCwd();
    const { provider, model } = this.cfg();
    const effort = this.getEffort();
    if (!this.useFallback && this.agent) {
      try {
        const res = await this.agent.request(this.method('session/new'), { cwd, mcpServers: [] });
        const sid = (res as any)?.sessionId;
        if (sid) {
          this.current = { sessionId: sid };
          this.output.appendLine(`[dsh] session/new -> ${sid} (cwd=${cwd})`);
          // Pin saved model + effort like Harness model-switch (server default applies on failure).
          try {
            await this.agent.request(this.method('session/set_config_option'), { sessionId: sid, key: 'model', value: { provider, model } });
            this.output.appendLine(`[dsh] pinned saved model ${provider}/${model} on ${sid}`);
          } catch (e) { this.output.appendLine(`[dsh] model pin failed: ${(e as Error).message}`); }
          if (effort) {
            try {
              await this.agent.request(this.method('session/set_config_option'), { sessionId: sid, key: 'reasoning_effort', value: effort });
              this.output.appendLine(`[dsh] pinned saved effort ${effort} on ${sid}`);
            } catch (e) { this.output.appendLine(`[dsh] effort pin failed: ${(e as Error).message}`); }
          }
          return sid;
        }
      } catch (e) {
        this.output.appendLine(`[dsh] session/new failed, using local session: ${(e as Error).message}`);
      }
    }
    const local = `vscode-${Date.now().toString(36)}`;
    this.current = { sessionId: local };
    this.output.appendLine(`[dsh] local session ${local} (cwd=${cwd}); ACP unavailable, headless fallback per prompt.`);
    return local;
  }

  async newSession(): Promise<string> {
    if (this.current?.sessionId && !this.useFallback && this.agent) {
      try { await this.agent.request(this.method('session/close'), { sessionId: this.current.sessionId }); } catch { /* best effort */ }
    }
    this.current = null;
    return this.ensureSession();
  }

  /** Switch the active session without closing the previous one (ACP sessions persist server-side). */
  async switchTo(sessionId: string): Promise<string> {
    await this.ensureConnected();
    if (!this.useFallback && this.agent) {
      try {
        await this.agent.request(this.method('session/resume'), { sessionId });
        this.output.appendLine(`[dsh] session/resume -> ${sessionId}`);
      } catch (e) {
        this.output.appendLine(`[dsh] session/resume failed (keeping local pointer): ${(e as Error).message}`);
      }
    }
    this.current = { sessionId };
    return sessionId;
  }

  async listSessions(): Promise<{ sessionId: string; title?: string }[]> {
    await this.ensureConnected();
    if (!this.useFallback && this.agent) {
      try {
        const res = await this.agent.request(this.method('session/list'), {});
        const sessions = (res as any)?.sessions as { sessionId: string; title?: string }[] | undefined;
        if (sessions) return sessions;
      } catch (e) {
        this.output.appendLine(`[dsh] session/list failed: ${(e as Error).message}`);
      }
    }
    return this.current ? [{ sessionId: this.current.sessionId }] : [];
  }

  async cancel(): Promise<void> {
    const sid = this.current?.sessionId;
    if (!sid || !this.agent || this.useFallback) return;
    try {
      await this.agent.request(this.method('session/cancel'), { sessionId: sid });
      this.output.appendLine(`[dsh] session/cancel -> ${sid}`);
    } catch (e) {
      this.output.appendLine(`[dsh] cancel failed: ${(e as Error).message}`);
    }
  }

  async prompt(text: string): Promise<DshPromptResult> {
    const sessionId = await this.ensureSession();
    // Saved settings apply automatically: sync model + effort before every prompt (no command panel needed).
    if (!this.useFallback && this.agent) {
      const { provider, model } = this.cfg();
      const effort = this.getEffort();
      try { await this.agent.request(this.method('session/set_config_option'), { sessionId, key: 'model', value: { provider, model } }); } catch (e) { this.output.appendLine(`[dsh] pre-prompt model sync failed: ${(e as Error).message}`); }
      if (effort) {
        try { await this.agent.request(this.method('session/set_config_option'), { sessionId, key: 'reasoning_effort', value: effort }); } catch (e) { this.output.appendLine(`[dsh] pre-prompt effort sync failed: ${(e as Error).message}`); }
      }
    }
    this.output.appendLine(`[dsh] prompt -> ${sessionId}: ${text.slice(0, 120)}`);
    if (!this.useFallback && this.agent) {
      const chunks: string[] = [];
      const prev = this.onUpdate;
      this.onUpdate = (t) => {
        chunks.push(t);
        prev?.(t);
      };
      try {
        const res = await this.agent.request(this.method('session/prompt'), {
          sessionId,
          prompt: [{ type: 'text', text }],
        });
        const asText = extractResultText(res) || chunks.join('') || '';
        if (asText.trim()) return { sessionId, text: asText.slice(0, 12000) };
        // else fall through to headless so the user still gets an answer
        this.output.appendLine('[dsh] session/prompt returned empty; trying headless fallback.');
      } catch (e) {
        this.output.appendLine(`[dsh] session/prompt failed, trying headless: ${(e as Error).message}`);
      } finally {
        this.onUpdate = prev;
      }
    }
    const { cliPath } = this.cfg();
    const cwd = this.workspaceCwd();
    const fallback = await runHeadless(cliPath, cwd, text, this.output, this.spawnEnv());
    return { sessionId, text: fallback };
  }

  dispose(): void {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = undefined;
    this.agent = undefined;
    this.connection = undefined;
    this.current = null;
  }
}

export const PROVIDER_ENV: Record<string, string> = {
  'deepseek-official': 'DEEPSEEK_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  glm: 'ZAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function runHeadless(cliPath: string, cwd: string, promptText: string, output: vscode.OutputChannel, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = child_process.spawn(cliPath, ['--profile', 'headless', promptText], { cwd, env: env ?? process.env });
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
    const o = u as Record<string, any>;
    const update = o?.update ?? o?.params?.update ?? o;
    if (!update) return '';
    if (typeof update === 'string') return update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') return String(update.content.text ?? '');
    if (typeof (update as any).text === 'string') return (update as any).text;
    const content = (update as any).content;
    if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('');
    if (typeof content === 'string') return content;
  } catch { /* ignore */ }
  return '';
}

function extractResultText(res: unknown): string {
  try {
    if (typeof res === 'string') return res;
    const o = res as Record<string, any>;
    if (!o) return '';
    if (typeof o.text === 'string') return o.text;
    if (typeof o.finalResponse === 'string') return o.finalResponse;
    if (typeof o.response === 'string') return o.response;
    if (o.stopReason && typeof o.message === 'string') return o.message;
  } catch { /* ignore */ }
  return '';
}
