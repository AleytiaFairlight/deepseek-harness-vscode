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
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--dsh-accent:#4d6bfe;--dsh-accent-soft:rgba(77,107,254,.14);--dsh-card:var(--vscode-editor-background);color-scheme:dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;height:100vh}
.dsh-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);position:sticky;top:0;z-index:2}
.dsh-logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#4d6bfe,#38bdf8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;flex:none}
.dsh-title{font-weight:700;font-size:13px;line-height:1.1}
.dsh-sub{font-size:11px;opacity:.65}
.dsh-pills{margin-left:auto;display:flex;gap:6px;align-items:center}
.pill{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:20px;padding:2px 8px;opacity:.9;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block}
.dot.busy{background:#d29922;animation:pulse 1s infinite alternate}
@keyframes pulse{from{opacity:.4}to{opacity:1}}
.iconbtn{border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px}
.dsh-tabs{display:flex;gap:4px;padding:8px 12px 0}
.tab{border:0;background:transparent;color:var(--vscode-foreground);opacity:.6;font-size:12px;font-weight:600;padding:6px 10px;border-bottom:2px solid transparent;cursor:pointer}
.tab.active{opacity:1;border-bottom-color:var(--dsh-accent)}
#ctxchip{display:none;margin:8px 12px 0;font-size:11px;background:var(--dsh-accent-soft);border:1px solid var(--dsh-accent);border-radius:8px;padding:6px 8px}
#ctxchip.show{display:block}
#ctxchip button{float:right;border:0;background:transparent;color:inherit;cursor:pointer}
#log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.day{font-size:11px;opacity:.55;text-align:center}
.rowmsg{display:flex;gap:8px;align-items:flex-start}
.avatar{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}
.avatar.dsh{background:linear-gradient(135deg,#4d6bfe,#38bdf8);color:#fff}
.avatar.user{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.bubble{max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:12px;padding:9px 11px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.5;background:var(--vscode-editor-background)}
.rowmsg.user{flex-direction:row-reverse}
.rowmsg.user .bubble{background:var(--dsh-accent);border-color:var(--dsh-accent);color:#fff;border-top-right-radius:4px}
.rowmsg.dsh .bubble{border-top-left-radius:4px}
.meta{font-size:10.5px;opacity:.6;margin-top:5px;display:flex;gap:8px}
.meta button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:10.5px;opacity:.8}
.meta button:hover{opacity:1;text-decoration:underline}
.thinking{display:flex;gap:4px;align-items:center;padding:6px 2px;opacity:.8;font-size:12px}
.thinking i{width:6px;height:6px;border-radius:50%;background:var(--dsh-accent);display:inline-block;animation:b 1s infinite}
.thinking i:nth-child(2){animation-delay:.15s}.thinking i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,100%{opacity:.25}50%{opacity:1}}
.tool{font-size:11px;border:1px dashed var(--vscode-panel-border);border-radius:8px;padding:6px 8px;opacity:.9;background:var(--vscode-editor-inactiveSelectionBackground)}
.composer{border-top:1px solid var(--vscode-panel-border);padding:10px 12px 12px;background:var(--vscode-sideBar-background)}
.box{border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);border-radius:12px;padding:8px}
textarea{width:100%;border:0;background:transparent;color:var(--vscode-input-foreground);resize:none;min-height:56px;max-height:160px;font-family:inherit;font-size:12.5px;outline:none}
.bar{display:flex;gap:6px;align-items:center;margin-top:6px}
.hintline{font-size:10.5px;opacity:.55}
.send{margin-left:auto;width:30px;height:30px;border-radius:50%;border:0;background:var(--dsh-accent);color:#fff;font-size:15px;cursor:pointer;flex:none}
.send:disabled{opacity:.4;cursor:default}
.modelchip{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:2px 6px;opacity:.85}
code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:4px}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:8px;overflow:auto}
</style></head><body>
<div class="dsh-top">
<div class="dsh-logo">DS</div>
<div><div class="dsh-title">DeepSeek Harness</div><div class="dsh-sub" id="sessline">mini console · acp</div></div>
<div class="dsh-pills"><span class="pill"><span class="dot" id="statusdot"></span> <span id="statustext">idle</span></span><span class="pill" id="modelpill">deepseek-v4</span><button class="iconbtn" id="new">+ New</button></div>
</div>
<div class="dsh-tabs"><button class="tab active" id="tabchat">Chat</button><button class="tab" id="tabtraj">Trajectory</button></div>
<div id="ctxchip"><button id="ctxx" title="Clear context">✕</button><span id="ctxtext"></span></div>
<div id="log"><div class="day">This is a mini DeepSeek Harness console. Use “Send opencode Session to DSH” to attach history.</div></div>
<div class="composer"><div class="box">
<textarea id="in" placeholder="Ask DeepSeek Harness…  (Ctrl+Enter to send · / commands · @ references)"></textarea>
<div class="bar"><span class="modelchip" id="cwdchip">cwd: workspace</span><span class="hintline">ACP: session/prompt · streaming updates</span><button class="send" id="send" title="Send">↑</button></div>
</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('in');
const sendBtn = document.getElementById('send');
const sessline = document.getElementById('sessline');
const statusdot = document.getElementById('statusdot');
const statustext = document.getElementById('statustext');
const ctxchip = document.getElementById('ctxchip');
const ctxtext = document.getElementById('ctxtext');
let mode = 'chat';
let busy = false;
function setBusy(b){ busy=b; sendBtn.disabled=b; statusdot.className='dot'+(b?' busy':''); statustext.textContent=b?'running':'idle'; }
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function fmt(s){ return esc(s).replace(/\`([^\`]+)\`/g,'<code>$1</code>'); }
function bubble(side, html, meta){ const r=document.createElement('div'); r.className='rowmsg '+side; const a=document.createElement('div'); a.className='avatar '+side; a.textContent=side==='dsh'?'DS':'You'; const b=document.createElement('div'); b.className='bubble'; b.innerHTML=html; const w=document.createElement('div'); w.style.flex='1'; w.style.minWidth='0'; w.appendChild(b); if(meta){ const m=document.createElement('div'); m.className='meta'; m.innerHTML=meta; w.appendChild(m);} r.appendChild(a); r.appendChild(w); log.appendChild(r); log.scrollTop=log.scrollHeight; return b; }
function addUser(t){ bubble('user', fmt(t), ''); }
function addDsh(t, sid){ const m = sid?'<span>'+esc(sid)+'</span>':''; bubble('dsh', fmt(t), m+'<button data-copy="'+esc(t.slice(0,4000))+'">Copy</button>'); }
function addThinking(){ const d=document.createElement('div'); d.className='thinking'; d.id='thinking'; d.innerHTML='<i></i><i></i><i></i> thinking (ACP session/prompt)…'; log.appendChild(d); log.scrollTop=log.scrollHeight; }
function rmThinking(){ document.getElementById('thinking')?.remove(); }
log.addEventListener('click', e=>{ const b=e.target.closest('button[data-copy]'); if(b){ navigator.clipboard?.writeText(b.getAttribute('data-copy')||''); b.textContent='Copied'; setTimeout(()=>b.textContent='Copy',1200);} });
function send(){ const t=input.value; if(!t.trim()||busy) return; input.value=''; addUser(t); addThinking(); setBusy(true); vscode.postMessage({type:'prompt', text:t}); }
sendBtn.onclick=send;
document.getElementById('new').onclick=()=>vscode.postMessage({type:'newSession'});
document.getElementById('ctxx').onclick=()=>{ ctxchip.className=''; };
document.getElementById('tabchat').onclick=e=>{ mode='chat'; document.getElementById('tabchat').className='tab active'; document.getElementById('tabtraj').className='tab'; };
document.getElementById('tabtraj').onclick=e=>{ mode='traj'; document.getElementById('tabtraj').className='tab active'; document.getElementById('tabchat').className='tab'; };
input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ send(); } });
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(160,input.scrollHeight)+'px'; });
window.addEventListener('message', e=>{ const m=e.data;
 if(m.type==='user'){ /* already rendered optimistically */ }
 if(m.type==='answer'){ rmThinking(); setBusy(false); if(mode==='chat'||/tool|call|traject/i.test(m.text)) addDsh(m.text, m.sessionId); if(m.sessionId) sessline.textContent='session '+m.sessionId; }
 if(m.type==='stream'){ rmThinking(); setBusy(true); bubble('dsh', fmt(m.text), '<span>live update</span>'); setBusy(false); }
 if(m.type==='thinking'){ /* already shown */ }
 if(m.type==='prefill'){ input.value=m.text||''; ctxtext.textContent=m.hint||'opencode context attached'; ctxchip.className='show'; input.focus(); }
 if(m.type==='session'){ log.innerHTML=''; sessline.textContent='session '+m.sessionId; setBusy(false); bubble('dsh','New DSH session started.<br>Ask anything — this mini console mirrors the Harness chat flow.','<span>'+esc(m.sessionId)+'</span>'); }
});
</script></body></html>`;
  }
}

export function deactivate(): void {
  // disposed via subscriptions
}
