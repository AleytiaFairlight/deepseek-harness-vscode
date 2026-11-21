import * as vscode from 'vscode';
import { DshAcp, PROVIDER_ENV } from './dshAcp';
import { SettingsManager, PROVIDER_CATALOG, refreshDshEnv } from './settingsPanel';
import { chatHtml } from './chatHtml';
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
    super(title || sessionId, vscode.TreeItemCollapsibleState.None);
    this.id = `dsh-${sessionId}`;
    this.description = active ? '● active' : sessionId.slice(0, 12);
    this.tooltip = `${title || sessionId}\n${sessionId}${active ? '\n(active)' : '\nClick to switch · right-click to rename'}`;
    this.command = { command: 'deepseekHarness.selectDshSession', title: 'Switch to DSH Session', arguments: [sessionId] };
    this.contextValue = 'dshSession';
    this.iconPath = new vscode.ThemeIcon(active ? 'comment-pinned' : 'comment');
  }
}

function getAliases(context: vscode.ExtensionContext): Record<string, string> {
  return context.globalState.get<Record<string, string>>('dshSessionTitles', {});
}

function getKnownSessions(context: vscode.ExtensionContext): string[] {
  return context.globalState.get<string[]>('dsh.sessionList', []);
}

async function rememberSession(context: vscode.ExtensionContext, sessionId: string): Promise<void> {
  const list = getKnownSessions(context);
  if (!list.includes(sessionId)) await context.globalState.update('dsh.sessionList', [sessionId, ...list].slice(0, 50));
}

class DshSessionProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private context: vscode.ExtensionContext, private dsh: DshAcp, private output: vscode.OutputChannel) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  private alias(id: string): string | undefined {
    return getAliases(this.context)[id];
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    let server: { sessionId: string; title?: string }[] = [];
    try {
      server = await this.dsh.listSessions();
    } catch (e) {
      this.output.appendLine(`[dsh] sessions read failed: ${(e as Error).message}`);
    }
    const active = this.dsh.activeSessionId;
    const known = getKnownSessions(this.context);
    const ids = new Map<string, string | undefined>();
    for (const s of server) ids.set(s.sessionId, s.title);
    for (const id of known) if (!ids.has(id)) ids.set(id, undefined);
    if (active && !ids.has(active)) ids.set(active, 'current');
    if (!ids.size) {
      const empty = new vscode.TreeItem('No DSH sessions — click to start one', vscode.TreeItemCollapsibleState.None);
      empty.command = { command: 'deepseekHarness.newDshSession', title: 'New DSH Session' };
      empty.iconPath = new vscode.ThemeIcon('add');
      return [empty];
    }
    const titleOf = (sid: string, t?: string) => this.alias(sid) ?? t ?? sid;
    return [...ids.entries()].map(([sid, t]) => new DshSessionItem(sid, titleOf(sid, t), sid === active));
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
        const aliases = this.context.globalState.get<Record<string, string>>('dshSessionTitles', {});
        this.setSession(id, aliases[id]);
      }
      if (msg?.type === 'modelSetup') {
        void vscode.commands.executeCommand('deepseekHarness.setupModel');
      }
      if (msg?.type === 'openSettings') {
        void vscode.commands.executeCommand('deepseekHarness.openSettings');
      }
    });
    this.panel = panel;
    const active = this.dsh.activeSessionId;
    const aliases = this.context.globalState.get<Record<string, string>>('dshSessionTitles', {});
    const perm0 = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionPreset', 'workspace-write');
    void panel.webview.postMessage({
      type: 'init',
      sessionId: active,
      title: active ? aliases[active] : undefined,
      history: active ? this.transcripts.get(active) ?? [] : [],
      model: this.dsh.getModel(),
      permissionPreset: perm0,
    });
    return panel;
  }

  private append(sessionId: string, msg: ChatMsg): void {
    const list = this.transcripts.get(sessionId) ?? [];
    list.push(msg);
    this.transcripts.set(sessionId, list.slice(-200));
  }

  setSession(id: string, title?: string): void {
    const perm = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionPreset', 'workspace-write');
    void this.open().webview.postMessage({ type: 'session', sessionId: id, title, history: this.transcripts.get(id) ?? [], model: this.dsh.getModel(), permissionPreset: perm });
  }

  pushModel(): void {
    const perm = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionPreset', 'workspace-write');
    void this.panel?.webview.postMessage({ type: 'model', model: this.dsh.getModel(), permissionPreset: perm });
  }

  /** Load opencode history as chat bubbles (not as a prompt draft). */
  loadOpencodeAsChat(opencode: OpencodeSession, msgs: ChatMsg[]): void {
    const sid = this.dsh.activeSessionId ?? 'opencode-view';
    this.transcripts.set(sid, msgs.slice(-200));
    this.open();
    const perm = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionPreset', 'workspace-write');
    void this.panel?.webview.postMessage({
      type: 'session',
      sessionId: sid,
      title: opencode.title,
      opencodeId: opencode.id,
      history: msgs.slice(-200),
      model: this.dsh.getModel(),
      permissionPreset: perm,
    });
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
  const sessionTree = new DshSessionProvider(context, dsh, output);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('deepseekHarness.opencodeHistory', opencodeTree),
    vscode.window.registerTreeDataProvider('deepseekHarness.sessions', sessionTree)
  );

  const chat = new ChatEditorManager(context, output, dsh);
  const settings = new SettingsManager(context, dsh, () => {
    sessionTree.refresh();
    chat.pushModel();
  });
  void refreshDshEnv(context, dsh).then(() => chat.pushModel());

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.openChatEditor', async () => {
      chat.open();
    }),
    vscode.commands.registerCommand('deepseekHarness.openDshChat', async () => {
      chat.open();
    }),
    vscode.commands.registerCommand('deepseekHarness.openSettings', async () => {
      settings.open();
    }),
    vscode.commands.registerCommand('deepseekHarness.refreshOpencode', () => opencodeTree.refresh()),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', () => sessionTree.refresh()),
    vscode.commands.registerCommand('deepseekHarness.newDshSession', async () => {
      const id = await dsh.newSession();
      await rememberSession(context, id);
      sessionTree.refresh();
      const aliases = getAliases(context);
      chat.setSession(id, aliases[id]);
      chat.pushModel();
    }),
    vscode.commands.registerCommand('deepseekHarness.selectDshSession', async (sessionId?: unknown) => {
      const id = typeof sessionId === 'string' ? sessionId : undefined;
      if (!id) return;
      await dsh.switchTo(id);
      await rememberSession(context, id);
      sessionTree.refresh();
      const aliases = getAliases(context);
      chat.setSession(id, aliases[id]);
      chat.pushModel();
    }),
    vscode.commands.registerCommand('deepseekHarness.renameDshSession', async (sessionId?: unknown) => {
      const id = typeof sessionId === 'string' ? sessionId : dsh.activeSessionId;
      if (!id) {
        void vscode.window.showWarningMessage('No DSH session to rename.');
        return;
      }
      const aliases = getAliases(context);
      const current = aliases[id] ?? id;
      const next = await vscode.window.showInputBox({
        prompt: `Rename DSH session ${id}`,
        value: current,
        placeHolder: 'Friendly session name',
      });
      if (next === undefined) return;
      const trimmed = next.trim();
      const updated = { ...aliases };
      if (trimmed && trimmed !== id) updated[id] = trimmed;
      else delete updated[id];
      await context.globalState.update('dshSessionTitles', updated);
      sessionTree.refresh();
      chat.setSession(id, updated[id]);
    }),
    vscode.commands.registerCommand('deepseekHarness.setupModel', async () => {
      // Harness-style: pick a shipped provider (or opencode gateway / custom), paste API key, pick model.
      const current = dsh.getModel();
      const items = PROVIDER_CATALOG.map((p) => ({
        label: p.label,
        description: p.id === current.provider ? '(current)' : p.env ? p.env : undefined,
        id: p.id,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `Provider (current: ${current.provider}/${current.model}) — or open Settings for full form` });
      if (!picked) return;
      if (picked.id === 'custom') {
        settings.open();
        return;
      }
      let providerId = picked.id;
      // API key inline (optional — Settings holds the full write-only form). Blank keeps saved/env.
      const envName = PROVIDER_ENV[providerId] ?? `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
      const savedKey = await context.secrets.get(`dsh.apikey.${providerId}`);
      const keyInput = await vscode.window.showInputBox({
        prompt: `API key for ${providerId} (${savedKey ? 'saved •••• — blank keeps it' : `blank uses env ${envName}`})`,
        password: true,
        placeHolder: savedKey ? 'saved •••• (blank = keep)' : `paste key or leave blank for env ${envName}`,
      });
      if (keyInput === undefined) return;
      if (keyInput.trim()) {
        await context.secrets.store(`dsh.apikey.${providerId}`, keyInput.trim());
        await refreshDshEnv(context, dsh);
      } else if (!savedKey) {
        void vscode.window.showWarningMessage(`No saved key for ${providerId}; will try env ${envName}. Add one in DSH Settings → Models for reliability.`);
      }
      // Model list: DeepSeek + custom provider models when known.
      let models: string[] = ['custom…'];
      if (providerId === 'deepseek-official') models = ['deepseek-v4', 'deepseek-v4-flash', 'deepseek-chat', 'custom…'];
      else if (providerId === 'anthropic') models = ['claude-sonnet-4-5', 'claude-opus-4-1', 'custom…'];
      else if (providerId === 'openai') models = ['gpt-5', 'gpt-4o', 'custom…'];
      else if (providerId === 'moonshotai') models = ['kimi-k2', 'custom…'];
      else if (providerId === 'zai') models = ['glm-4-5', 'custom…'];
      else if (providerId === 'opencode-gateway') {
        const custom = context.globalState.get<Record<string, string>>('dsh.customProvider', {});
        const list = (custom.models ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
        models = [...list, 'custom…'];
        if (providerId === 'opencode-gateway' && !custom.providerId) providerId = 'openai';
      } else {
        const custom = context.globalState.get<Record<string, string>>('dsh.customProvider', {});
        const list = providerId === (custom.providerId ?? '') && custom.models
          ? custom.models.split(/\n+/).map((s) => s.trim()).filter(Boolean)
          : [];
        models = [...list, 'custom…'];
      }
      const pick = await vscode.window.showQuickPick(models, { placeHolder: `Model for ${providerId} (current: ${current.model})` });
      if (!pick) return;
      let modelId = pick;
      if (pick === 'custom…') {
        const customM = await vscode.window.showInputBox({ prompt: `Model id for ${providerId}`, value: current.model });
        if (!customM?.trim()) return;
        modelId = customM.trim();
      }
      await dsh.setModel(providerId, modelId);
      await refreshDshEnv(context, dsh);
      chat.pushModel();
      sessionTree.refresh();
      void vscode.window.showInformationMessage(`DSH model: ${providerId}/${modelId} (key: ${savedKey || keyInput.trim() ? 'saved/env' : 'env-only'})`);
    }),
    vscode.commands.registerCommand('deepseekHarness.openOpencodeSession', async (arg?: unknown) => {
      // Click = load into the editor chat as transcript. No editable file is opened.
      const session = unwrapSession(arg) ?? (await pickOpencodeSession(opencodeTree));
      if (!session) {
        void vscode.window.showWarningMessage('No opencode session selected.');
        return;
      }
      try {
        const raw = await readCurrentOpencodeMessages(session.id);
        const msgs: ChatMsg[] = raw.map((m) => ({
          role: /user/i.test(m.role) ? 'user' : 'dsh',
          text: m.text,
        }));
        chat.loadOpencodeAsChat(session, msgs);
        sessionTree.refresh();
      } catch (e) {
        void vscode.window.showErrorMessage(`Open opencode session failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('deepseekHarness.openOpencodeFile', async (arg?: unknown) => {
      // Explicit opt-in: open a read-only preview of the transcript (no editing).
      const session = unwrapSession(arg) ?? (await pickOpencodeSession(opencodeTree));
      if (!session) return;
      try {
        const override = vscode.workspace.getConfiguration('deepseekHarness').get<string>('opencodeDbPath', '');
        const { path: dbPath } = resolveOpencodeDbPath(override);
        const messages = await readOpencodeSessionMessages(dbPath, session.id, 200);
        const doc = await vscode.workspace.openTextDocument({
          content: `# ${session.title} (read-only preview — use chat for follow-ups)\n\n> id: ${session.id}\n\n${messages.map((m) => `## ${m.role}\n\n${m.text}`).join('\n\n')}`,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } catch (e) {
        void vscode.window.showErrorMessage(`Open transcript file failed: ${(e as Error).message}`);
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

export function deactivate(): void {
  // disposed via subscriptions
}
