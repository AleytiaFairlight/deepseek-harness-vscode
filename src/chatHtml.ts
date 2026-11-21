/** Harness-faithful chat HTML — matches the real DeepSeek Harness main panel. */
export function chatHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#161616;--panel:#1e1e1e;--card:#232323;--card2:#262626;--border:#2e2e2e;--txt:#e8e8e8;--dim:#9a9a9a;--accent:#4d6bfe;--green:#3fb950;--red:#f85149;--blue:#58a6ff;color-scheme:dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);margin:0;color:var(--txt);background:var(--bg);display:flex;flex-direction:column;height:100vh;font-size:13px}
.hbar{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg)}
.sess{font-weight:700;font-size:13.5px}
.mode{font-size:12px;color:var(--dim);display:flex;gap:6px;align-items:center}
.tabs{display:flex;gap:14px;margin-left:8px}
.tab{border:0;background:transparent;color:var(--dim);font-size:12.5px;font-weight:600;padding:8px 2px;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{color:var(--txt);border-bottom-color:var(--blue)}
.hright{margin-left:auto;color:var(--dim);display:flex;gap:10px;align-items:center}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;max-width:860px;width:100%;margin:0 auto}
.utext{color:var(--txt);line-height:1.6;white-space:pre-wrap;word-break:break-word}
.utext a{color:var(--blue)}
.pillcode{background:#333;border-radius:6px;padding:1px 7px;font-size:12px}
.acard{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.acard .ahead{display:flex;gap:10px;align-items:center;padding:12px 14px}
.ficon{width:30px;height:30px;border-radius:8px;background:#2f6fed;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff;flex:none}
.ficon.file{background:#3a3a3a}
.atitle{font-weight:700;font-size:13px}
.diff{font-size:11.5px;margin-top:2px}.add{color:var(--green)}.del{color:var(--red)}
.frow{display:flex;justify-content:space-between;gap:10px;padding:9px 14px;border-top:1px solid var(--border);font-size:12.5px;color:#d5d5d5}
.frow .stats{white-space:nowrap;font-size:11.5px}
.dsub{font-size:11.5px;color:var(--dim);margin-top:2px}
.openbtn{border:1px solid var(--border);background:#2c2c2c;border-radius:8px;color:var(--txt);padding:5px 9px;cursor:pointer;display:flex;gap:4px;align-items:center}
.arow{display:flex;gap:14px;align-items:center;padding:8px 2px;color:var(--dim);font-size:11.5px}
.arow button{border:0;background:transparent;color:var(--dim);cursor:pointer;font-size:13px;padding:2px}
.arow button:hover{color:var(--txt)}
.todos{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 14px;display:flex;gap:8px;align-items:center;font-size:12.5px}
.todos b{font-weight:700}.todos .dim{color:var(--dim)}
.composer{padding:12px 16px 10px;max-width:860px;width:100%;margin:0 auto}
.box{background:var(--card2);border:1px solid var(--border);border-radius:16px;padding:12px 14px}
textarea{width:100%;border:0;background:transparent;color:var(--txt);resize:none;min-height:44px;max-height:180px;font-family:inherit;font-size:13px;outline:none}
textarea::placeholder{color:#7d7d7d}
.cbar{display:flex;gap:8px;align-items:center;margin-top:8px}
.plus{width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--txt);cursor:pointer;font-size:16px;line-height:1}
.perm{display:flex;gap:6px;align-items:center;border:0;background:transparent;color:var(--txt);font-size:12.5px;cursor:pointer}
.modelpick{margin-left:auto;color:var(--txt);font-size:12.5px;border:0;background:transparent;cursor:pointer;display:flex;gap:6px;align-items:center}
.modelpick .dim{color:var(--dim)}
.send{width:34px;height:34px;border-radius:50%;border:0;background:#3b82f6;color:#fff;font-size:17px;cursor:pointer;flex:none}
.send:disabled{opacity:.4}
.status{display:flex;gap:14px;justify-content:center;color:var(--dim);font-size:11px;padding:6px 0 10px}
code{background:#333;border-radius:6px;padding:1px 6px}
pre{background:#0f0f0f;border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto}
#ctxchip{display:none;margin:0 auto 10px;max-width:860px;width:calc(100% - 32px);font-size:11.5px;background:rgba(77,107,254,.14);border:1px solid var(--accent);border-radius:8px;padding:6px 10px}
#ctxchip.show{display:block}#ctxchip button{float:right;border:0;background:transparent;color:inherit;cursor:pointer}
.thinking{color:var(--dim);font-size:12px}
</style></head><body>
<div class="hbar"><span class="sess" id="sessname">Test</span><span class="mode">◈ <span id="presetname">Standard mode</span></span><span class="mode">⛉ <span id="subcount">0 subagents</span></span>
<div class="tabs"><button class="tab active" id="tabchat">Chat</button><button class="tab" id="tabtraj">Trajectory</button><button class="tab" id="tabmore">…</button></div>
<div class="hright"><span id="sessline" style="font-size:11px"></span><span>⋯</span><span>⧉</span></div></div>
<div id="log"><div class="utext" id="empty">This is the Harness-style chat. Click sidebar history or sessions — they load here as cards and text, just like the app.</div></div>
<div id="ctxchip"><button id="ctxx">✕</button><span id="ctxtext"></span></div>
<div class="composer"><div class="box">
<textarea id="in" placeholder="Message or run a task, / commands, @ files or sessions"></textarea>
<div class="cbar"><button class="plus" id="plus" title="Attach">+</button><button class="perm" id="permbtn" title="Open Settings → Permissions">🛡 <span id="permname">Full access</span> ▾</button>
<button class="modelpick" id="modelpill"><span id="modelname">deepseek-v4</span> <span class="dim" id="effort">Xhigh ▾</span></button>
<button class="send" id="send">↑</button></div>
</div></div>
<div class="status"><span id="turns">0 turns</span><span id="toks">0 tok</span><span>Cache hit 99%</span></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('in');
const sendBtn = document.getElementById('send');
let busy=false, turns=0;
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function md(s){
 let h = esc(s);
 h = h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
 h = h.replace(/^• (.*)$/gm,'<div>• $1</div>');
 h = h.replace(/(https?:\\/\\/[^\\s)]+)/g,'<a href="$1">$1</a>');
 h = h.replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>');
 return h.replace(/\\n/g,'<br>');
}
function userText(t){ const d=document.createElement('div'); d.className='utext'; d.innerHTML=md(t); log.appendChild(d); log.scrollTop=log.scrollHeight; }
function dshText(t, meta){ const d=document.createElement('div'); d.className='utext'; d.innerHTML=md(t); log.appendChild(d);
 if(meta){ const r=document.createElement('div'); r.className='arow'; r.innerHTML='<button title=Copy>⧉</button><button>👍</button><button>👎</button><button>⤴</button><span>Usage 5M tok</span><span>'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span>'; r.querySelector('button').onclick=()=>navigator.clipboard?.writeText(t); log.appendChild(r);} 
 log.scrollTop=log.scrollHeight; }
function fileCard(title, add, del, rows){ const c=document.createElement('div'); c.className='acard'; c.innerHTML='<div class=ahead><div class=ficon>⌁</div><div><div class=atitle>'+esc(title)+'</div><div class=diff><span class=add>'+add+'</span> <span class=del>'+del+'</span></div></div></div>'+rows.map(r=>'<div class=frow><span>'+esc(r[0])+'</span><span class=stats><span class=add>'+r[1]+'</span> <span class=del>'+r[2]+'</span></span></div>').join(''); log.appendChild(c); log.scrollTop=log.scrollHeight; }
function deliverCard(name, sub){ const c=document.createElement('div'); c.className='acard'; c.innerHTML='<div class=ahead><div class="ficon file">▢</div><div style="flex:1"><div class=atitle>'+esc(name)+'</div><div class=dsub>'+esc(sub||'')+'</div></div><button class=openbtn>⧉ ▾</button></div>'; log.appendChild(c); log.scrollTop=log.scrollHeight; }
function todosCard(done, total){ const c=document.createElement('div'); c.className='todos'; c.innerHTML='☰ <b>To-dos</b> <span class=dim>'+done+' completed</span><span style="margin-left:auto">⌃</span>'; log.appendChild(c); log.scrollTop=log.scrollHeight; }
function thinking(){ const d=document.createElement('div'); d.className='thinking'; d.id='thinking'; d.textContent='…'; log.appendChild(d); }
function rmThinking(){ document.getElementById('thinking')?.remove(); }
function setBusy(b){ busy=b; sendBtn.disabled=b; }
function send(){ const t=input.value; if(!t.trim()||busy) return; input.value=''; userText(t); thinking(); setBusy(true); turns++; document.getElementById('turns').textContent=turns+' turns'; vscode.postMessage({type:'prompt', text:t}); }
sendBtn.onclick=send;
document.getElementById('modelpill').onclick=()=>vscode.postMessage({type:'modelSetup'});
document.getElementById('permbtn').onclick=()=>vscode.postMessage({type:'openSettings'});
document.getElementById('ctxx').onclick=()=>{ document.getElementById('ctxchip').className=''; };
input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ send(); } });
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(180,input.scrollHeight)+'px'; });
function renderHistory(h){ log.innerHTML=''; (h||[]).forEach(m=>{ if(m.role==='user') userText(m.text); else dshText(m.text, true); }); if(!(h||[]).length) log.innerHTML='<div class=utext>Empty session — ask anything below.</div>'; }
window.addEventListener('message', e=>{ const m=e.data;
 if(m.type==='answer'){ rmThinking(); setBusy(false); dshText(m.text, true); if(m.sessionId) document.getElementById('sessline').textContent=m.sessionId.slice(0,14); }
 if(m.type==='stream'){ rmThinking(); dshText(m.text, false); }
 if(m.type==='prefill'){ input.value=m.text||''; document.getElementById('ctxtext').textContent=m.hint||''; document.getElementById('ctxchip').className='show'; input.focus(); }
 if(m.type==='model'){ if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; }
 if(m.type==='init'){ if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; if(m.title) document.getElementById('sessname').textContent=m.title; }
 if(m.type==='session'){ document.getElementById('sessname').textContent=m.title||('session '+(m.sessionId||'').slice(0,8)); document.getElementById('sessline').textContent=(m.sessionId||'').slice(0,14); renderHistory(m.history); if(m.model) document.getElementById('modelname').textContent=(m.model.provider||'')+' '+(m.model.model||''); if(m.permissionPreset) document.getElementById('permname').textContent = m.permissionPreset==='danger-full-access' ? 'Full access' : m.permissionPreset; }
});
</script></body></html>`;
}
