import * as vscode from 'vscode';
import { DshAcp, PROVIDER_ENV } from './dshAcp';

/** DSH-style Settings tab: mirrors Harness Settings → Models (DeepSeek key, third-party provider, custom API). */

export const PROVIDER_CATALOG = [
  { id: 'deepseek-official', label: 'DeepSeek (official)', env: 'DEEPSEEK_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'moonshotai', label: 'Moonshot AI (Kimi)', env: 'MOONSHOT_API_KEY' },
  { id: 'zai', label: 'Zhipu GLM (ZAI)', env: 'ZAI_API_KEY' },
  { id: 'gemini', label: 'Google Gemini', env: 'GEMINI_API_KEY' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter (OpenAI-compatible)', env: 'OPENROUTER_API_KEY' },
  { id: 'opencode-gateway', label: 'opencode gateway (OpenAI-compatible)', env: 'OPENCODE_API_KEY' },
  { id: 'custom', label: 'Custom model API…', env: '' },
];

export async function refreshDshEnv(context: vscode.ExtensionContext, dsh: DshAcp): Promise<void> {
  const extra: Record<string, string> = {};
  for (const p of PROVIDER_CATALOG) {
    if (!p.id || p.id === 'custom') continue;
    try {
      const key = await context.secrets.get(`dsh.apikey.${p.id}`);
      const envName = PROVIDER_ENV[p.id] ?? p.env;
      if (key && envName) extra[envName] = key;
    } catch { /* ignore */ }
  }
  try {
    const custom = context.globalState.get<Record<string, string>>('dsh.customProvider', {});
    if (custom.apiKey && custom.providerId) {
      const envName = PROVIDER_ENV[custom.providerId] ?? `${custom.providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
      extra[envName] = custom.apiKey;
      if (custom.baseURL) extra[`${custom.providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`] = custom.baseURL;
    }
  } catch { /* ignore */ }
  dsh.setExtraEnv(extra);
}

export class SettingsManager {
  private panel?: vscode.WebviewPanel;

  constructor(private context: vscode.ExtensionContext, private dsh: DshAcp, private onChanged: () => void) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.pushValues();
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
        await this.pushValues();
      }
      if (msg?.type === 'save') {
        const values = msg.values as Record<string, string> | undefined;
        if (!values) return;
        const cfg = vscode.workspace.getConfiguration('deepseekHarness');
        // Model/effort go through verified setters (write + verify + live-push with surfaced errors).
        const cur = this.dsh.getModel();
        const wantProvider = values.provider || cur.provider;
        const wantModel = values.model || cur.model;
        if (values.provider !== undefined || values.model !== undefined) {
          await this.dsh.setModel(wantProvider, wantModel);
        }
        if (values.reasoningEffort !== undefined) {
          await this.dsh.setEffort(values.reasoningEffort);
        }
        for (const [key, val] of Object.entries(values)) {
          if (key === 'deepseekKey' || key === 'providerKey' || key === 'customKey') continue;
          if (key === 'provider' || key === 'model' || key === 'reasoningEffort') continue; // handled above
          await cfg.update(key, val || undefined, vscode.ConfigurationTarget.Global);
        }
        // Read back to prove the save landed, then report exact values.
        const after = vscode.workspace.getConfiguration('deepseekHarness');
        const got = `provider=${after.get('provider')} model=${after.get('model')} effort=${after.get('reasoningEffort') || '(default)'} perm=${after.get('permissionPreset')}`;
        this.onChanged();
        void panel.webview.postMessage({ type: 'saved' });
        await this.pushValues();
        void vscode.window.showInformationMessage(`DSH Settings saved + verified: ${got}. No command panel needed — new prompts/sessions use these.`);
      }
      if (msg?.type === 'saveKeys') {
        const { deepseekKey, provider, providerKey, providerBaseUrl, custom } = msg as {
          deepseekKey?: string; provider?: string; providerKey?: string; providerBaseUrl?: string;
          custom?: { providerId?: string; displayName?: string; baseURL?: string; api?: string; apiKey?: string; models?: string };
        };
        // DeepSeek official key (write-only, like Harness: stored in SecretStorage, never echoed).
        if (deepseekKey !== undefined) {
          if (deepseekKey.trim()) await this.context.secrets.store('dsh.apikey.deepseek-official', deepseekKey.trim());
          else await this.context.secrets.delete('dsh.apikey.deepseek-official');
        }
        if (provider && provider !== 'custom' && providerKey !== undefined) {
          if (providerKey.trim()) await this.context.secrets.store(`dsh.apikey.${provider}`, providerKey.trim());
          else await this.context.secrets.delete(`dsh.apikey.${provider}`);
          if (providerBaseUrl !== undefined) {
            const urls = this.context.globalState.get<Record<string, string>>('dsh.providerBaseUrls', {});
            const next = { ...urls };
            if (providerBaseUrl.trim()) next[provider] = providerBaseUrl.trim();
            else delete next[provider];
            await this.context.globalState.update('dsh.providerBaseUrls', next);
          }
        }
        if (custom) {
          const prev = this.context.globalState.get<Record<string, string>>('dsh.customProvider', {});
          const next: Record<string, string> = { ...prev };
          for (const [k, v] of Object.entries(custom)) {
            if (typeof v === 'string' && v.trim()) next[k] = v.trim();
            else delete next[k];
          }
          await this.context.globalState.update('dsh.customProvider', next);
        }
        await refreshDshEnv(this.context, this.dsh);
        this.onChanged();
        void panel.webview.postMessage({ type: 'saved' });
        await this.pushValues();
        void vscode.window.showInformationMessage('Provider keys saved securely (SecretStorage) + injected into DSH env.');
      }
      if (msg?.type === 'setupModel') {
        void vscode.commands.executeCommand('deepseekHarness.setupModel');
      }
    });
    this.panel = panel;
    void this.pushValues();
  }

  private async pushValues(): Promise<void> {
    if (!this.panel) return;
    const c = vscode.workspace.getConfiguration('deepseekHarness');
    const get = (k: string, d = '') => c.get<string>(k, d);
    const hasDeepseekKey = !!(await this.context.secrets.get('dsh.apikey.deepseek-official'));
    const provider = get('provider', 'deepseek-official');
    const hasProviderKey = provider && provider !== 'custom' ? !!(await this.context.secrets.get(`dsh.apikey.${provider}`)) : false;
    const urls = this.context.globalState.get<Record<string, string>>('dsh.providerBaseUrls', {});
    const custom = this.context.globalState.get<Record<string, string>>('dsh.customProvider', {});
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
        providerBaseUrl: urls[provider] ?? '',
        customProviderId: custom.providerId ?? '',
        customDisplayName: custom.displayName ?? '',
        customBaseURL: custom.baseURL ?? '',
        customApi: custom.api ?? 'openai-completions',
        customModels: custom.models ?? '',
      },
      keyStatus: { hasDeepseekKey, hasProviderKey, provider },
      liveModel: this.dsh.getModel(),
    });
  }
}

function settingsHtml(): string {
  const providerOptions = PROVIDER_CATALOG.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
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
input,select,textarea{width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit}
textarea{min-height:56px;resize:vertical}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.footer{display:flex;gap:8px;margin-top:6px}
button.primary{background:var(--dsh-accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600}
button.ghost{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px 14px;cursor:pointer}
.hint{font-size:11px;opacity:.6}
.pill{display:inline-block;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:20px;padding:2px 10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.keyrow{display:flex;gap:6px}.keyrow input{flex:1}
.page{display:none}.page.active{display:block}
.eye{flex:none}
</style></head><body>
<div class="top"><div class="logo">DS</div><div><div class="title">DeepSeek Harness — Settings</div><div class="sub">Mini copy of Harness Settings → Models · keys stay in VS Code SecretStorage + DSH env</div></div><div style="margin-left:auto"><span class="pill" id="livemodel">…</span></div></div>
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
<div class="card"><h3>General</h3><p>Workspace defaults for new DSH sessions.</p>
<label>Default working directory (empty = current workspace)</label><input id="defaultCwd" placeholder="C:\\work\\my-project" />
</div>
<div class="card"><h3>Agent</h3><p>Reasoning + token budget applied to new sessions (best effort over ACP).</p><div class="row2">
<div><label>Reasoning effort (optional)</label><select id="reasoningEffort"><option value="">default</option><option>low</option><option>medium</option><option>high</option></select></div>
<div><label>Max tokens (optional)</label><input id="maxTokens" placeholder="e.g. 49152" /></div>
</div></div>
</div>
<div class="page" id="page-models">
<div class="card"><h3>DeepSeek (official)</h3><p>Same as Harness Models card: one API-key field, write-only. Saved key shows as <code>saved ••••</code>, never the literal secret.</p>
<label>DeepSeek API key <span class="pill" id="deepseekState">…</span></label><div class="keyrow"><input id="deepseekKey" type="password" placeholder="sk-… (blank = keep saved / use env DEEPSEEK_API_KEY)" /><button class="ghost eye" id="eyeDeepseek">Show</button></div>
<p class="hint">Leave blank to keep the saved key or fall back to <code>DEEPSEEK_API_KEY</code>. Typing replaces the whole key. Save with empty field keeps existing.</p>
</div>
<div class="card"><h3>Third-party provider</h3><p>Pick a shipped provider (like Harness “Add model provider”), paste its key. Yellow hint = no key/env detected.</p>
<label>Provider</label><select id="provider">${providerOptions}</select>
<label>API key <span class="pill" id="providerState">…</span></label><div class="keyrow"><input id="providerKey" type="password" placeholder="paste key · blank = keep saved / use env" /><button class="ghost eye" id="eyeProvider">Show</button></div>
<label>Base URL override (optional)</label><input id="providerBaseUrl" placeholder="https://gateway.example/v1" />
<p class="hint" id="envHint"></p>
</div>
<div class="card"><h3>Custom model API</h3><p>Relay / gateway / self-hosted / opencode gateway — same fields as Harness custom form.</p>
<div class="row2"><div><label>Provider ID (permanent, lowercase)</label><input id="customProviderId" placeholder="my-gateway" /></div>
<div><label>Display name</label><input id="customDisplayName" placeholder="My Gateway" /></div></div>
<label>Base URL</label><input id="customBaseURL" placeholder="https://gateway.example/v1 (Gemini: …/v1beta)" />
<label>API protocol</label><select id="customApi"><option value="openai-completions">OpenAI Chat Completions (openai-completions)</option><option value="openai-responses">OpenAI Responses (openai-responses)</option><option value="anthropic-messages">Anthropic Messages (anthropic-messages)</option><option value="google-generative-ai">Gemini API (google-generative-ai)</option></select>
<label>API key</label><div class="keyrow"><input id="customKey" type="password" placeholder="key for this gateway" /><button class="ghost eye" id="eyeCustom">Show</button></div>
<label>Models (one id per line)</label><textarea id="customModels" placeholder="my-model-1&#10;my-model-2"></textarea>
</div>
<div class="card"><h3>Active model</h3><p>Configured providers appear in the picker. Selecting also becomes the default for new sessions (current sessions keep their recorded model).</p>
<div class="row2"><div><label>Provider</label><input id="activeProvider" placeholder="deepseek-official" /></div>
<div><label>Model</label><input id="activeModel" placeholder="deepseek-v4" /></div></div>
<div style="margin-top:10px"><button class="ghost" id="gomodel">Open model picker…</button></div>
</div>
</div>
<div class="page" id="page-permissions">
<div class="card"><h3>Permissions</h3><p>Same presets as the Harness: <code>workspace-write</code> (ask) vs <code>danger-full-access</code> (never ask).</p>
<label>Permission preset</label><select id="permissionPreset"><option value="workspace-write">workspace-write (ask)</option><option value="danger-full-access">danger-full-access (never ask)</option></select>
<p class="hint">Use an isolated workspace with danger-full-access.</p>
</div>
</div>
<div class="page" id="page-connection">
<div class="card"><h3>Connection (ACP)</h3><p>How this mini client spawns the Harness.</p>
<label>DSH CLI path</label><input id="cliPath" placeholder="dsh" />
<label>Profile</label><select id="profile"><option>acp</option><option>sdk</option><option>sdk-minimal</option><option>headless</option></select>
</div>
</div>
<div class="page" id="page-opencode">
<div class="card"><h3>opencode history</h3><p>Same XDG rules as opencode v2.</p>
<label>opencode.db override (empty = auto-detect)</label><input id="opencodeDbPath" placeholder="%USERPROFILE%\\.local\\share\\opencode\\opencode.db" />
</div>
</div>
<div class="page" id="page-about">
<div class="card"><h3>About</h3><p>Mini Harness console for VS Code (Harness 0.2.2-rc.5 is latest on npm — you are not on an older Harness).</p>
<p class="hint">Keys: SecretStorage (write-only) + process env for spawned <code>dsh</code>. Non-secret fields: VS Code settings <code>deepseekHarness.*</code>.</p>
</div>
</div>
<div class="footer"><button class="primary" id="save">Save settings</button><button class="ghost" id="reload">Reload values</button></div>
<div class="hint" id="status" style="margin-top:8px"></div>
</div>
</div>
<script>
const vscode = acquireVsCodeApi();
const ids = ['cliPath','profile','defaultCwd','opencodeDbPath','activeProvider','activeModel','permissionPreset','reasoningEffort','maxTokens','provider','providerBaseUrl','customProviderId','customDisplayName','customBaseURL','customApi','customModels'];
function val(id){ return (document.getElementById(id)?.value ?? ''); }
function setVal(id, v){ const el = document.getElementById(id); if(el) el.value = v ?? ''; }
function bindEye(btn, input){ document.getElementById(btn).onclick=()=>{ const el=document.getElementById(input); el.type = el.type==='password'?'text':'password'; document.getElementById(btn).textContent = el.type==='password'?'Show':'Hide'; }; }
bindEye('eyeDeepseek','deepseekKey'); bindEye('eyeProvider','providerKey'); bindEye('eyeCustom','customKey');
document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));
 document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
 b.classList.add('active');
 document.getElementById('page-'+b.dataset.page)?.classList.add('active');
});
const ENVHINT = {'deepseek-official':'DEEPSEEK_API_KEY','anthropic':'ANTHROPIC_API_KEY','openai':'OPENAI_API_KEY','moonshotai':'MOONSHOT_API_KEY','zai':'ZAI_API_KEY','gemini':'GEMINI_API_KEY','groq':'GROQ_API_KEY','openrouter':'OPENROUTER_API_KEY','opencode-gateway':'OPENCODE_API_KEY (or gateway env)'};
document.getElementById('provider').onchange=()=>{ const p=val('provider'); document.getElementById('envHint').textContent = p==='custom' ? 'Custom uses the form below.' : ('Env fallback: '+(ENVHINT[p]||'(provider env)')+'. Yellow = no key/env detected — paste a key.'); vscode.postMessage({type:'get'}); };
document.getElementById('save').onclick=()=>{
 vscode.postMessage({type:'save', values:{cliPath:val('cliPath'),profile:val('profile'),defaultCwd:val('defaultCwd'),opencodeDbPath:val('opencodeDbPath'),provider:val('activeProvider'),model:val('activeModel'),permissionPreset:val('permissionPreset'),reasoningEffort:val('reasoningEffort'),maxTokens:val('maxTokens')}});
 vscode.postMessage({type:'saveKeys', deepseekKey:val('deepseekKey'), provider:val('provider'), providerKey:val('providerKey'), providerBaseUrl:val('providerBaseUrl'), custom:{providerId:val('customProviderId'),displayName:val('customDisplayName'),baseURL:val('customBaseURL'),api:val('customApi'),apiKey:val('customKey'),models:val('customModels')}});
 setTimeout(()=>{ document.getElementById('deepseekKey').value=''; document.getElementById('providerKey').value=''; document.getElementById('customKey').value=''; }, 500);
};
document.getElementById('reload').onclick=()=>vscode.postMessage({type:'get'});
document.getElementById('gomodel').onclick=()=>vscode.postMessage({type:'setupModel'});
window.addEventListener('message', e=>{
 const m=e.data;
 if(m.type==='values'&&m.values){
  setVal('cliPath',m.values.cliPath); setVal('profile',m.values.profile); setVal('defaultCwd',m.values.defaultCwd); setVal('opencodeDbPath',m.values.opencodeDbPath);
  setVal('activeProvider',m.values.provider); setVal('activeModel',m.values.model);
  setVal('permissionPreset',m.values.permissionPreset); setVal('reasoningEffort',m.values.reasoningEffort); setVal('maxTokens',m.values.maxTokens);
  setVal('provider',m.values.provider); setVal('providerBaseUrl',m.values.providerBaseUrl||'');
  setVal('customProviderId',m.values.customProviderId); setVal('customDisplayName',m.values.customDisplayName); setVal('customBaseURL',m.values.customBaseURL); setVal('customApi',m.values.customApi||'openai-completions'); setVal('customModels',m.values.customModels);
  const p=val('provider'); document.getElementById('envHint').textContent = p==='custom' ? 'Custom uses the form below.' : ('Env fallback: '+(ENVHINT[p]||'(provider env)'));
 }
 if(m.type==='values'&&m.keyStatus){ document.getElementById('deepseekState').textContent = m.keyStatus.hasDeepseekKey ? 'saved ••••' : 'no key'; document.getElementById('providerState').textContent = m.keyStatus.hasProviderKey ? 'saved ••••' : 'no key (yellow: enter key or set env)'; }
 if(m.type==='saved'){ document.getElementById('status').textContent='Saved ✓ keys are write-only'; setTimeout(()=>document.getElementById('status').textContent='',2000); }
 if(m.liveModel){ document.getElementById('livemodel').textContent=(m.liveModel.provider||'')+'/'+(m.liveModel.model||''); }
 if(m.type==='values'&&m.liveModel){ document.getElementById('livemodel').textContent=(m.liveModel.provider||'')+'/'+(m.liveModel.model||''); }
});
vscode.postMessage({type:'get'});
</script></body></html>`;
}
