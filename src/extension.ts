import * as vscode from 'vscode';
import { DshAcp } from './dshAcp';
import {
  formatSessionForDsh,
  listOpencodeSessions,
  readOpencodeSessionMessages,
  resolveOpencodeDbPath,
  type OpencodeSession,
} from './opencodeHistory';

class OpencodeTreeProvider implements vscode.TreeDataProvider<OpencodeItem> {
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private cache: OpencodeSession[] = [];
  private error?: string;

  constructor(private output: vscode.OutputChannel) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(el: OpencodeItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<OpencodeItem[]> {
    const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
    const { path: dbPath, source } = resolveOpencodeDbPath(override);
    if (!dbPath) {
      this.error = 'OPENCODE_DB=:memory: — history is ephemeral.';
      return [new OpencodeItem('No persistent history (in-memory DB)', vscode.TreeItemCollapsibleState.None)];
    }
    try {
      this.cache = await listOpencodeSessions(dbPath, 100);
      if (!this.cache.length) return [new OpencodeItem('(no opencode sessions found)', vscode.TreeItemCollapsibleState.None)];
      this.output.appendLine(`[opencode] ${this.cache.length} sessions from ${dbPath} (${source})`);
      const groups = new Map<string, OpencodeSession[]>();
      for (const s of this.cache) {
        const key = s.projectName || s.directory || 'other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(s);
      }
      if (groups.size <= 1) return this.cache.map((s) => new OpencodeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None, s));
      const out: OpencodeItem[] = [];
      for (const [name, sessions] of groups) {
        const group = new OpencodeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
        group.children = sessions.map((s) => new OpencodeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None, s));
        out.push(group);
      }
      return out;
    } catch (e) {
      this.error = (e as Error).message;
      this.output.appendLine(`[opencode] read failed: ${this.error}`);
      return [new OpencodeItem('opencode history unavailable — see Output', vscode.TreeItemCollapsibleState.None)];
    }
  }
}

class OpencodeItem extends vscode.TreeItem {
  children?: OpencodeItem[];
  session?: OpencodeSession;
  constructor(label: string, state: vscode.TreeItemCollapsibleState, session?: OpencodeSession) {
    super(label, state);
    this.session = session;
    if (session) {
      this.description = session.directory;
      this.tooltip = `${session.title}\n${session.id}${session.directory ? `\n${session.directory}` : ''}`;
      this.command = { command: 'deepseekHarness.openOpencodeSession', title: 'Open opencode Session', arguments: [session] };
      this.contextValue = 'opencodeSession';
    }
  }
}

function sessionLabel(s: OpencodeSession): string {
  const date = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
  return `${s.title}${date ? ` — ${date}` : ''}`;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness');
  context.subscriptions.push(output);
  const dsh = new DshAcp(output);
  context.subscriptions.push({ dispose: () => dsh.dispose() });

  const tree = new OpencodeTreeProvider(output);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('deepseekHarness.opencodeHistory', tree)
  );

  // Chat webview
  const chatProvider = new DshChatViewProvider(context, output, dsh);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('deepseekHarness.chat', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.refreshOpencode', () => tree.refresh()),
    vscode.commands.registerCommand('deepseekHarness.openDshChat', async () => {
      await vscode.commands.executeCommand('deepseekHarness.chat.focus');
    }),
    vscode.commands.registerCommand('deepseekHarness.newDshSession', async () => {
      const id = await dsh.newSession();
      void vscode.window.showInformationMessage(`DeepSeek Harness: new session ${id}`);
      chatProvider.setSession(id);
    }),
    vscode.commands.registerCommand('deepseekHarness.openOpencodeSession', async (session?: OpencodeSession) => {
      if (!session) return;
      const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
      const { path: dbPath } = resolveOpencodeDbPath(override);
      try {
        const messages = await readOpencodeSessionMessages(dbPath, session.id, 200);
        const doc = await vscode.workspace.openTextDocument({
          content: `# ${session.title}\n\n${messages.map((m) => `## ${m.role}\n\n${m.text}`).join('\n\n')}`,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode read failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('deepseekHarness.sendOpencodeToDsh', async (session?: OpencodeSession) => {
      const target: OpencodeSession | undefined =
        session ?? (await pickOpencodeSessionFromTree(tree));
      if (!target) {
        void vscode.window.showWarningMessage('No opencode session selected.');
        return;
      }
      const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
      const { path: dbPath } = resolveOpencodeDbPath(override);
      try {
        const messages = await readOpencodeSessionMessages(dbPath, target.id, 120);
        const contextText = formatSessionForDsh(target, messages);
        await vscode.commands.executeCommand('deepseekHarness.chat.focus');
        await chatProvider.sendContextAndPrompt(
          `Here is a past opencode session for reference:\n\n${contextText}\n\n---\nContinue / answer based on it: `,
          target
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`Send to DSH failed: ${(e as Error).message}`);
      }
    })
  );

  output.appendLine('[dsh] extension activated. Configure deepseekHarness.cliPath if dsh is not on PATH.');
}

async function pickOpencodeSessionFromTree(tree: OpencodeTreeProvider): Promise<OpencodeSession | undefined> {
  const items = await tree.getChildren();
  const flat: OpencodeSession[] = [];
  for (const it of items) {
    if (it.session) flat.push(it.session);
    for (const c of it.children ?? []) if (c.session) flat.push(c.session);
  }
  if (!flat.length) return undefined;
  const pick = await vscode.window.showQuickPick(
    flat.map((s) => ({ label: sessionLabel(s), description: s.directory, session: s })),
    { placeHolder: 'Pick an opencode session to send to DSH' }
  );
  return (pick as { session?: OpencodeSession } | undefined)?.session;
}

class DshChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: { role: 'user' | 'dsh'; text: string }[] = [];
  private pendingContext = '';

  constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private dsh: DshAcp
  ) {
    dsh.onStreamingUpdate((text) => {
      if (text) void this.view?.webview.postMessage({ type: 'stream', text });
    });
  }

  setSession(id: string): void {
    this.history = [];
    void this.view?.webview.postMessage({ type: 'session', sessionId: id });
  }

  async sendContextAndPrompt(prefix: string, session: OpencodeSession): Promise<void> {
    this.pendingContext = prefix;
    void this.view?.webview.postMessage({ type: 'prefill', text: prefix, hint: `Context loaded: ${session.title}` });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'prompt') {
        const text: string = String(msg.text ?? '');
        if (!text.trim()) return;
        this.history.push({ role: 'user', text });
        void view.webview.postMessage({ type: 'user', text });
        void view.webview.postMessage({ type: 'thinking' });
        try {
          const res = await this.dsh.prompt(text);
          this.history.push({ role: 'dsh', text: res.text });
          void view.webview.postMessage({ type: 'answer', text: res.text, sessionId: res.sessionId });
        } catch (e) {
          const err = `DSH request failed: ${(e as Error).message}`;
          this.output.appendLine(`[dsh] ${err}`);
          void view.webview.postMessage({ type: 'answer', text: err });
        }
      }
      if (msg?.type === 'newSession') {
        const id = await this.dsh.newSession();
        this.setSession(id);
      }
    });
  }

  private html(): string {
    const nonce = String(Date.now().toString(36));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:var(--vscode-font-family);padding:10px;color:var(--vscode-foreground)}
#log{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.msg{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px;white-space:pre-wrap}
.user{background:var(--vscode-editor-inactiveSelectionBackground)}
.dsh{background:var(--vscode-editor-background)}
.row{display:flex;gap:6px}
textarea{flex:1;min-height:64px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:6px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.hint{opacity:.75;font-size:12px;margin-bottom:6px}
</style></head><body>
<div class="hint" id="hint">DSH chat via <code>dsh --profile acp</code>. Use “Send opencode Session to DSH” from the opencode History view to attach past context.</div>
<div id="log"></div>
<div class="row"><textarea id="in" placeholder="Ask DeepSeek Harness…"></textarea></div>
<div class="row" style="margin-top:6px"><button id="send">Send</button><button id="new" class="secondary">New session</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('in');
function add(cls, text){ const d=document.createElement('div'); d.className='msg '+cls; d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight; }
document.getElementById('send').onclick=()=>{ const t=input.value; input.value=''; vscode.postMessage({type:'prompt', text:t}); };
document.getElementById('new').onclick=()=>vscode.postMessage({type:'newSession'});
input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ document.getElementById('send').click(); } });
window.addEventListener('message', e=>{ const m=e.data;
 if(m.type==='user') add('user', m.text);
 if(m.type==='answer') add('dsh', (m.sessionId?('['+m.sessionId+']\\n'):'')+m.text);
 if(m.type==='stream') add('dsh', m.text);
 if(m.type==='thinking') add('dsh', '…thinking (ACP session/prompt)…');
 if(m.type==='prefill'){ input.value=m.text||''; document.getElementById('hint').textContent=m.hint||''; }
 if(m.type==='session'){ log.innerHTML=''; add('dsh','New DSH session: '+m.sessionId); }
});
</script></body></html>`;
  }
}

export function deactivate(): void {
  // disposed via subscriptions
}
