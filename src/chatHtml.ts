/** Upstream-faithful chat: ChatFlow + InputBar structure from deepseek-harness repo. */
export function chatHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:dark;--chatw:clamp(680px,64%,880px)}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;font-size:14px;line-height:24px}
.hbar{display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--vscode-panel-border)}
.sess{font-weight:700;font-size:13.5px}.mode{font-size:12px;opacity:.65}.tabs{display:flex;gap:14px;margin-left:8px}
.tab{border:0;background:transparent;color:var(--vscode-foreground);opacity:.6;font-size:12.5px;font-weight:600;padding:8px 2px;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{opacity:1;border-bottom-color:var(--vscode-textLink-foreground)}
.hright{margin-left:auto;opacity:.6;font-size:12px;display:flex;gap:10px}
#log{flex:1;overflow-y:auto;padding:16px}
.col{max-width:var(--chatw);margin:0 auto;display:flex;flex-direction:column;gap:4px}
.userRow{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin:4px 0 12px}
.userStack{max-width:min(70.2%,82%)}
.ububble{background:var(--vscode-button-secondaryBackground,#2b2b2b);border-radius:20px;padding:10px 16px;font-size:14px;line-height:22px;white-space:pre-wrap;word-break:break-word}
.aroot{font-size:14px;line-height:24px;color:var(--vscode-foreground)}
.aroot .abody{display:flex;flex-direction:column;gap:16px}
.group{border:0;margin:4px 0}.group>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;color:var(--vscode-descriptionForeground);font-size:14px;line-height:24px;padding:2px 0}
.group>summary::-webkit-details-marker{display:none}.group .gbody{max-height:min(400px,50vh);overflow:auto;border-left:2px solid var(--vscode-panel-border);padding-left:12px;margin:4px 0 12px;display:flex;flex-direction:column;gap:8px}
.toolcard{background:var(--vscode-editor-inactiveSelectionBackground);border:1px solid var(--vscode-panel-border);border-radius:12px;padding:8px 10px;font-size:12.5px}
.arow{display:flex;gap:12px;align-items:center;padding:6px 2px;color:var(--vscode-descriptionForeground);font-size:11.5px}
.arow button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;padding:2px}.arow button:hover{color:var(--vscode-foreground)}
.todos{background:var(--vscode-editor-inactiveSelectionBackground);border:1px solid var(--vscode-panel-border);border-radius:10px;padding:9px 14px;display:flex;gap:8px;align-items:center;font-size:12.5px;margin:8px 0}
code{background:var(--vscode-textCodeBlock-background);padding:1px 6px;border-radius:6px;font-size:12.5px}
pre{background:#0f0f0f;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px;overflow:auto;font-size:12.5px}
a{color:var(--vscode-textLink-foreground)}
#ctxchip{display:none;margin:0 auto 10px;max-width:var(--chatw);width:calc(100% - 32px);font-size:11.5px;background:rgba(77,107,254,.14);border:1px solid #4d6bfe;border-radius:8px;padding:6px 10px}
#ctxchip.show{display:block}#ctxchip button{float:right;border:0;background:transparent;color:inherit;cursor:pointer}
.composer{padding:10px 16px 12px}.cwrap{max-width:calc(var(--chatw) + 32px);margin:0 auto}
.card{background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);border-radius:28px;padding-top:8px;display:flex;flex-direction:column;gap:12px}
textarea{width:100%;border:0;background:transparent;color:var(--vscode-input-foreground);resize:none;min-height:36px;max-height:336px;font-family:inherit;font-size:13.5px;outline:none;padding:4px 8px 0 14px;caret-color:var(--vscode-focusBorder)}
textarea::placeholder{color:var(--vscode-input-placeholderForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row{display:flex;align-items:center;justify-content:space-between;padding:4px 8px 8px;gap:12px}
.tools{display:flex;gap:6px;align-items:center}.trailing{display:flex;gap:6px;align-items:center}
.add{width:32px;height:32px;border-radius:50%;border:0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-foreground);cursor:pointer;font-size:16px}
.chip{border:0;background:transparent;color:var(--vscode-foreground);font-size:13px;font-weight:500;cursor:pointer;display:flex;gap:4px;align-items:center;opacity:.85}
.chip:hover{opacity:1}
.modelpick{font-size:12.5px}
.send{width:32px;height:32px;border-radius:50%;border:0;background:#3b82f6;color:#fff;font-size:16px;cursor:pointer;flex:none}
.send.stop{background:var(--vscode-button-secondaryBackground);color:var(--vscode-foreground)}
.send:disabled{opacity:.4}
.sugrow{display:flex;gap:8px;justify-content:center;margin:8px 0}.sugrow button{border:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);border-radius:16px;padding:4px 12px;cursor:pointer;font-size:12px}
.status{display:flex;gap:14px;justify-content:center;color:var(--vscode-descriptionForeground);font-size:11px;padding:6px 0 10px}
#log[data-mode="traj"] .userRow{display:none}
.thinking{color:var(--vscode-descriptionForeground);font-size:12px}
</style></head><body>
<div class="hbar"><span class="sess" id="sessname">Test</span><span class="mode">◈ Standard mode</span><span class="mode">⛉ <span id="subcount">0 subagents</span></span>
<div class="tabs"><button class="tab active" id="tabchat">Chat</button><button class="tab" id="tabtraj">Trajectory</button><button class="tab">…</button></div>
<div class="hright"><span id="sessline"></span></div></div>
<div id="log"><div class="col" id="col"><div style="opacity:.55;font-size:12px;text-align:center">Upstream-faithful chat v0.0.15 (ChatFlow + InputBar). History and sessions load here.</div><div class="sugrow"><button class="sug">Explain this repo</button><button class="sug">Fix failing tests</button><button class="sug">Review my diff</button></div></div></div>
<div id="ctxchip"><button id="ctxx">✕</button><span id="ctxtext"></span></div>
<div class="composer"><div class="cwrap"><div class="card">
<textarea id="in" placeholder="Message or run a task, / commands, @ files or sessions"></textarea>
<div class="row"><div class="tools"><button class="add" id="plus" title="Slash commands">+</button><button class="chip" id="permbtn">🛡 <span id="permname">Full access</span> ▾</button><button class="chip" id="cwdbtn">📁 <span id="cwdname">workspace</span> ▾</button></div>
<div class="trailing"><button class="chip modelpick" id="modelpill"><span id="modelname">model</span> <span id="effort">▾</span></button><button class="send" id="send" title="Send (Ctrl+Enter)">↑</button></div></div>
</div></div></div>
<div class="status"><span id="turns">0 turns</span><span id="toks">0 tok</span><span>ACP stdio</span><span id="ver">ext …</span></div>
<script>
const vscode = acquireVsCodeApi();
const col = document.getElementById('col');
const input = document.getElementById('in');
const sendBtn = document.getElementById('send');
let busy=false, turns=0;
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function md(s){ let h = esc(s); h = h.replace(/\`([^\`]+)\`/g,'<code>$1</code>'); h = h.replace(/^• (.*)$/gm,'<div>• $1</div>'); h = h.replace(/(https?:\\/\\/[^\\s)]+)/g,'<a href="$1">$1</a>'); h = h.replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>'); return h.replace(/\\n/g,'<br>'); }
function isToolLike(t){ return /tool[_ -]?call|tool result|called |\\b(bash|edit|read|write|grep|glob)\\b.{0,40}(started|completed|failed)|^\\$ /.test(t); }
function userRow(t){ const r=document.createElement('div'); r.className='userRow'; const s=document.createElement('div'); s.className='userStack'; const b=document.createElement('div'); b.className='ububble'; b.innerHTML=md(t); s.appendChild(b); r.appendChild(s); col.appendChild(r); }
function asst(t, meta){ if(isToolLike(t)){ const d=document.createElement('details'); d.className='group'; d.open=false; const s=document.createElement('summary'); s.textContent='⚙ '+t.split('\\n')[0].slice(0,90); const b=document.createElement('div'); b.className='gbody'; const c=document.createElement('div'); c.className='toolcard'; c.innerHTML=md(t); b.appendChild(c); d.appendChild(s); d.appendChild(b); col.appendChild(d); }
 else { const d=document.createElement('div'); d.className='aroot'; d.innerHTML='<div class=abody>'+md(t)+'</div>'; col.appendChild(d); }
 if(meta){ const r=document.createElement('div'); r.className='arow'; r.innerHTML='<button title=Copy>⧉</button><button>👍</button><button>👎</button><button>⤴</button><span>Usage</span><span>'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span>'; r.querySelector('button').onclick=()=>navigator.clipboard?.writeText(t); col.appendChild(r); } }
function thinking(){ const d=document.createElement('div'); d.className='thinking'; d.id='thinking'; d.textContent='…'; col.appendChild(d); }
function rmThinking(){ document.getElementById('thinking')?.remove(); }
function setBusy(b){ busy=b; sendBtn.textContent = b ? '■' : '↑'; sendBtn.classList.toggle('stop', b); if(b) sendBtn.title='Stop (session/cancel)'; else sendBtn.title='Send (Ctrl+Enter)'; }
function send(){ if(busy){ vscode.postMessage({type:'cancel'}); return; } const t=input.value; if(!t.trim()) return; input.value=''; userRow(t); thinking(); setBusy(true); turns++; document.getElementById('turns').textContent=turns+' turns'; vscode.postMessage({type:'prompt', text:t}); }
sendBtn.onclick=send;
document.getElementById('modelpill').onclick=()=>vscode.postMessage({type:'modelSetup'});
document.getElementById('effort').onclick=(e)=>{ e.stopPropagation(); vscode.postMessage({type:'effortSetup'}); };
document.getElementById('permbtn').onclick=()=>vscode.postMessage({type:'openSettings'});
document.getElementById('cwdbtn').onclick=()=>vscode.postMessage({type:'selectWorkspace'});
document.getElementById('tabchat').onclick=()=>setTab('chat');
document.getElementById('tabtraj').onclick=()=>setTab('traj');
function setTab(m){ document.getElementById('tabchat').className='tab'+(m==='chat'?' active':''); document.getElementById('tabtraj').className='tab'+(m==='traj'?' active':''); document.getElementById('log').dataset.mode=m; }
document.getElementById('plus').onclick=()=>{ input.value='/'; input.focus(); };
document.getElementById('ctxx').onclick=()=>{ document.getElementById('ctxchip').className=''; };
document.querySelectorAll('.sug').forEach(b=>b.onclick=()=>{ input.value=b.textContent||''; input.focus(); });
input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ send(); } });
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(336,input.scrollHeight)+'px'; });
function renderHistory(h){ col.innerHTML=''; (h||[]).forEach(m=>{ if(m.role==='user') userRow(m.text); else asst(m.text, true); }); if(!(h||[]).length) col.innerHTML='<div style="opacity:.55;font-size:12px;text-align:center">Empty session — ask anything below.</div>'; }
window.addEventListener('message', e=>{ const m=e.data;
 if(m.type==='answer'){ rmThinking(); setBusy(false); asst(m.text, true); if(m.sessionId) document.getElementById('sessline').textContent=m.sessionId.slice(0,14); }
 if(m.type==='stream'){ rmThinking(); asst(m.text, false); }
 if(m.type==='prefill'){ input.value=m.text||''; document.getElementById('ctxtext').textContent=m.hint||''; document.getElementById('ctxchip').className='show'; input.focus(); }
 if(m.type==='model'){ if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); const eff=document.getElementById('effort'); if(eff&&m.effort!==undefined) eff.textContent=(m.effort||'default')+' ▾'; if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; if(m.cwd) document.getElementById('cwdname').textContent=String(m.cwd).split(/[\\\\/]/).pop()||m.cwd; }
 if(m.type==='init'){ if(m.version) document.getElementById('ver').textContent='ext v'+m.version; if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; if(m.effort!==undefined) document.getElementById('effort').textContent=(m.effort||'default')+' ▾'; if(m.cwd) document.getElementById('cwdname').textContent=String(m.cwd).split(/[\\/]/).pop()||m.cwd; if(m.title) document.getElementById('sessname').textContent=m.title; }
 if(m.type==='session'){ document.getElementById('sessname').textContent=m.title||('session '+(m.sessionId||'').slice(0,8)); document.getElementById('sessline').textContent=(m.sessionId||'').slice(0,14); renderHistory(m.history); if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; }
});
</script></body></html>`;
}
