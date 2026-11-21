import * as vscode from 'vscode';
import { DshAcp } from './dshAcp';
import {
  formatSessionForDsh,
  listOpencodeSessions,
  readOpencodeSessionMessages,
  resolveOpencodeDbPath,
  type OpencodeSession,
} from './opencodeHistory';

// ---------- opencode history (sidebar) ----------

class OpencodeTreeProvider implements vscode.TreeDataProvider<OpencodeItem> {
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private output: vscode.OutputChannel) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(el: OpencodeItem): vscode.TreeItem {
    return el;
  }

  async getChildren(element?: OpencodeItem): Promise<OpencodeItem[]> {
    if (element?.children) return element.children;
    if (element?.session) return [];
    const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
    const { path: dbPath, source } = resolveOpencodeDbPath(override);
    if (!dbPath) {
      return [new OpencodeItem('No persistent history (in-memory DB)', vscode.TreeItemCollapsibleState.None)];
    }
    try {
      const sessions = await listOpencodeSessions(dbPath, 100);
      if (!sessions.length) return [new OpencodeItem('(no opencode sessions found)', vscode.TreeItemCollapsibleState.None)];
      this.output.appendLine(`[opencode] ${sessions.length} sessions from ${dbPath} (${source})`);
      const groups = new Map<string, OpencodeSession[]>();
      for (const s of sessions) {
        const key = s.projectName || s.directory || 'other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(s);
      }
      if (groups.size <= 1) return sessions.map((s) => new OpencodeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None, s));
      const out: OpencodeItem[] = [];
      for (const [name, list] of groups) {
        const group = new OpencodeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
        group.children = list.map((s) => new OpencodeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None, s));
        out.push(group);
      }
      return out;
    } catch (e) {
      this.output.appendLine(`[opencode] read failed: ${(e as Error).message}`);
      return [new OpencodeItem('opencode history unavailable — see Output', vscode.TreeItemCollapsibleState.None)];
    }
  }
}

class OpencodeItem extends vscode.TreeItem {
  children?: OpencodeItem[];
  session?: OpencodeSession;
  constructor(label: string, state: vscode.TreeItemCollapsibleState, session?: OpencodeSession) {
    super(label, state);
    this.id = session ? `ses-${session.id}` : `grp-${label}`;
    this.session = session;
    if (session) {
      this.description = session.directory;
      this.tooltip = `${session.title}\n${session.id}${session.directory ? `\n${session.directory}` : ''}`;
      this.command = { command: 'deepseekHarness.openOpencodeSession', title: 'Open opencode Session', arguments: [session] };
      this.contextValue = 'opencodeSession';
    } else if (state !== vscode.TreeItemCollapsibleState.None) {
      this.contextValue = 'opencodeGroup';
    }
  }
}

function unwrapSession(arg: unknown): OpencodeSession | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const o = arg as Record<string, unknown>;
  if (o.session && typeof o.session === 'object') return o.session as OpencodeSession;
  if (typeof o.id === 'string' && typeof o.title === 'string') return o as unknown as OpencodeSession;
  return undefined;
}

function sessionLabel(s: OpencodeSession): string {
  const date = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
  return `${s.title}${date ? ` — ${date}` : ''}`;
}

async function openSessionDoc(session: OpencodeSession): Promise<void> {
  const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
  const { path: dbPath } = resolveOpencodeDbPath(override);
  const messages = await readOpencodeSessionMessages(dbPath, session.id, 200);
  const doc = await vscode.workspace.openTextDocument({
    content: `# ${session.title}\n\n> id: ${session.id}${session.directory ? `\n> directory: ${session.directory}` : ''}${session.projectName ? `\n> project: ${session.projectName}` : ''}\n\n${messages.map((m) => `## ${m.role}\n\n${m.text}`).join('\n\n')}`,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

// ---------- DSH sessions (sidebar) ----------

class DshSessionItem extends vscode.TreeItem {
  constructor(public sessionId: string, public title: string | undefined, active: boolean) {
    super(active ? `● ${sessionId}` : sessionId, vscode.TreeItemCollapsibleState.None);
    this.id = `dsh-${sessionId}`;
    this.description = title;
    this.tooltip = active ? `Active DSH session\n${sessionId}` : `DSH session\n${sessionId}\nClick to switch`;
    this.command = { command: 'deepseekHarness.selectDshSession', title: 'Switch to DSH Session', arguments: [sessionId] };
    this.contextValue = 'dshSession';
    this.iconPath = new vscode.ThemeIcon(active ? 'comment-pinned' : 'comment');
  }
}

class DshSessionProvider implements vscode.TreeDataProvider<DshSessionItem> {
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private dsh: DshAcp, private output: vscode.OutputChannel) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(el: DshSessionItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<DshSessionItem[]> {
    try {
      const sessions = await this.dsh.listSessions();
      const active = this.dsh.activeSessionId;
      if (!sessions.length && active) return [new DshSessionItem(active, 'current', true)];
      return sessions.map((s) => new DshSessionItem(s.sessionId, s.title, s.sessionId === active));
    } catch (e) {
      this.output.appendLine(`[dsh] sessions read failed: ${(e as Error).message}`);
      const active = this.dsh.activeSessionId;
      return active ? [new DshSessionItem(active, 'current', true)] : [];
    }
  }
}

// ---------- Main chat in the editor ----------

type ChatMsg = { role: 'user' | 'dsh'; text: string; sessionId?: string };

class ChatEditorManager {
  private panel?: vscode.WebviewPanel;
  private transcripts = new Map<string, ChatMsg[]>();

  constructor(private context: vscode.ExtensionContext, private output: vscode.OutputChannel, private dsh: DshAcp) {
    dsh.onStreamingUpdate((text) => {
      if (text) void this.panel?.webview.postMessage({ type: 'stream', text });
    });
  }

  open(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel('deepseekHarness.chatEditor', 'DSH Chat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = chatHtml();
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'prompt') {
        const text: string = String(msg.text ?? '');
        if (!text.trim()) return;
        const sid = this.dsh.activeSessionId ?? (await this.dsh.ensureSession());
        this.append(sid, { role: 'user', text });
        void panel.webview.postMessage({ type: 'user', text });
        void panel.webview.postMessage({ type: 'thinking' });
        try {
          const res = await this.dsh.prompt(text);
          this.append(res.sessionId, { role: 'dsh', text: res.text, sessionId: res.sessionId });
          void panel.webview.postMessage({ type: 'answer', text: res.text, sessionId: res.sessionId });
        } catch (e) {
          const err = `DSH request failed: ${(e as Error).message}`;
          this.output.appendLine(`[dsh] ${err}`);
          void panel.webview.postMessage({ type: 'answer', text: err });
        }
      }
      if (msg?.type === 'newSession') {
        const id = await this.dsh.newSession();
        this.setSession(id);
      }
    });
    this.panel = panel;
    const active = this.dsh.activeSessionId;
    if (active) void panel.webview.postMessage({ type: 'session', sessionId: active, history: this.transcripts.get(active) ?? [] });
    return panel;
  }

  private append(sessionId: string, msg: ChatMsg): void {
    const list = this.transcripts.get(sessionId) ?? [];
    list.push(msg);
    this.transcripts.set(sessionId, list.slice(-200));
  }

  setSession(id: string): void {
    void this.open().webview.postMessage({ type: 'session', sessionId: id, history: this.transcripts.get(id) ?? [] });
  }

  async sendContextAndPrompt(prefix: string, session: OpencodeSession): Promise<void> {
    this.open();
    void this.panel?.webview.postMessage({ type: 'prefill', text: prefix, hint: `Context loaded: ${session.title}` });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness');
  context.subscriptions.push(output);
  const dsh = new DshAcp(output);
  context.subscriptions.push({ dispose: () => dsh.dispose() });

  const opencodeTree = new OpencodeTreeProvider(output);
  const sessionTree = new DshSessionProvider(dsh, output);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('deepseekHarness.opencodeHistory', opencodeTree),
    vscode.window.registerTreeDataProvider('deepseekHarness.sessions', sessionTree)
  );

  const chat = new ChatEditorManager(context, output, dsh);

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.openChatEditor', async () => {
      chat.open();
    }),
    vscode.commands.registerCommand('deepseekHarness.openDshChat', async () => {
      chat.open();
    }),
    vscode.commands.registerCommand('deepseekHarness.refreshOpencode', () => opencodeTree.refresh()),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', () => sessionTree.refresh()),
    vscode.commands.registerCommand('deepseekHarness.newDshSession', async () => {
      const id = await dsh.newSession();
      sessionTree.refresh();
      chat.setSession(id);
      void vscode.window.showInformationMessage(`DeepSeek Harness: new session ${id} (chat in editor)`);
    }),
    vscode.commands.registerCommand('deepseekHarness.selectDshSession', async (sessionId?: unknown) => {
      const id = typeof sessionId === 'string' ? sessionId : undefined;
      if (!id) return;
      await dsh.switchTo(id);
      sessionTree.refresh();
      chat.setSession(id);
    }),
    vscode.commands.registerCommand('deepseekHarness.openOpencodeSession', async (arg?: unknown) => {
      const session = unwrapSession(arg) ?? (await pickOpencodeSession(opencodeTree));
      if (!session) {
        void vscode.window.showWarningMessage('No opencode session selected.');
        return;
      }
      // 1) Open the transcript file…
      try {
        await openSessionDoc(session);
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode read failed: ${(e as Error).message}`);
        return;
      }
      // 2) …and switch the editor chat to it (file alone is not enough).
      try {
        const messages = await readCurrentOpencodeMessages(session.id);
        const contextText = formatSessionForDsh(session, messages);
        const sid = dsh.activeSessionId ?? (await dsh.ensureSession());
        sessionTree.refresh();
        chat.setSession(sid);
        await chat.sendContextAndPrompt(
          `Here is past opencode session "${session.title}" for reference:\n\n${contextText}\n\n---\nContinue / answer based on it: `,
          session
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`Switch chat to opencode session failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('deepseekHarness.sendOpencodeToDsh', async (arg?: unknown) => {
      const target = unwrapSession(arg) ?? (await pickOpencodeSession(opencodeTree));
      if (!target) {
        void vscode.window.showWarningMessage('No opencode session selected.');
        return;
      }
      try {
        const messages = await readCurrentOpencodeMessages(target.id);
        const contextText = formatSessionForDsh(target, messages);
        const sid = dsh.activeSessionId ?? (await dsh.ensureSession());
        sessionTree.refresh();
        chat.setSession(sid);
        await chat.sendContextAndPrompt(
          `Here is a past opencode session for reference:\n\n${contextText}\n\n---\nContinue / answer based on it: `,
          target
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`Send to DSH failed: ${(e as Error).message}`);
      }
    })
  );

  output.appendLine('[dsh] extension activated. Sidebar = sessions + history; main chat opens in the editor.');
}

async function readCurrentOpencodeMessages(sessionId: string) {
  const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
  const { path: dbPath } = resolveOpencodeDbPath(override);
  return readOpencodeSessionMessages(dbPath, sessionId, 120);
}

async function pickOpencodeSession(tree: OpencodeTreeProvider): Promise<OpencodeSession | undefined> {
  const items = await tree.getChildren();
  const flat: OpencodeSession[] = [];
  for (const it of items) {
    if (it.session) flat.push(it.session);
    for (const c of it.children ?? []) if (c.session) flat.push(c.session);
  }
  if (!flat.length) return undefined;
  const pick = await vscode.window.showQuickPick(
    flat.map((s) => ({ label: sessionLabel(s), description: s.directory, session: s })),
    { placeHolder: 'Pick an opencode session' }
  );
  return (pick as { session?: OpencodeSession } | undefined)?.session;
}

function chatHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--dsh-accent:#4d6bfe;--dsh-accent-soft:rgba(77,107,254,.14);color-scheme:dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh}
.dsh-top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);position:sticky;top:0;z-index:2}
.dsh-logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#4d6bfe,#38bdf8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:14px;flex:none}
.dsh-title{font-weight:700;font-size:14px;line-height:1.1}
.dsh-sub{font-size:11px;opacity:.65}
.dsh-pills{margin-left:auto;display:flex;gap:6px;align-items:center}
.pill{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:20px;padding:3px 10px;opacity:.9;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block}
.dot.busy{background:#d29922;animation:pulse 1s infinite alternate}
@keyframes pulse{from{opacity:.4}to{opacity:1}}
.iconbtn{border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
.dsh-tabs{display:flex;gap:4px;padding:10px 16px 0;max-width:1100px;width:100%;margin:0 auto}
.tab{border:0;background:transparent;color:var(--vscode-foreground);opacity:.6;font-size:12px;font-weight:600;padding:6px 10px;border-bottom:2px solid transparent;cursor:pointer}
.tab.active{opacity:1;border-bottom-color:var(--dsh-accent)}
#ctxchip{display:none;margin:10px auto 0;max-width:1100px;width:calc(100% - 32px);font-size:11px;background:var(--dsh-accent-soft);border:1px solid var(--dsh-accent);border-radius:8px;padding:6px 8px}
#ctxchip.show{display:block}
#ctxchip button{float:right;border:0;background:transparent;color:inherit;cursor:pointer}
#log{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;max-width:1100px;width:100%;margin:0 auto}
.day{font-size:11px;opacity:.55;text-align:center}
.rowmsg{display:flex;gap:8px;align-items:flex-start}
.avatar{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}
.avatar.dsh{background:linear-gradient(135deg,#4d6bfe,#38bdf8);color:#fff}
.avatar.user{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.bubble{max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:12px;padding:9px 11px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55;background:var(--vscode-editor-background)}
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
.composer{border-top:1px solid var(--vscode-panel-border);padding:12px 16px 14px;background:var(--vscode-editor-background)}
.box{border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);border-radius:12px;padding:8px;max-width:1100px;margin:0 auto}
textarea{width:100%;border:0;background:transparent;color:var(--vscode-input-foreground);resize:none;min-height:56px;max-height:200px;font-family:inherit;font-size:13px;outline:none}
.bar{display:flex;gap:6px;align-items:center;margin-top:6px}
.hintline{font-size:10.5px;opacity:.55}
.send{margin-left:auto;width:32px;height:32px;border-radius:50%;border:0;background:var(--dsh-accent);color:#fff;font-size:16px;cursor:pointer;flex:none}
.send:disabled{opacity:.4;cursor:default}
.modelchip{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:2px 6px;opacity:.85}
code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:4px}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:8px;overflow:auto}
</style></head><body>
<div class="dsh-top">
<div class="dsh-logo">DS</div>
<div><div class="dsh-title">DeepSeek Harness</div><div class="dsh-sub" id="sessline">editor console · acp</div></div>
<div class="dsh-pills"><span class="pill"><span class="dot" id="statusdot"></span> <span id="statustext">idle</span></span><span class="pill" id="modelpill">deepseek-v4</span><button class="iconbtn" id="new">+ New session</button></div>
</div>
<div class="dsh-tabs"><button class="tab active" id="tabchat">Chat</button><button class="tab" id="tabtraj">Trajectory</button></div>
<div id="ctxchip"><button id="ctxx" title="Clear context">✕</button><span id="ctxtext"></span></div>
<div id="log"><div class="day">Sidebar lists sessions + history. This editor tab is the main chat — it switches when you click history.</div></div>
<div class="composer"><div class="box">
<textarea id="in" placeholder="Ask DeepSeek Harness…  (Ctrl+Enter to send · / commands · @ references)"></textarea>
<div class="bar"><span class="modelchip">cwd: workspace</span><span class="hintline">ACP: session/prompt · streaming updates</span><button class="send" id="send" title="Send">↑</button></div>
</div></div>
<script>
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
document.getElementById('tabchat').onclick=()=>{ mode='chat'; document.getElementById('tabchat').className='tab active'; document.getElementById('tabtraj').className='tab'; };
document.getElementById('tabtraj').onclick=()=>{ mode='traj'; document.getElementById('tabtraj').className='tab active'; document.getElementById('tabchat').className='tab'; };
input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ send(); } });
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(200,input.scrollHeight)+'px'; });
window.addEventListener('message', e=>{ const m=e.data;
 if(m.type==='answer'){ rmThinking(); setBusy(false); if(mode==='chat'||/tool|call|traject/i.test(m.text)) addDsh(m.text, m.sessionId); if(m.sessionId) sessline.textContent='session '+m.sessionId; }
 if(m.type==='stream'){ rmThinking(); setBusy(true); bubble('dsh', fmt(m.text), '<span>live update</span>'); setBusy(false); }
 if(m.type==='prefill'){ input.value=m.text||''; ctxtext.textContent=m.hint||'opencode context attached'; ctxchip.className='show'; input.focus(); }
 if(m.type==='session'){ log.innerHTML=''; sessline.textContent='session '+m.sessionId; setBusy(false); (m.history||[]).forEach(h=>{ if(h.role==='user') addUser(h.text); else addDsh(h.text, h.sessionId); }); if(!(m.history||[]).length) bubble('dsh','Switched session: '+esc(m.sessionId)+'<br>Ask anything — history clicks land here now.','<span>'+esc(m.sessionId)+'</span>'); }
});
</script></body></html>`;
}

export function deactivate(): void {
  // disposed via subscriptions
}
