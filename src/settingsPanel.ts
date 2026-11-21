import * as vscode from 'vscode';
import { DshAcp } from './dshAcp';

/** DSH-style Settings tab: left nav + forms, mirroring the Harness settings page layout. */

export class SettingsManager {
  private panel?: vscode.WebviewPanel;

  constructor(private context: vscode.ExtensionContext, private dsh: DshAcp, private onChanged: () => void) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.pushValues();
      return;
    }
    const panel = vscode.window.createWebviewPanel('deepseekHarness.settings', 'DSH Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = settingsHtml();
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'get') {
        this.pushValues();
      }
      if (msg?.type === 'save') {
        const values = msg.values as Record<string, string> | undefined;
        if (!values) return;
        const cfg = vscode.workspace.getConfiguration('deepseekHarness');
        for (const [key, val] of Object.entries(values)) {
          await cfg.update(key, val || undefined, vscode.ConfigurationTarget.Global);
        }
        // Push model like Harness model-switch does.
        if (values.provider || values.model) {
          const cur = this.dsh.getModel();
          await this.dsh.setModel(values.provider || cur.provider, values.model || cur.model);
        }
        this.onChanged();
        void panel.webview.postMessage({ type: 'saved' });
        this.pushValues();
        void vscode.window.showInformationMessage('DSH Settings saved (mini Harness settings).');
      }
      if (msg?.type === 'setupModel') {
        void vscode.commands.executeCommand('deepseekHarness.setupModel');
      }
    });
    this.panel = panel;
    this.pushValues();
  }

  private pushValues(): void {
    if (!this.panel) return;
    const c = vscode.workspace.getConfiguration('deepseekHarness');
    const get = (k: string, d = '') => c.get<string>(k, d);
    void this.panel.webview.postMessage({
      type: 'values',
      values: {
        cliPath: get('cliPath', 'dsh'),
        profile: get('profile', 'acp'),
        defaultCwd: get('defaultCwd', ''),
        opencodeDbPath: get('opencodeDbPath', ''),
        provider: get('provider', 'deepseek-official'),
        model: get('model', 'deepseek-v4'),
        permissionPreset: get('permissionPreset', 'workspace-write'),
        reasoningEffort: get('reasoningEffort', ''),
        maxTokens: get('maxTokens', ''),
      },
      liveModel: this.dsh.getModel(),
    });
  }
}

function settingsHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--dsh-accent:#4d6bfe;color-scheme:dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.top{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--vscode-panel-border)}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#4d6bfe,#38bdf8);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800}
.title{font-size:15px;font-weight:700}.sub{font-size:11px;opacity:.6}
.wrap{display:flex;max-width:1100px;margin:0 auto;min-height:60vh}
.nav{width:210px;flex:none;border-right:1px solid var(--vscode-panel-border);padding:14px 10px;display:flex;flex-direction:column;gap:2px}
.nav button{border:0;background:transparent;color:var(--vscode-foreground);text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;opacity:.75}
.nav button.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);opacity:1;font-weight:600}
.main{flex:1;padding:18px 22px;min-width:0}
.card{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:14px;margin-bottom:12px;background:var(--vscode-editor-background)}
.card h3{margin:0 0 4px;font-size:13px}
.card p{margin:0 0 10px;font-size:11.5px;opacity:.7}
label{display:block;font-size:11.5px;margin:10px 0 4px;opacity:.85}
input,select{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.footer{display:flex;gap:8px;margin-top:6px}
button.primary{background:var(--dsh-accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600}
button.ghost{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px 14px;cursor:pointer}
.hint{font-size:11px;opacity:.6}
.pill{display:inline-block;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:20px;padding:2px 10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px}
.page{display:none}.page.active{display:block}
</style></head><body>
<div class="top"><div class="logo">DS</div><div><div class="title">DeepSeek Harness — Settings</div><div class="sub">Mini copy of the Harness settings page · writes to VS Code settings (<code>deepseekHarness.*</code>)</div></div><div style="margin-left:auto"><span class="pill" id="livemodel">…</span></div></div>
<div class="wrap">
<div class="nav">
<button data-page="general" class="active">General</button>
<button data-page="models">Models</button>
<button data-page="permissions">Permissions</button>
<button data-page="connection">Connection (ACP)</button>
<button data-page="opencode">opencode</button>
<button data-page="about">About</button>
</div>
<div class="main">
<div class="page active" id="page-general">
<div class="card"><h3>General</h3><p>Workspace defaults for new DSH sessions, like Harness General section.</p>
<label>Default working directory (empty = current workspace)</label><input id="defaultCwd" placeholder="C:\\work\\my-project" />
</div>
<div class="card"><h3>Agent</h3><p>Reasoning + token budget applied to new sessions (best effort over ACP).</p><div class="row2">
<div><label>Reasoning effort (optional)</label><select id="reasoningEffort"><option value="">default</option><option>low</option><option>medium</option><option>high</option></select></div>
<div><label>Max tokens (optional)</label><input id="maxTokens" placeholder="e.g. 49152" /></div>
</div></div>
</div>
<div class="page" id="page-models">
<div class="card"><h3>Models</h3><p>Mirrors Harness Models settings: provider route + model id. Same as the model pill setup.</p><div class="row2">
<div><label>Provider</label><select id="provider"><option>deepseek-official</option><option>custom</option></select></div>
<div><label>Model</label><select id="model"><option>deepseek-v4</option><option>deepseek-v4-flash</option><option>deepseek-chat</option><option>custom</option></select></div>
</div>
<label>Custom provider (if custom)</label><input id="providerCustom" placeholder="my-provider" />
<label>Custom model (if custom)</label><input id="modelCustom" placeholder="my-model-id" />
<div style="margin-top:10px"><button class="ghost" id="gomodel">Open model picker…</button></div>
</div>
</div>
<div class="page" id="page-permissions">
<div class="card"><h3>Permissions</h3><p>Same presets as the Harness: <code>workspace-write</code> (ask) vs <code>danger-full-access</code> (never ask). Display-only in this mini client; enforcement lives in DSH.</p>
<label>Permission preset</label><select id="permissionPreset"><option value="workspace-write">workspace-write (ask)</option><option value="danger-full-access">danger-full-access (never ask)</option></select>
<p class="hint">Harness mapping: workspace-write = sandbox workspace-write + approval ask; danger-full-access = sandbox danger-full-access + approval never. Use an isolated workspace with danger-full-access.</p>
</div>
</div>
<div class="page" id="page-connection">
<div class="card"><h3>Connection (ACP)</h3><p>How this mini client spawns the Harness, like the Harness runtime section.</p>
<label>DSH CLI path</label><input id="cliPath" placeholder="dsh" />
<label>Profile</label><select id="profile"><option>acp</option><option>sdk</option><option>sdk-minimal</option><option>headless</option></select>
<p class="hint">Chat uses <code>dsh --profile acp</code> stdio. <code>sdk</code> profiles are for advanced/SDK use.</p>
</div>
</div>
<div class="page" id="page-opencode">
<div class="card"><h3>opencode history</h3><p>Where the sidebar history reads from. Same XDG rules as opencode v2.</p>
<label>opencode.db override (empty = auto-detect)</label><input id="opencodeDbPath" placeholder="%USERPROFILE%\\.local\\share\\opencode\\opencode.db" />
<p class="hint">Default: <code>%USERPROFILE%\\.local\\share\\opencode\\opencode.db</code>, else <code>$XDG_DATA_HOME</code>, else <code>$OPENCODE_DB</code>.</p>
</div>
</div>
<div class="page" id="page-about">
<div class="card"><h3>About</h3><p>Mini Harness console for VS Code. Full policy, tools, and session truth stay in DSH; this tab only edits the local bridge settings.</p>
<p class="hint">Extension: deepseek-harness-vscode · ACP via <code>@agentclientprotocol/sdk</code> · opencode v2 SQLite (WAL-safe copy-on-read).</p>
</div>
</div>
<div class="footer"><button class="primary" id="save">Save settings</button><button class="ghost" id="reload">Reload values</button></div>
<div class="hint" id="status" style="margin-top:8px"></div>
</div>
</div>
<script>
const vscode = acquireVsCodeApi();
const ids = ['cliPath','profile','defaultCwd','opencodeDbPath','provider','model','permissionPreset','reasoningEffort','maxTokens'];
function val(id){ return (document.getElementById(id)?.value ?? ''); }
function setVal(id, v){ const el = document.getElementById(id); if(el) el.value = v ?? ''; }
document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));
 document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
 b.classList.add('active');
 document.getElementById('page-'+b.dataset.page)?.classList.add('active');
});
document.getElementById('save').onclick=()=>{
 let provider = val('provider'), model = val('model');
 if(provider==='custom') provider = val('providerCustom') || provider;
 if(model==='custom') model = val('modelCustom') || model;
 vscode.postMessage({type:'save', values:{cliPath:val('cliPath'),profile:val('profile'),defaultCwd:val('defaultCwd'),opencodeDbPath:val('opencodeDbPath'),provider,model,permissionPreset:val('permissionPreset'),reasoningEffort:val('reasoningEffort'),maxTokens:val('maxTokens')}});
};
document.getElementById('reload').onclick=()=>vscode.postMessage({type:'get'});
document.getElementById('gomodel').onclick=()=>vscode.postMessage({type:'setupModel'});
window.addEventListener('message', e=>{
 const m=e.data;
 if(m.type==='values'&&m.values){ for(const k of ids){ if(k in m.values) setVal(k, m.values[k]); }
  if(m.values.provider && ![...document.getElementById('provider').options].some(o=>o.value===m.values.provider)){ const o=document.createElement('option'); o.value=m.values.provider; o.textContent=m.values.provider+' (current)'; document.getElementById('provider').appendChild(o); setVal('provider', m.values.provider); }
  if(m.values.model && ![...document.getElementById('model').options].some(o=>o.value===m.values.model)){ const o=document.createElement('option'); o.value=m.values.model; o.textContent=m.values.model+' (current)'; document.getElementById('model').appendChild(o); setVal('model', m.values.model); }
 }
 if(m.type==='saved'){ document.getElementById('status').textContent='Saved ✓'; setTimeout(()=>document.getElementById('status').textContent='',2000); }
 if(m.liveModel){ document.getElementById('livemodel').textContent=(m.liveModel.provider||'')+'/'+(m.liveModel.model||''); }
 if(m.type==='values'&&m.liveModel){ document.getElementById('livemodel').textContent=(m.liveModel.provider||'')+'/'+(m.liveModel.model||''); }
});
vscode.postMessage({type:'get'});
</script></body></html>`;
}
