export function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clawty Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--bg-card:#1a1d27;--bg-card-hover:#1e2233;--bg-sidebar:#13151e;
  --accent:#6366f1;--accent-hover:#818cf8;--accent-dim:rgba(99,102,241,.12);
  --success:#22c55e;--warning:#f59e0b;--error:#ef4444;--info:#3b82f6;
  --text:#e2e8f0;--text-secondary:#94a3b8;--text-muted:#64748b;
  --border:#2d3348;--border-light:#374151;
  --radius:10px;--radius-sm:6px;
  --shadow:0 1px 3px rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.2);
  --shadow-lg:0 10px 24px rgba(0,0,0,.4);
  --transition:150ms ease;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --font-mono:'SF Mono','Fira Code','Cascadia Code',Consolas,monospace;
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}

.layout{display:flex;height:100vh}
.sidebar{width:220px;background:var(--bg-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-logo{padding:20px;font-size:18px;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
.sidebar-logo svg{width:28px;height:28px}
.sidebar-nav{flex:1;padding:12px 8px;display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);color:var(--text-secondary);cursor:pointer;transition:all var(--transition);font-size:13px;font-weight:500;border:none;background:none;width:100%;text-align:left}
.nav-item:hover{background:var(--accent-dim);color:var(--text)}
.nav-item.active{background:var(--accent-dim);color:var(--accent)}
.nav-item svg{width:18px;height:18px;flex-shrink:0}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-muted)}

.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{height:56px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0}
.topbar-title{font-size:15px;font-weight:600}
.topbar-status{display:flex;align-items:center;gap:16px}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.status-dot.ok{background:var(--success);box-shadow:0 0 6px var(--success)}
.status-dot.error{background:var(--error);box-shadow:0 0 6px var(--error)}
.status-badge{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary)}
.refresh-btn{background:var(--accent-dim);border:1px solid var(--border);color:var(--text-secondary);padding:6px 12px;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;font-family:var(--font);transition:all var(--transition)}
.refresh-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}

.content{flex:1;overflow-y:auto;padding:24px}
.section{display:none}
.section.active{display:block}
.section-header{font-size:20px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.section-desc{color:var(--text-secondary);font-size:13px;margin-bottom:24px}

.grid{display:grid;gap:16px}
.grid-2{grid-template-columns:repeat(2,1fr)}
.grid-3{grid-template-columns:repeat(3,1fr)}
.grid-4{grid-template-columns:repeat(4,1fr)}
@media(max-width:1200px){.grid-4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:900px){.grid-3,.grid-2{grid-template-columns:1fr}}

.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;transition:all var(--transition)}
.card:hover{border-color:var(--border-light);background:var(--bg-card-hover)}
.card-sm{padding:16px}
.card-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;letter-spacing:-.02em}
.card-sub{font-size:12px;color:var(--text-secondary);margin-top:4px}
.card-icon{width:40px;height:40px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;margin-bottom:12px}
.card-icon svg{width:20px;height:20px}
.card-icon.indigo{background:rgba(99,102,241,.15);color:var(--accent)}
.card-icon.green{background:rgba(34,197,94,.15);color:var(--success)}
.card-icon.amber{background:rgba(245,158,11,.15);color:var(--warning)}
.card-icon.blue{background:rgba(59,130,246,.15);color:var(--info)}
.card-icon.red{background:rgba(239,68,68,.15);color:var(--error)}

.stat-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.stat-row:last-child{border-bottom:none}
.stat-label{color:var(--text-secondary);font-size:13px}
.stat-value{font-weight:600;font-size:13px;font-family:var(--font-mono)}

.bar-chart{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.bar-row{display:flex;align-items:center;gap:10px}
.bar-label{width:100px;font-size:12px;color:var(--text-secondary);text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;height:22px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden;position:relative}
.bar-fill{height:100%;border-radius:4px;transition:width .4s ease;min-width:2px}
.bar-fill.indigo{background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.bar-fill.green{background:linear-gradient(90deg,#16a34a,var(--success))}
.bar-fill.amber{background:linear-gradient(90deg,#d97706,var(--warning))}
.bar-fill.blue{background:linear-gradient(90deg,#2563eb,var(--info))}
.bar-val{font-size:12px;font-family:var(--font-mono);color:var(--text-muted);width:48px;text-align:right;flex-shrink:0}

.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.pill.ok{background:rgba(34,197,94,.15);color:var(--success)}
.pill.warn{background:rgba(245,158,11,.15);color:var(--warning)}
.pill.err{background:rgba(239,68,68,.15);color:var(--error)}
.pill.info{background:rgba(99,102,241,.15);color:var(--accent)}

.tool-list{display:flex;flex-direction:column;gap:8px}
.tool-item{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px 16px;transition:all var(--transition)}
.tool-item:hover{border-color:var(--border-light)}
.tool-name{font-weight:600;font-family:var(--font-mono);font-size:13px;color:var(--accent)}
.tool-desc{font-size:12px;color:var(--text-secondary);margin-top:4px}

.config-block{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;overflow-x:auto}
.config-block pre{font-family:var(--font-mono);font-size:12px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all}

.empty-state{text-align:center;padding:48px 24px;color:var(--text-muted)}
.empty-state svg{width:48px;height:48px;margin-bottom:12px;opacity:.4}
.empty-state p{font-size:14px}

.loading{opacity:.5;pointer-events:none}
.fade-in{animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.5s ease infinite}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Clawty
    </div>
    <nav class="sidebar-nav">
      <button class="nav-item active" data-section="overview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Overview
      </button>
      <button class="nav-item" data-section="indexes">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
        Indexes
      </button>
      <button class="nav-item" data-section="memory">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        Memory
      </button>
      <button class="nav-item" data-section="metrics">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Metrics
      </button>
      <button class="nav-item" data-section="config">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        Config
      </button>
      <button class="nav-item" data-section="tools">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
        Tools
      </button>
    </nav>
    <div class="sidebar-footer">
      <div id="server-version">Clawty MCP Server</div>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div class="topbar-title" id="section-title">Overview</div>
      <div class="topbar-status">
        <span class="status-badge"><span class="status-dot ok" id="status-dot"></span><span id="status-text">Connected</span></span>
        <span class="status-badge" id="uptime-badge" style="display:none">Uptime: <span id="uptime-value">-</span></span>
        <button class="refresh-btn" id="refresh-btn" title="Refresh data">&#x21bb; Refresh</button>
      </div>
    </header>

    <div class="content">
      <!-- Overview -->
      <div class="section active" id="sec-overview">
        <div class="grid grid-4" id="overview-cards"></div>
        <div style="margin-top:20px">
          <div class="card">
            <div class="card-title">Server Information</div>
            <div id="server-info" class="stat-row-container"></div>
          </div>
        </div>
      </div>

      <!-- Indexes -->
      <div class="section" id="sec-indexes">
        <p class="section-desc">Status and statistics for all code intelligence indexes.</p>
        <div class="grid grid-2" id="index-cards"></div>
      </div>

      <!-- Memory -->
      <div class="section" id="sec-memory">
        <p class="section-desc">Long-term memory system statistics.</p>
        <div class="grid grid-3" id="memory-summary-cards"></div>
        <div style="margin-top:20px" id="memory-details"></div>
      </div>

      <!-- Metrics -->
      <div class="section" id="sec-metrics">
        <p class="section-desc">Runtime monitoring metrics and online tuner statistics.</p>
        <div id="metrics-content"></div>
      </div>

      <!-- Config -->
      <div class="section" id="sec-config">
        <p class="section-desc">Effective configuration (sensitive values are redacted).</p>
        <div class="config-block" id="config-content"><pre>Loading...</pre></div>
      </div>

      <!-- Tools -->
      <div class="section" id="sec-tools">
        <p class="section-desc">MCP tools registered on this server.</p>
        <div id="tools-content"></div>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  const $=s=>document.querySelector(s);
  const $$=s=>document.querySelectorAll(s);
  const h=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};
  let currentSection='overview';
  let refreshTimer=null;
  const startTime=Date.now();

  $$('.nav-item').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $$('.nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      $$('.section').forEach(s=>s.classList.remove('active'));
      currentSection=btn.dataset.section;
      $('#sec-'+currentSection).classList.add('active');
      $('#section-title').textContent=btn.textContent.trim();
      loadSection(currentSection);
    });
  });

  $('#refresh-btn').addEventListener('click',()=>loadSection(currentSection));

  function fmt(n){if(n==null)return'-';if(typeof n==='number'){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString()}return String(n)}
  function fmtMs(n){if(n==null)return'-';if(n>=1000)return(n/1000).toFixed(1)+'s';return Math.round(n)+'ms'}
  function fmtPct(n){if(n==null)return'-';return(n*100).toFixed(1)+'%'}
  function fmtUptime(ms){const s=Math.floor(ms/1000);const m=Math.floor(s/60);const hr=Math.floor(m/60);const d=Math.floor(hr/24);if(d>0)return d+'d '+hr%24+'h';if(hr>0)return hr+'h '+m%60+'m';if(m>0)return m+'m '+s%60+'s';return s+'s'}
  function pillHtml(ok,yesText,noText){return ok?'<span class="pill ok">'+(yesText||'OK')+'</span>':'<span class="pill err">'+(noText||'N/A')+'</span>'}
  function cardHtml(icon,color,title,value,sub){return '<div class="card card-sm fade-in"><div class="card-icon '+color+'">'+icon+'</div><div class="card-title">'+h(title)+'</div><div class="card-value">'+h(String(value))+'</div>'+(sub?'<div class="card-sub">'+sub+'</div>':'')+'</div>'}
  function statRowsHtml(rows){return rows.map(([l,v])=>'<div class="stat-row"><span class="stat-label">'+h(l)+'</span><span class="stat-value">'+v+'</span></div>').join('')}
  function barChartHtml(items,color){if(!items.length)return'<div class="empty-state"><p>No data</p></div>';const max=Math.max(...items.map(i=>i.value),1);return'<div class="bar-chart">'+items.map(i=>'<div class="bar-row"><span class="bar-label" title="'+h(i.label)+'">'+h(i.label)+'</span><span class="bar-track"><span class="bar-fill '+(color||'indigo')+'" style="width:'+Math.max(1,i.value/max*100)+'%"></span></span><span class="bar-val">'+fmt(i.value)+'</span></div>').join('')+'</div>'}

  const iconDb='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
  const iconTree='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  const iconBrain='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>';
  const iconChart='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  async function api(path){
    try{
      const r=await fetch('/api/dashboard/'+path);
      if(!r.ok)throw new Error(r.statusText);
      return await r.json();
    }catch(e){
      console.error('API error:',path,e);
      return null;
    }
  }

  async function loadOverview(){
    const data=await api('overview');
    if(!data)return;
    const ix=data.indexes||{};
    const cards=[
      cardHtml(iconDb,'indigo','Code Index',ix.code_files!=null?fmt(ix.code_files):'-','files indexed'),
      cardHtml(iconTree,'green','Syntax Index',ix.syntax_files!=null?fmt(ix.syntax_files):'-','files parsed'),
      cardHtml(iconBrain,'amber','Semantic Graph',ix.semantic_nodes!=null?fmt(ix.semantic_nodes):'-','nodes'),
      cardHtml(iconChart,'blue','Vector Index',ix.vector_chunks!=null?fmt(ix.vector_chunks):'-','embeddings'),
    ];
    $('#overview-cards').innerHTML=cards.join('');
    const info=data.server||{};
    const rows=[
      ['Transport',h(info.transport||'-')],
      ['Host',h(info.host||'-')],
      ['Port',h(String(info.port||'-'))],
      ['Workspace',h(info.workspace_root||'-')],
      ['Toolsets',(info.toolsets||[]).map(t=>'<span class="pill info">'+h(t)+'</span>').join(' ')||'-'],
      ['Low-level exposed',info.expose_low_level?'<span class="pill warn">Yes</span>':'<span class="pill ok">No</span>'],
    ];
    if(data.memory){
      rows.push(['Memory lessons',fmt(data.memory.total_lessons)]);
    }
    $('#server-info').innerHTML=statRowsHtml(rows);
    if(info.version){$('#server-version').textContent='Clawty MCP v'+info.version}
  }

  async function loadIndexes(){
    const data=await api('index-stats');
    if(!data){$('#index-cards').innerHTML='<div class="empty-state"><p>Failed to load index stats</p></div>';return}
    let html='';
    const sections=[
      {key:'code',title:'Code Index (FTS5)',color:'indigo',render:renderCodeIndex},
      {key:'syntax',title:'Syntax Index',color:'green',render:renderSyntaxIndex},
      {key:'semantic',title:'Semantic Graph',color:'amber',render:renderSemanticIndex},
      {key:'vector',title:'Vector Index',color:'blue',render:renderVectorIndex},
    ];
    for(const s of sections){
      const d=data[s.key];
      html+='<div class="card fade-in"><div class="card-title" style="display:flex;justify-content:space-between;align-items:center">'+h(s.title)+' '+pillHtml(d&&d.ok)+'</div>';
      if(d&&d.ok!==false)html+=s.render(d);
      else html+='<div class="empty-state" style="padding:24px"><p>'+(d?.error||'Not built yet')+'</p></div>';
      html+='</div>';
    }
    $('#index-cards').innerHTML=html;
  }

  function renderCodeIndex(d){
    const rows=[['Files',fmt(d.total_files)],['Chunks',fmt(d.total_chunks)],['Engine',d.engine||'-'],['Updated',d.updated_at||'-']];
    let html=statRowsHtml(rows);
    if(d.languages&&d.languages.length){
      html+='<div style="margin-top:12px"><div class="card-title">Languages</div>';
      html+=barChartHtml(d.languages.map(l=>({label:l.language,value:l.count})),'indigo');
      html+='</div>';
    }
    return html;
  }
  function renderSyntaxIndex(d){
    const rows=[['Files',fmt(d.total_files)],['Imports',fmt(d.total_imports)],['Calls',fmt(d.total_calls||0)]];
    let html=statRowsHtml(rows);
    if(d.top_callers&&d.top_callers.length){
      html+='<div style="margin-top:12px"><div class="card-title">Top Callers</div>';
      html+=barChartHtml(d.top_callers.slice(0,8).map(f=>({label:f.path,value:f.call_count})),'green');
      html+='</div>';
    }
    return html;
  }
  function renderSemanticIndex(d){
    const rows=[['Nodes',fmt(d.total_nodes||d.node_count)],['Edges',fmt(d.total_edges||d.edge_count)]];
    if(d.node_types){
      for(const[k,v]of Object.entries(d.node_types))rows.push([k,fmt(v)]);
    }
    return statRowsHtml(rows);
  }
  function renderVectorIndex(d){
    const rows=[['Total chunks',fmt(d.total_chunks||d.total)]];
    if(d.layers){
      for(const[k,v]of Object.entries(d.layers))rows.push(['Layer: '+k,fmt(v)]);
    }
    if(d.model)rows.push(['Model',d.model]);
    return statRowsHtml(rows);
  }

  async function loadMemory(){
    const data=await api('memory-stats');
    if(!data||!data.ok){
      $('#memory-summary-cards').innerHTML='';
      $('#memory-details').innerHTML='<div class="empty-state"><p>'+(data?.error||'Memory system not available')+'</p></div>';
      return;
    }
    const cards=[
      cardHtml(iconBrain,'indigo','Lessons',fmt(data.total_lessons),'total stored'),
      cardHtml(iconDb,'amber','Episodes',fmt(data.total_episodes),'recorded'),
      cardHtml(iconChart,'green','Feedback',fmt(data.total_feedback),'entries'),
    ];
    $('#memory-summary-cards').innerHTML=cards.join('');
    let detailHtml='<div class="card fade-in"><div class="card-title">Details</div>';
    const rows=[['Scope',h(data.scope||'-')],['Quarantined',fmt(data.quarantined||0)]];
    if(data.db_path)rows.push(['DB path',h(data.db_path)]);
    detailHtml+=statRowsHtml(rows);
    if(data.top_lessons&&data.top_lessons.length){
      detailHtml+='<div style="margin-top:16px"><div class="card-title">Top Lessons</div>';
      detailHtml+=data.top_lessons.map(l=>'<div class="tool-item"><div class="tool-name">'+h(l.title||l.id)+'</div><div class="tool-desc">Score: '+fmt(l.confidence||l.score)+' &middot; Updated: '+(l.updated_at||'-')+'</div></div>').join('');
      detailHtml+='</div>';
    }
    detailHtml+='</div>';
    $('#memory-details').innerHTML=detailHtml;
  }

  async function loadMetrics(){
    const data=await api('metrics');
    if(!data){$('#metrics-content').innerHTML='<div class="empty-state"><p>Failed to load metrics</p></div>';return}
    let html='';
    const m=data.metrics;
    const t=data.tuner;
    if(m){
      html+='<div class="card fade-in" style="margin-bottom:16px"><div class="card-title">Hybrid Query Metrics</div>';
      if(m.hybrid_query){
        const hq=m.hybrid_query;
        const rows=[];
        if(hq.total_queries!=null)rows.push(['Total queries',fmt(hq.total_queries)]);
        if(hq.success_rate!=null)rows.push(['Success rate',fmtPct(hq.success_rate)]);
        if(hq.avg_latency_ms!=null)rows.push(['Avg latency',fmtMs(hq.avg_latency_ms)]);
        if(hq.p95_latency_ms!=null)rows.push(['P95 latency',fmtMs(hq.p95_latency_ms)]);
        if(hq.degrade_rate!=null)rows.push(['Degrade rate',fmtPct(hq.degrade_rate)]);
        html+=statRowsHtml(rows);
      } else {
        html+='<div class="empty-state" style="padding:16px"><p>No query metrics recorded yet</p></div>';
      }
      if(m.watch_flush){
        html+='<div style="margin-top:16px"><div class="card-title">Watch Flush</div>';
        const wf=m.watch_flush;
        const rows=[];
        if(wf.total_flushes!=null)rows.push(['Total flushes',fmt(wf.total_flushes)]);
        if(wf.avg_latency_ms!=null)rows.push(['Avg latency',fmtMs(wf.avg_latency_ms)]);
        if(wf.p95_latency_ms!=null)rows.push(['P95 latency',fmtMs(wf.p95_latency_ms)]);
        html+=statRowsHtml(rows);
        html+='</div>';
      }
      if(m.memory_search){
        html+='<div style="margin-top:16px"><div class="card-title">Memory Search</div>';
        const ms=m.memory_search;
        const rows=[];
        if(ms.total_searches!=null)rows.push(['Total searches',fmt(ms.total_searches)]);
        if(ms.avg_latency_ms!=null)rows.push(['Avg latency',fmtMs(ms.avg_latency_ms)]);
        html+=statRowsHtml(rows);
        html+='</div>';
      }
      html+='</div>';
    }
    if(t){
      html+='<div class="card fade-in"><div class="card-title">Online Tuner</div>';
      if(t.arms&&t.arms.length){
        html+=barChartHtml(t.arms.map(a=>({label:a.name||a.arm,value:a.pulls||a.count})),'amber');
        html+='<div style="margin-top:12px">';
        const rows=[];
        if(t.total_pulls!=null)rows.push(['Total pulls',fmt(t.total_pulls)]);
        if(t.best_arm)rows.push(['Best arm',h(t.best_arm)]);
        html+=statRowsHtml(rows);
        html+='</div>';
      } else {
        html+='<div class="empty-state" style="padding:16px"><p>No tuner data yet</p></div>';
      }
      html+='</div>';
    }
    if(!m&&!t)html='<div class="empty-state"><p>No metrics data available</p></div>';
    $('#metrics-content').innerHTML=html;
  }

  async function loadConfig(){
    const data=await api('config');
    if(!data){$('#config-content').innerHTML='<pre>Failed to load config</pre>';return}
    $('#config-content').innerHTML='<pre>'+h(JSON.stringify(data,null,2))+'</pre>';
  }

  async function loadTools(){
    const data=await api('tools');
    if(!data||!data.tools||!data.tools.length){$('#tools-content').innerHTML='<div class="empty-state"><p>No tools registered</p></div>';return}
    const grouped={};
    for(const t of data.tools){
      const cat=t.category||'general';
      if(!grouped[cat])grouped[cat]=[];
      grouped[cat].push(t);
    }
    let html='<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">'+data.tools.length+' tools registered</div>';
    for(const[cat,tools]of Object.entries(grouped)){
      html+='<div style="margin-bottom:16px"><div class="card-title" style="margin-bottom:8px">'+h(cat.toUpperCase())+'</div><div class="tool-list">';
      for(const t of tools){
        html+='<div class="tool-item"><div class="tool-name">'+h(t.name)+'</div>';
        if(t.description)html+='<div class="tool-desc">'+h(t.description)+'</div>';
        html+='</div>';
      }
      html+='</div></div>';
    }
    $('#tools-content').innerHTML=html;
  }

  const loaders={overview:loadOverview,indexes:loadIndexes,memory:loadMemory,metrics:loadMetrics,config:loadConfig,tools:loadTools};
  function loadSection(name){
    const fn=loaders[name];
    if(fn)fn().catch(e=>console.error('Load error:',name,e));
  }

  function updateUptime(){
    const ms=Date.now()-startTime;
    $('#uptime-value').textContent=fmtUptime(ms);
    $('#uptime-badge').style.display='';
  }

  loadSection('overview');
  setInterval(updateUptime,1000);
  setInterval(()=>loadSection(currentSection),15000);
})();
</script>
</body>
</html>`;
}
