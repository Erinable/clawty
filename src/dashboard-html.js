export function dashboardPayloadHasError(payload) {
  return Boolean(payload) && typeof payload === "object" && payload.ok === false;
}

export function shouldRenderMetricsEmptyState(timeline, sampleSizes) {
  const hybrid = Array.isArray(timeline?.hybrid) ? timeline.hybrid : [];
  const watchFlush = Array.isArray(timeline?.watch_flush) ? timeline.watch_flush : [];
  const memory = Array.isArray(timeline?.memory) ? timeline.memory : [];

  if (hybrid.length > 0 || watchFlush.length > 0 || memory.length > 0) {
    return false;
  }
  if (!sampleSizes || typeof sampleSizes !== "object") {
    return false;
  }

  return (sampleSizes.hybrid_events || 0) === 0 &&
    (sampleSizes.watch_flush_events || 0) === 0 &&
    (sampleSizes.memory_events || 0) === 0;
}

export function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clawty Dashboard</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2300c8ff' stroke-width='2'%3E%3Cpath d='M12 2L2 7l10 5 10-5-10-5z'/%3E%3Cpath d='M2 17l10 5 10-5'/%3E%3Cpath d='M2 12l10 5 10-5'/%3E%3C/svg%3E">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070b10;--bg-card:#0f171f;--bg-card-hover:#14202a;--bg-sidebar:#091219;
  --accent:#00c8ff;--accent-hover:#67e6ff;--accent-dim:rgba(0,200,255,.12);
  --success:#22e18a;--warning:#ffc14d;--error:#ff657d;--info:#79b8ff;
  --text:#d8edf6;--text-secondary:#9eb3bd;--text-muted:#68808d;
  --border:#213542;--border-light:#2a4656;
  --radius:8px;--radius-sm:5px;
  --transition:150ms ease;
  --font:'IBM Plex Sans','Segoe UI','Helvetica Neue',Arial,sans-serif;
  --font-mono:'JetBrains Mono','SF Mono','Fira Code',Consolas,monospace;
}
html,body{height:100%;font-family:var(--font);background:
  radial-gradient(circle at 25% -10%, rgba(0,200,255,.16), transparent 50%),
  radial-gradient(circle at 120% 120%, rgba(34,225,138,.09), transparent 45%),
  var(--bg);
  color:var(--text);font-size:14px;line-height:1.5}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}

.layout{display:flex;height:100vh;position:relative;overflow:hidden}
.sidebar{width:220px;background:var(--bg-sidebar);border-right:1px solid var(--border);box-shadow:inset -1px 0 0 rgba(103,230,255,.08);display:flex;flex-direction:column;flex-shrink:0;z-index:20;transition:transform var(--transition)}
.sidebar-logo{padding:20px;font-size:16px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);color:var(--accent)}
.sidebar-logo svg{width:28px;height:28px}
.sidebar-nav{flex:1;padding:12px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);color:var(--text-secondary);cursor:pointer;transition:all var(--transition);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;border:1px solid transparent;background:none;width:100%;text-align:left}
.nav-item:hover{background:var(--accent-dim);border-color:rgba(0,200,255,.25);color:var(--text)}
.nav-item.active{background:linear-gradient(90deg, rgba(0,200,255,.16), rgba(0,200,255,.02));color:var(--accent);border-color:rgba(0,200,255,.42)}
.nav-item svg{width:18px;height:18px;flex-shrink:0}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-muted)}
.sidebar-backdrop{display:none}

.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.topbar{height:56px;border-bottom:1px solid var(--border);background:linear-gradient(180deg, rgba(0,200,255,.08), rgba(0,200,255,.02));display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0;gap:12px}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.topbar-title{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-status{display:flex;align-items:center;gap:16px;flex-wrap:wrap;justify-content:flex-end}
.menu-btn{display:none;background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer;line-height:1;transition:all var(--transition)}
.menu-btn:hover{background:var(--accent-dim);color:var(--text)}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.status-dot.ok{background:var(--success);box-shadow:0 0 6px var(--success)}
.status-dot.error{background:var(--error);box-shadow:0 0 6px var(--error)}
.status-badge{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);font-family:var(--font-mono);letter-spacing:.05em;text-transform:uppercase}
.refresh-btn{background:rgba(0,200,255,.08);border:1px solid var(--border);color:var(--accent-hover);padding:6px 12px;border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-family:var(--font-mono);letter-spacing:.06em;text-transform:uppercase;transition:all var(--transition)}
.refresh-btn:hover{background:rgba(0,200,255,.22);color:#fff;border-color:rgba(0,200,255,.6)}
.refresh-btn[disabled]{opacity:.45;cursor:not-allowed}

.content{flex:1;overflow-y:auto;padding:24px;background-image:linear-gradient(rgba(103,230,255,.035) 1px, transparent 1px),linear-gradient(90deg, rgba(103,230,255,.03) 1px, transparent 1px);background-size:22px 22px}
.section{display:none}
.section.active{display:block}
.section-desc{color:var(--text-secondary);font-size:13px;margin-bottom:24px}

.grid{display:grid;gap:16px}
.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}
@media(max-width:1200px){.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){.grid-3,.grid-2{grid-template-columns:minmax(0,1fr)}}

.card{background:linear-gradient(180deg, rgba(0,200,255,.05), rgba(0,0,0,0)) , var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;box-shadow:inset 0 1px 0 rgba(121,184,255,.08);transition:all var(--transition)}
.card:hover{border-color:var(--border-light);background:linear-gradient(180deg, rgba(0,200,255,.08), rgba(0,0,0,0)) , var(--bg-card-hover)}
.card-sm{padding:16px}
.card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;letter-spacing:-.02em}
.card-sub{font-size:12px;color:var(--text-secondary);margin-top:4px}
.card-icon{width:40px;height:40px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;margin-bottom:12px}
.card-icon svg{width:20px;height:20px}
.card-icon.indigo{background:rgba(0,200,255,.18);color:var(--accent)}
.card-icon.green{background:rgba(34,197,94,.15);color:var(--success)}
.card-icon.amber{background:rgba(245,158,11,.15);color:var(--warning)}
.card-icon.blue{background:rgba(59,130,246,.15);color:var(--info)}
.card-icon.red{background:rgba(239,68,68,.15);color:var(--error)}

.stat-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:12px}
.stat-row:last-child{border-bottom:none}
.stat-label{color:var(--text-secondary);font-size:13px;min-width:0}
.stat-value{font-weight:600;font-size:13px;font-family:var(--font-mono);text-align:right;min-width:0;word-break:break-word}

.bar-chart{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.bar-row{display:flex;align-items:center;gap:10px}
.bar-label{width:120px;font-size:12px;color:var(--text-secondary);text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;height:22px;background:rgba(0,0,0,.28);border:1px solid rgba(121,184,255,.18);border-radius:4px;overflow:hidden;position:relative}
.bar-fill{height:100%;border-radius:4px;transition:width .4s ease;min-width:2px}
.bar-fill.indigo{background:linear-gradient(90deg,var(--accent),var(--accent-hover))}
.bar-fill.green{background:linear-gradient(90deg,#16a34a,var(--success))}
.bar-fill.amber{background:linear-gradient(90deg,#d97706,var(--warning))}
.bar-fill.blue{background:linear-gradient(90deg,#2563eb,var(--info))}
.bar-val{font-size:12px;font-family:var(--font-mono);color:var(--text-muted);width:56px;text-align:right;flex-shrink:0}

.index-kpi-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
.index-kpi{background:rgba(6,12,17,.58);border:1px solid rgba(121,184,255,.14);border-radius:var(--radius-sm);padding:12px}
.index-kpi-label{font-size:10px;color:var(--text-muted);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.index-kpi-value{font-size:21px;font-weight:700;color:var(--text);font-family:var(--font-mono);line-height:1.15;margin-top:6px}
.index-kpi-sub{font-size:11px;color:var(--text-secondary);margin-top:4px}
.index-section{margin-top:14px;padding-top:14px;border-top:1px solid rgba(121,184,255,.12)}
.index-section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin-bottom:10px}
.index-list{display:flex;flex-direction:column;gap:8px}
.index-item{background:rgba(6,12,17,.58);border:1px solid rgba(121,184,255,.14);border-radius:var(--radius-sm);padding:10px 12px}
.index-item-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.index-item-title-wrap{min-width:0;flex:1}
.index-item-title{font-size:12px;font-weight:600;color:var(--text);word-break:break-word}
.index-item-path{font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:4px;word-break:break-word}
.index-item-meta{font-size:11px;color:var(--text-secondary);font-family:var(--font-mono);text-align:right;flex-shrink:0;white-space:nowrap}

.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:11px;font-size:10px;font-weight:700;font-family:var(--font-mono);letter-spacing:.04em}
.pill.ok{background:rgba(34,225,138,.15);border:1px solid rgba(34,225,138,.35);color:var(--success)}
.pill.warn{background:rgba(255,193,77,.14);border:1px solid rgba(255,193,77,.36);color:var(--warning)}
.pill.err{background:rgba(255,101,125,.14);border:1px solid rgba(255,101,125,.35);color:var(--error)}
.pill.info{background:rgba(0,200,255,.14);border:1px solid rgba(0,200,255,.35);color:var(--accent)}

.tool-list{display:flex;flex-direction:column;gap:8px}
.tool-item{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px 16px;transition:all var(--transition)}
.tool-item:hover{border-color:var(--border-light)}
.tool-name{font-weight:600;font-family:var(--font-mono);font-size:13px;color:var(--accent)}
.tool-desc{font-size:12px;color:var(--text-secondary);margin-top:4px}

.config-block{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;overflow-x:auto}
.config-block pre{font-family:var(--font-mono);font-size:12px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all}
.cfg-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.cfg-status{font-size:12px;color:var(--text-muted);margin-left:6px}
.cfg-section{background:linear-gradient(180deg, rgba(0,200,255,.05), rgba(0,0,0,0)) , #0e161f;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-bottom:12px}
.cfg-title{font-size:11px;color:var(--accent);font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:10px}
.cfg-row{display:grid;grid-template-columns:240px minmax(0,1fr);gap:10px;border-top:1px dashed rgba(100,116,139,.25);padding-top:10px;margin-top:10px}
.cfg-row:first-of-type{border-top:none;padding-top:0;margin-top:0}
.cfg-label{font-size:12px;color:var(--text);font-weight:600}
.cfg-path{font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:2px}
.cfg-input-wrap{display:flex;flex-direction:column;gap:6px}
.cfg-input-wrap input,.cfg-input-wrap select{width:100%;padding:7px 10px;background:#0a1118;border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:12px;font-family:var(--font-mono)}
.cfg-input-wrap input:focus,.cfg-input-wrap select:focus{outline:none;border-color:rgba(0,200,255,.55);box-shadow:0 0 0 1px rgba(0,200,255,.3)}
.cfg-note{font-size:11px;color:var(--text-muted)}
.cfg-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-family:var(--font-mono);padding:2px 6px;border-radius:10px;border:1px solid rgba(121,184,255,.3);color:var(--info);background:rgba(121,184,255,.08);margin-left:6px}

.empty-state{text-align:center;padding:48px 24px;color:var(--text-muted)}
.empty-state p{font-size:14px}

.fade-in{animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}

.skeleton{position:relative;overflow:hidden;background:rgba(255,255,255,.05);border-radius:6px}
.skeleton::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent);animation:shimmer 1.2s infinite}
.skeleton-line{height:12px;margin-bottom:10px}
.skeleton-line:last-child{margin-bottom:0}
.skeleton-card{height:140px;border-radius:10px}

.logs-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.logs-toolbar input,.logs-toolbar select{background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:var(--radius-sm);font-size:12px;font-family:var(--font);outline:none}
.logs-toolbar input{min-width:160px;flex:1}
.logs-toolbar select{min-width:110px}
.logs-meta{font-size:12px;color:var(--text-muted);margin-bottom:10px}
.logs-note{font-size:12px;color:var(--text-secondary);margin-bottom:12px}
.metrics-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.metrics-toolbar-label{font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.metrics-window-group{display:inline-flex;gap:8px;flex-wrap:wrap}
.metrics-window-btn{background:rgba(0,200,255,.08);border:1px solid var(--border);color:var(--text-secondary);padding:6px 12px;border-radius:999px;cursor:pointer;font-size:11px;font-family:var(--font-mono);letter-spacing:.06em;text-transform:uppercase;transition:all var(--transition)}
.metrics-window-btn:hover{background:rgba(0,200,255,.18);color:var(--text)}
.metrics-window-btn.active{background:rgba(0,200,255,.24);color:#fff;border-color:rgba(0,200,255,.55)}
.metrics-window-note{font-size:12px;color:var(--text-muted)}
.logs-view{background:
  linear-gradient(180deg, rgba(103,230,255,.05), rgba(103,230,255,.015)),
  repeating-linear-gradient(0deg, rgba(255,255,255,.02) 0, rgba(255,255,255,.02) 1px, transparent 1px, transparent 3px),
  #060c11;
  border:1px solid var(--border);border-radius:var(--radius);padding:12px;min-height:360px;max-height:62vh;overflow:auto;font-family:var(--font-mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.log-line{display:block;padding:1px 0}
.log-line.level-error{color:#fca5a5}
.log-line.level-warn{color:#fcd34d}
.log-line.level-info{color:#cbd5e1}
.log-line.level-debug{color:#93c5fd}
.log-line.level-unknown{color:#9ca3af}

.ops-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.ops-card-title{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;color:var(--accent)}
.ops-card-desc{font-size:12px;color:var(--text-secondary);margin-bottom:12px;min-height:32px}
.ops-result{margin-top:12px;max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;background:linear-gradient(180deg, rgba(0,200,255,.06), rgba(0,0,0,0)), #09121a;font-size:12px;box-shadow:inset 0 0 0 1px rgba(121,184,255,.05)}
.ops-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ops-inline input,.ops-inline select{flex:1;min-width:90px;background:#0a1118;border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:var(--radius-sm);font-size:12px;font-family:var(--font-mono)}
.ops-inline input:focus,.ops-inline select:focus{outline:none;border-color:rgba(0,200,255,.55);box-shadow:0 0 0 1px rgba(0,200,255,.3)}

.data-empty{color:var(--text-muted);font-size:12px}
.config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.config-card{background:linear-gradient(180deg, rgba(0,200,255,.05), rgba(0,0,0,0)) , #0e161f;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px}
.config-title{font-size:11px;color:var(--accent);font-weight:700;margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase}
.config-rows{display:flex;flex-direction:column;gap:6px}
.config-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;font-size:12px;border-bottom:1px dashed rgba(100,116,139,.25);padding-bottom:6px}
.config-row:last-child{border-bottom:none;padding-bottom:0}
.config-key{color:var(--text-secondary);font-family:var(--font-mono);min-width:0;word-break:break-word}
.config-value{color:var(--text);font-family:var(--font-mono);text-align:right;min-width:0;word-break:break-word}

.log-entry{border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:8px;background:linear-gradient(90deg, rgba(0,200,255,.04), rgba(0,0,0,0));box-shadow:inset 0 0 0 1px rgba(121,184,255,.04)}
.log-entry:last-child{margin-bottom:0}
.log-entry-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}
.log-entry-msg{font-size:12px;color:var(--text);word-break:break-word}
.log-entry-meta{font-size:11px;color:var(--text-muted);font-family:var(--font-mono)}
.log-entry.level-error{border-color:rgba(255,101,125,.45);background:linear-gradient(90deg, rgba(255,101,125,.09), rgba(0,0,0,0))}
.log-entry.level-warn{border-color:rgba(255,193,77,.45);background:linear-gradient(90deg, rgba(255,193,77,.09), rgba(0,0,0,0))}
.log-entry.level-info{border-color:rgba(121,184,255,.45)}
.log-entry.level-debug{border-color:rgba(158,179,189,.4)}

.ops-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
.ops-summary-card{background:linear-gradient(180deg, rgba(0,200,255,.08), rgba(0,0,0,0));border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px}
.ops-summary-k{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.07em;font-family:var(--font-mono)}
.ops-summary-v{font-size:16px;font-weight:700;color:var(--accent-hover);font-family:var(--font-mono)}
.ops-list{display:flex;flex-direction:column;gap:8px}
.ops-item{background:#0c151d;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px}
.ops-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ops-item-title{font-size:12px;font-weight:700;color:var(--text)}
.ops-item-sub{font-size:11px;color:var(--text-muted);margin-top:4px;word-break:break-word}
.ops-memory-list{display:flex;flex-direction:column;gap:8px}
.ops-memory-item{background:#0c151d;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px}
.ops-memory-title{font-size:12px;font-weight:700;color:var(--accent-hover)}
.ops-memory-meta{font-size:11px;color:var(--text-muted);margin-top:4px}

.chart-wrap{margin-top:14px}
.chart-title{font-size:12px;color:var(--text-secondary);margin-bottom:8px}
.chart-box{border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;background:linear-gradient(180deg, rgba(0,200,255,.06), rgba(0,0,0,0)), #0b1219}
.chart-svg{width:100%;height:110px;display:block}
.sparkline{width:100%;height:36px;display:block;margin-top:8px}

.kbd-help{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:40;padding:16px}
.kbd-help.open{display:flex}
.kbd-panel{width:min(420px,100%);background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.kbd-title{font-size:14px;font-weight:700;margin-bottom:10px}
.kbd-row{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding:8px 0;font-size:12px;color:var(--text-secondary)}
.kbd-row:last-child{border-bottom:none}
.kbd-key{font-family:var(--font-mono);padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.05);color:var(--text)}

@media(max-width:980px){.ops-grid{grid-template-columns:1fr}}
@media(max-width:768px){
  .menu-btn{display:inline-flex;align-items:center;justify-content:center}
  .topbar{padding:0 12px}
  .topbar-status{gap:10px}
  .content{padding:14px}
  .sidebar{position:fixed;left:0;top:0;bottom:0;transform:translateX(-100%);width:240px;box-shadow:0 10px 24px rgba(0,0,0,.5)}
  .layout.sidebar-open .sidebar{transform:translateX(0)}
  .sidebar-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity var(--transition);z-index:15;display:block}
  .layout.sidebar-open .sidebar-backdrop{opacity:1;pointer-events:auto}
  .grid-4,.grid-3,.grid-2{grid-template-columns:1fr}
  .config-grid{grid-template-columns:1fr}
  .ops-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
  .status-badge#uptime-badge{display:none!important}
  .stat-row{align-items:flex-start;flex-direction:column}
  .stat-value{text-align:left}
  .bar-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
  .bar-label{width:auto;text-align:left;grid-column:1 / -1}
  .index-kpi-grid{grid-template-columns:1fr}
  .index-item-head{flex-direction:column}
  .index-item-meta{text-align:left;white-space:normal}
}
</style>
</head>
<body>
<div class="layout" id="layout-root">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Clawty
    </div>
    <nav class="sidebar-nav">
      <button class="nav-item" data-section="overview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Overview</button>
      <button class="nav-item" data-section="indexes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>Indexes</button>
      <button class="nav-item" data-section="memory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>Memory</button>
      <button class="nav-item" data-section="metrics"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Metrics</button>
      <button class="nav-item" data-section="logs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M3 12h18M3 19h12"/></svg>Logs</button>
      <button class="nav-item" data-section="operations"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>Operations</button>
      <button class="nav-item" data-section="config"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>Config</button>
      <button class="nav-item" data-section="tools"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>Tools</button>
    </nav>
    <div class="sidebar-footer"><div id="server-version">Clawty MCP Server</div></div>
  </aside>
  <div class="sidebar-backdrop" id="sidebar-backdrop"></div>

  <div class="main">
    <header class="topbar">
      <div class="topbar-left">
        <button class="menu-btn" id="menu-btn" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
        <div class="topbar-title" id="section-title">Overview</div>
      </div>
      <div class="topbar-status">
        <span class="status-badge"><span class="status-dot ok" id="status-dot"></span><span id="status-text">Connected</span></span>
        <span class="status-badge" id="uptime-badge" style="display:none">Uptime: <span id="uptime-value">-</span></span>
        <button class="refresh-btn" id="refresh-btn" title="Refresh data">&#x21bb; Refresh</button>
      </div>
    </header>

    <div class="content">
      <div class="section" id="sec-overview">
        <div class="grid grid-4" id="overview-cards"></div>
        <div style="margin-top:20px">
          <div class="card">
            <div class="card-title">Server Information</div>
            <div id="server-info"></div>
          </div>
        </div>
      </div>

      <div class="section" id="sec-indexes">
        <p class="section-desc">Status and statistics for all code intelligence indexes.</p>
        <div class="grid grid-2" id="index-cards"></div>
      </div>

      <div class="section" id="sec-memory">
        <p class="section-desc">Long-term memory system statistics.</p>
        <div class="grid grid-3" id="memory-summary-cards"></div>
        <div style="margin-top:20px" id="memory-details"></div>
      </div>

      <div class="section" id="sec-metrics">
        <p class="section-desc">Runtime monitoring metrics and timeline trends.</p>
        <div class="metrics-toolbar">
          <span class="metrics-toolbar-label">Window</span>
          <div class="metrics-window-group" id="metrics-window-group">
            <button type="button" class="metrics-window-btn" data-hours="1">1h</button>
            <button type="button" class="metrics-window-btn active" data-hours="24">24h</button>
            <button type="button" class="metrics-window-btn" data-hours="168">7d</button>
          </div>
          <span class="metrics-window-note" id="metrics-window-note">Last 24 hours</span>
        </div>
        <div id="metrics-content"></div>
      </div>

      <div class="section" id="sec-logs">
        <p class="section-desc">Live logs with source switching, current-session filtering and error triage.</p>
        <div class="logs-toolbar">
          <select id="logs-source">
            <option value="mcp" selected>MCP server log</option>
            <option value="runtime">Runtime log</option>
          </select>
          <select id="logs-scope">
            <option value="current" selected>Current session</option>
            <option value="all">All history</option>
          </select>
          <select id="logs-level">
            <option value="">All levels</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>
          <select id="logs-lines">
            <option value="100">100 lines</option>
            <option value="200" selected>200 lines</option>
            <option value="500">500 lines</option>
            <option value="1000">1000 lines</option>
          </select>
          <input id="logs-query" type="text" placeholder="keyword filter">
          <button class="refresh-btn" id="logs-refresh">Refresh</button>
          <button class="refresh-btn" id="logs-clear">Clear</button>
          <button class="refresh-btn" id="logs-bottom">Bottom</button>
        </div>
        <div class="logs-note" id="logs-note">Defaulting to current MCP session to reduce historical noise.</div>
        <div class="logs-meta" id="logs-meta">No log data yet</div>
        <div class="ops-summary" id="logs-summary"></div>
        <div class="logs-view" id="logs-view"></div>
      </div>

      <div class="section" id="sec-operations">
        <p class="section-desc">Run maintenance actions and inspect operational output.</p>
        <div class="ops-grid">
          <div class="card">
            <div class="ops-card-title">Doctor</div>
            <div class="ops-card-desc">Run health checks and inspect failures.</div>
            <button class="refresh-btn" id="ops-doctor-btn">Run Doctor</button>
            <div class="ops-result" id="ops-doctor-result">No report yet</div>
          </div>
          <div class="card">
            <div class="ops-card-title">Reindex</div>
            <div class="ops-card-desc">Rebuild code, syntax and semantic indexes.</div>
            <button class="refresh-btn" id="ops-reindex-btn">Rebuild Indexes</button>
            <div class="ops-result" id="ops-reindex-result">No run yet</div>
          </div>
          <div class="card">
            <div class="ops-card-title">Memory Search</div>
            <div class="ops-card-desc">Query project+global memory entries.</div>
            <div class="ops-inline">
              <input id="ops-memory-query" type="text" placeholder="search terms">
              <select id="ops-memory-topk">
                <option value="3">Top 3</option>
                <option value="5" selected>Top 5</option>
                <option value="8">Top 8</option>
                <option value="10">Top 10</option>
              </select>
              <button class="refresh-btn" id="ops-memory-btn">Search</button>
            </div>
            <div class="ops-result" id="ops-memory-result">No search yet</div>
          </div>
        </div>
      </div>

      <div class="section" id="sec-config">
        <p class="section-desc">Project config editor for the active workspace. Only high-impact and currently relevant fields are shown by default.</p>
        <div class="cfg-toolbar">
          <button class="refresh-btn" id="config-save-btn">Save</button>
          <button class="refresh-btn" id="config-reset-btn">Reset</button>
          <button class="refresh-btn" id="config-reload-btn">Reload</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary)"><input type="checkbox" id="config-advanced-toggle"> Show advanced</label>
          <span class="cfg-status" id="config-status"></span>
        </div>
        <div id="config-content" class="config-block"><div class="data-empty">Loading config...</div></div>
      </div>

      <div class="section" id="sec-tools">
        <p class="section-desc">MCP tools registered on this server.</p>
        <div id="tools-content"></div>
      </div>
    </div>
  </div>
</div>

<div class="kbd-help" id="kbd-help">
  <div class="kbd-panel">
    <div class="kbd-title">Keyboard Shortcuts</div>
    <div class="kbd-row"><span>Switch section</span><span class="kbd-key">1-8</span></div>
    <div class="kbd-row"><span>Refresh current section</span><span class="kbd-key">R</span></div>
    <div class="kbd-row"><span>Toggle shortcut help</span><span class="kbd-key">?</span></div>
    <div class="kbd-row"><span>Close dialogs</span><span class="kbd-key">Esc</span></div>
  </div>
</div>

<script>
(function(){
  ${dashboardPayloadHasError.toString()}
  ${shouldRenderMetricsEmptyState.toString()}

  var $ = function(selector){ return document.querySelector(selector); };
  var $$ = function(selector){ return document.querySelectorAll(selector); };
  var h = function(input){ var div = document.createElement('div'); div.textContent = input == null ? '' : String(input); return div.innerHTML; };

  var SECTIONS = ['overview','indexes','memory','metrics','logs','operations','config','tools'];
  var SECTION_TITLES = {
    overview: 'Overview',
    indexes: 'Indexes',
    memory: 'Memory',
    metrics: 'Metrics',
    logs: 'Logs',
    operations: 'Operations',
    config: 'Config',
    tools: 'Tools'
  };
  var REFRESHABLE_SECTIONS = new Set(['overview','indexes','memory','metrics','logs','tools']);

  var currentSection = 'overview';
  var currentOverview = null;
  var lastTimeline = null;
  var refreshTicker = null;
  var logsTicker = null;
  var uptimeBaseMs = null;
  var connectFailureCount = 0;
  var loadingSection = {};

  var logsState = {
    source: 'mcp',
    scope: 'current',
    level: '',
    query: '',
    lines: 200
  };
  var metricsState = {
    windowHours: 24
  };
  var opsState = {
    doctorBusy: false,
    reindexBusy: false,
    memoryBusy: false,
    doctorResult: null,
    reindexResult: null,
    memoryResult: null
  };
  var configState = {
    fileData: {},
    effectiveData: {},
    showAdvanced: false,
    path: null,
    isLegacyPath: false
  };
  var CONFIG_SCHEMA = [
    {
      id: 'general',
      title: 'General',
      fields: [
        { path: 'model', type: 'text', always: true },
        { path: 'workspaceRoot', type: 'text', always: true }
      ]
    },
    {
      id: 'openai',
      title: 'OpenAI',
      fields: [
        { path: 'openai.baseUrl', effectivePath: 'baseUrl', type: 'text', always: true },
        { path: 'openai.apiKey', effectivePath: 'apiKey', type: 'password', always: true, placeholder: 'Leave blank to keep existing' }
      ]
    },
    {
      id: 'tools',
      title: 'Tools',
      fields: [
        { path: 'tools.timeoutMs', effectivePath: 'toolTimeoutMs', type: 'number', min: 1000, max: 300000, always: true },
        { path: 'tools.maxIterations', effectivePath: 'maxToolIterations', type: 'number', min: 1, max: 100, always: true }
      ]
    },
    {
      id: 'lsp',
      title: 'LSP',
      fields: [
        { path: 'lsp.enabled', type: 'bool', always: true },
        { path: 'lsp.timeoutMs', type: 'number', min: 1000, max: 60000, always: true },
        { path: 'lsp.maxResults', type: 'number', min: 1, max: 1000, always: true },
        { path: 'lsp.tsCommand', type: 'text', always: true }
      ]
    },
    {
      id: 'index',
      title: 'Index',
      fields: [
        { path: 'index.maxFiles', type: 'number', min: 1, max: 20000, always: true },
        { path: 'index.maxFileSizeKb', type: 'number', min: 1, max: 8192, always: true },
        { path: 'index.freshnessEnabled', type: 'bool', always: true },
        { path: 'index.freshnessStaleAfterMs', type: 'number', min: 1000, max: 86400000, advanced: true },
        { path: 'index.freshnessWeight', type: 'float', min: 0, max: 1, step: 0.01, advanced: true },
        { path: 'index.freshnessVectorStalePenalty', type: 'float', min: 0, max: 1, step: 0.01, advanced: true },
        { path: 'index.freshnessMaxPaths', type: 'number', min: 1, max: 1000, advanced: true }
      ]
    },
    {
      id: 'embedding',
      title: 'Embedding',
      fields: [
        { path: 'embedding.enabled', type: 'bool', always: true },
        { path: 'embedding.model', type: 'text', always: true },
        { path: 'embedding.topK', type: 'number', min: 1, max: 200, always: true },
        { path: 'embedding.weight', type: 'float', min: 0, max: 1, step: 0.01, always: true },
        { path: 'embedding.timeoutMs', type: 'number', min: 1000, max: 120000, advanced: true },
        { path: 'embedding.baseUrl', type: 'text', advanced: true },
        { path: 'embedding.apiKey', type: 'password', advanced: true, placeholder: 'Leave blank to keep existing' }
      ]
    },
    {
      id: 'metrics',
      title: 'Metrics',
      fields: [
        { path: 'metrics.enabled', type: 'bool', always: true },
        { path: 'metrics.persistHybrid', type: 'bool', always: true },
        { path: 'metrics.persistWatch', type: 'bool', always: true },
        { path: 'metrics.persistMemory', type: 'bool', always: true },
        { path: 'metrics.queryPreviewChars', type: 'number', min: 32, max: 1000, advanced: true }
      ]
    },
    {
      id: 'logging',
      title: 'Logging',
      fields: [
        { path: 'logging.enabled', type: 'bool', always: true },
        { path: 'logging.level', type: 'select', options: ['debug', 'info', 'warn', 'error', 'off'], always: true },
        { path: 'logging.console', type: 'bool', always: true },
        { path: 'logging.file', type: 'bool', always: true },
        { path: 'logging.path', type: 'text', always: true }
      ]
    },
    {
      id: 'mcpServer',
      title: 'MCP Server',
      fields: [
        { path: 'mcpServer.transport', type: 'select', options: ['stdio', 'http'], always: true },
        { path: 'mcpServer.host', type: 'text', always: true },
        { path: 'mcpServer.port', type: 'number', min: 1, max: 65535, always: true },
        { path: 'mcpServer.logPath', type: 'text', always: true }
      ]
    },
    {
      id: 'memory',
      title: 'Memory',
      fields: [
        { path: 'memory.enabled', type: 'bool', always: true },
        { path: 'memory.scope', type: 'select', options: ['project', 'global', 'project+global'], always: true },
        { path: 'memory.maxInjectedItems', type: 'number', min: 1, max: 20, always: true },
        { path: 'memory.maxInjectedChars', type: 'number', min: 200, max: 50000, always: true },
        { path: 'memory.autoWrite', type: 'bool', always: true },
        { path: 'memory.writeGateEnabled', type: 'bool', always: true },
        { path: 'memory.quarantineThreshold', type: 'number', min: 1, max: 20, always: true },
        { path: 'memory.minLessonChars', type: 'number', min: 40, max: 4000, advanced: true },
        { path: 'memory.dedupeEnabled', type: 'bool', advanced: true }
      ]
    },
    {
      id: 'onlineTuner',
      title: 'Online Tuner',
      fields: [
        { path: 'onlineTuner.enabled', type: 'bool', advanced: true },
        { path: 'onlineTuner.mode', type: 'select', options: ['off', 'shadow', 'active'], advanced: true },
        { path: 'onlineTuner.epsilon', type: 'float', min: 0, max: 1, step: 0.01, advanced: true },
        { path: 'onlineTuner.globalPriorWeight', type: 'float', min: 0, max: 3, step: 0.01, advanced: true },
        { path: 'onlineTuner.maxDegradeRate', type: 'float', min: 0, max: 1, step: 0.01, advanced: true },
        { path: 'onlineTuner.maxTimeoutRate', type: 'float', min: 0, max: 1, step: 0.01, advanced: true },
        { path: 'onlineTuner.dbPath', type: 'text', advanced: true }
      ]
    }
  ];

  function fmt(n){
    if(n == null) return '-';
    if(typeof n === 'number'){
      if(n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if(n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return n.toLocaleString();
    }
    return String(n);
  }

  function fmtMs(n){
    if(n == null) return '-';
    if(n >= 1000) return (n / 1000).toFixed(1) + 's';
    return Math.round(n) + 'ms';
  }

  function fmtPct(n){
    if(n == null) return '-';
    return (Number(n) * 100).toFixed(1) + '%';
  }

  function fmtUptime(ms){
    var sec = Math.max(0, Math.floor(ms / 1000));
    var min = Math.floor(sec / 60);
    var hour = Math.floor(min / 60);
    var day = Math.floor(hour / 24);
    if(day > 0) return day + 'd ' + (hour % 24) + 'h';
    if(hour > 0) return hour + 'h ' + (min % 60) + 'm';
    if(min > 0) return min + 'm ' + (sec % 60) + 's';
    return sec + 's';
  }

  function pillHtml(ok, yesText, noText){
    return ok ? '<span class="pill ok">' + (yesText || 'OK') + '</span>' : '<span class="pill err">' + (noText || 'N/A') + '</span>';
  }

  function cardHtml(icon, color, title, value, sub, chart){
    return '<div class="card card-sm fade-in"><div class="card-icon ' + color + '">' + icon + '</div><div class="card-title">' + h(title) + '</div><div class="card-value">' + h(String(value)) + '</div>' +
      (sub ? '<div class="card-sub">' + sub + '</div>' : '') + (chart ? chart : '') + '</div>';
  }

  function statRowsHtml(rows){
    return rows.map(function(pair){
      return '<div class="stat-row"><span class="stat-label">' + h(pair[0]) + '</span><span class="stat-value">' + pair[1] + '</span></div>';
    }).join('');
  }

  function barChartHtml(items, color){
    if(!items.length) return '<div class="empty-state"><p>No data</p></div>';
    var max = Math.max.apply(null, items.map(function(item){ return item.value; }).concat([1]));
    return '<div class="bar-chart">' + items.map(function(item){
      var width = Math.max(1, item.value / max * 100);
      return '<div class="bar-row"><span class="bar-label" title="' + h(item.label) + '">' + h(item.label) + '</span><span class="bar-track"><span class="bar-fill ' + (color || 'indigo') + '" style="width:' + width + '%"></span></span><span class="bar-val">' + fmt(item.value) + '</span></div>';
    }).join('') + '</div>';
  }

  function formatTimestampShort(value){
    var parsed = Date.parse(value);
    if(!Number.isFinite(parsed)) return value || '-';
    return new Date(parsed).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
  }

  function formatBytes(value){
    var bytes = Number(value);
    if(!Number.isFinite(bytes) || bytes < 0) return '-';
    if(bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if(bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes) + ' B';
  }

  function formatKilobytes(value){
    var kb = Number(value);
    if(!Number.isFinite(kb) || kb < 0) return '-';
    return formatBytes(kb * 1024);
  }

  function compactPath(pathText, keepSegments){
    var text = String(pathText || '');
    if(!text) return '-';
    var parts = text.split('/').filter(Boolean);
    var keep = Math.max(2, Number(keepSegments) || 3);
    if(parts.length <= keep) return text;
    return parts[0] + '/…/' + parts.slice(-(keep - 1)).join('/');
  }

  function tailPath(pathText, keepSegments){
    var text = String(pathText || '');
    if(!text) return '-';
    var parts = text.split('/').filter(Boolean);
    var keep = Math.max(1, Number(keepSegments) || 1);
    return parts.length <= keep ? text : parts.slice(-keep).join('/');
  }

  function summaryGridHtml(items){
    var filtered = (items || []).filter(function(item){ return item && item.label; });
    if(filtered.length === 0) return '<div class="data-empty">No summary available.</div>';
    return '<div class="index-kpi-grid">' + filtered.map(function(item){
      return '<div class="index-kpi"><div class="index-kpi-label">' + h(item.label) + '</div><div class="index-kpi-value">' + h(String(item.value == null ? '-' : item.value)) + '</div>' +
        (item.sub ? '<div class="index-kpi-sub">' + h(String(item.sub)) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  function indexSectionHtml(title, body){
    return '<div class="index-section"><div class="index-section-title">' + h(title) + '</div>' + body + '</div>';
  }

  function indexListHtml(items){
    if(!items || !items.length) return '<div class="data-empty">No data.</div>';
    return '<div class="index-list">' + items.map(function(item){
      return '<div class="index-item"><div class="index-item-head"><div class="index-item-title-wrap"><div class="index-item-title" title="' + h(item.titleTooltip || item.title || '') + '">' + h(item.title || '-') + '</div>' +
        (item.path ? '<div class="index-item-path" title="' + h(item.pathTooltip || item.path || '') + '">' + h(item.path) + '</div>' : '') + '</div>' +
        (item.meta ? '<div class="index-item-meta">' + h(item.meta) + '</div>' : '') + '</div></div>';
    }).join('') + '</div>';
  }

  function formatDurationBetween(startedAt, completedAt){
    var start = Date.parse(startedAt);
    var end = Date.parse(completedAt);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '-';
    return fmtMs(end - start);
  }

  function skeletonCards(count){
    var html = '';
    for(var i = 0; i < count; i += 1){
      html += '<div class="skeleton skeleton-card"></div>';
    }
    return html;
  }

  function skeletonStats(rows){
    var html = '<div class="card">';
    for(var i = 0; i < rows; i += 1){
      html += '<div class="skeleton skeleton-line"></div>';
    }
    html += '</div>';
    return html;
  }

  function setConnectionConnected(){
    connectFailureCount = 0;
    var dot = $('#status-dot');
    dot.classList.remove('error');
    dot.classList.add('ok');
    $('#status-text').textContent = 'Connected';
  }

  function markRequestFailure(){
    connectFailureCount += 1;
    if(connectFailureCount >= 2){
      var dot = $('#status-dot');
      dot.classList.remove('ok');
      dot.classList.add('error');
      $('#status-text').textContent = 'Disconnected';
    }
  }

  async function api(path, options){
    try {
      var response = await fetch('/api/dashboard/' + path, options);
      if(!response.ok) throw new Error(response.statusText || 'Request failed');
      var payload = await response.json();
      setConnectionConnected();
      return payload;
    } catch (error) {
      markRequestFailure();
      console.error('API error:', path, error);
      return null;
    }
  }

  function parseSectionHash(rawHash){
    var normalized = String(rawHash || '').replace(/^#/, '').trim().toLowerCase();
    if(!normalized) return 'overview';
    return SECTIONS.includes(normalized) ? normalized : 'overview';
  }

  function closeSidebar(){
    $('#layout-root').classList.remove('sidebar-open');
  }

  function openSidebar(){
    $('#layout-root').classList.add('sidebar-open');
  }

  function shouldCloseSidebarOnNavigate(){
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }

  function setNavActive(section){
    $$('.nav-item').forEach(function(btn){
      btn.classList.toggle('active', btn.dataset.section === section);
    });
  }

  function setSectionActive(section){
    $$('.section').forEach(function(node){ node.classList.remove('active'); });
    var target = $('#sec-' + section);
    if(target){ target.classList.add('active'); }
    $('#section-title').textContent = SECTION_TITLES[section] || section;
  }

  function startLogsPolling(){
    if(logsTicker) clearInterval(logsTicker);
    logsTicker = setInterval(function(){
      if(currentSection === 'logs') loadLogs(false);
    }, 3000);
  }

  function stopLogsPolling(){
    if(logsTicker){
      clearInterval(logsTicker);
      logsTicker = null;
    }
  }

  function navigateTo(section, options){
    var opts = options || {};
    var target = SECTIONS.includes(section) ? section : 'overview';
    if(currentSection === target && !opts.force){
      if(opts.updateHash && location.hash !== '#' + target){
        location.hash = '#' + target;
      }
      return;
    }
    currentSection = target;
    setNavActive(target);
    setSectionActive(target);
    if(opts.updateHash && location.hash !== '#' + target){
      location.hash = '#' + target;
    }
    if(target === 'logs') startLogsPolling(); else stopLogsPolling();
    if(shouldCloseSidebarOnNavigate()) closeSidebar();
    loadSection(target, true);
  }

  function startSectionLoading(section){
    loadingSection[section] = true;
    var sectionNode = $('#sec-' + section);
    if(sectionNode) sectionNode.classList.add('loading');
  }

  function finishSectionLoading(section){
    loadingSection[section] = false;
    var sectionNode = $('#sec-' + section);
    if(sectionNode) sectionNode.classList.remove('loading');
  }

  function toFiniteArray(values){
    return (values || []).map(function(value){ return Number(value); }).filter(function(value){ return Number.isFinite(value); });
  }

  function percentile(values, ratio){
    var data = toFiniteArray(values).sort(function(a, b){ return a - b; });
    if(data.length === 0) return null;
    var index = Math.min(data.length - 1, Math.max(0, Math.ceil(ratio * data.length) - 1));
    return data[index];
  }

  function rollingPercentile(values, ratio){
    var source = toFiniteArray(values);
    if(source.length === 0) return [];
    var out = [];
    for(var i = 0; i < source.length; i += 1){
      out.push(percentile(source.slice(0, i + 1), ratio));
    }
    return out;
  }

  function linePath(points, width, height, padding){
    var safePadding = padding || 6;
    var data = toFiniteArray(points);
    if(data.length === 0) return '';
    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var spread = max - min || 1;
    var innerW = Math.max(1, width - safePadding * 2);
    var innerH = Math.max(1, height - safePadding * 2);
    return data.map(function(value, index){
      var x = safePadding + (data.length === 1 ? 0 : innerW * (index / (data.length - 1)));
      var y = safePadding + innerH * (1 - ((value - min) / spread));
      return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }).join(' ');
  }

  function svgSparkline(points, color){
    var width = 220;
    var height = 36;
    var path = linePath(points, width, height, 4);
    if(!path) return '';
    return '<svg class="sparkline" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><path d="' + path + '" fill="none" stroke="' + (color || '#818cf8') + '" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function svgLineChart(pointsA, pointsB){
    var width = 560;
    var height = 110;
    var pathA = linePath(pointsA, width, height, 8);
    var pathB = linePath(pointsB, width, height, 8);
    if(!pathA && !pathB) return '<div class="empty-state" style="padding:18px"><p>No timeline data</p></div>';
    return '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
      (pathA ? '<path d="' + pathA + '" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round"/>' : '') +
      (pathB ? '<path d="' + pathB + '" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>' : '') +
      '</svg>';
  }

  function svgAreaChart(points){
    var data = toFiniteArray(points);
    var width = 560;
    var height = 110;
    var path = linePath(data, width, height, 8);
    if(!path) return '<div class="empty-state" style="padding:18px"><p>No timeline data</p></div>';
    var firstX = 8;
    var lastX = width - 8;
    if(data.length > 1){
      lastX = firstX + (width - 16);
    }
    var areaPath = path + ' L ' + lastX + ' ' + (height - 8) + ' L ' + firstX + ' ' + (height - 8) + ' Z';
    return '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><path d="' + areaPath + '" fill="rgba(34,197,94,.22)"/><path d="' + path + '" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function svgBarChart(points){
    var data = toFiniteArray(points);
    if(data.length === 0) return '<div class="empty-state" style="padding:18px"><p>No timeline data</p></div>';
    var width = 560;
    var height = 110;
    var barWidth = Math.max(2, Math.floor((width - 20) / data.length));
    var max = Math.max.apply(null, data.concat([1]));
    var bars = data.map(function(value, index){
      var x = 10 + index * barWidth;
      var barHeight = Math.max(2, ((height - 16) * (value / max)));
      var y = height - 8 - barHeight;
      return '<rect x="' + x + '" y="' + y + '" width="' + Math.max(1, barWidth - 1) + '" height="' + barHeight + '" fill="rgba(96,165,250,.85)" rx="1"/>';
    }).join('');
    return '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' + bars + '</svg>';
  }

  function metricChartHtml(title, content){
    return '<div class="chart-wrap"><div class="chart-title">' + h(title) + '</div><div class="chart-box">' + content + '</div></div>';
  }

  function metricChartEmpty(message){
    return '<div class="data-empty" style="padding:18px">' + h(message) + '</div>';
  }

  function renderMetricsCharts(timeline, sampleSizes){
    if(!timeline) return '<div class="empty-state" style="padding:18px"><p>No timeline data available</p></div>';
    var hybrid = timeline.hybrid || [];
    var watch = timeline.watch_flush || [];
    var memory = timeline.memory || [];
    var samples = sampleSizes || {};
    var latencyAvg = hybrid.map(function(item){ return item.avg_latency_ms; });
    var rawP95 = hybrid.map(function(item){ return item.p95_latency_ms; });
    var latencyP95 = rawP95.some(function(value){ return Number.isFinite(Number(value)); })
      ? rawP95
      : rollingPercentile(latencyAvg, 0.95);
    var successRate = hybrid.map(function(item){ return (item.success_rate == null ? null : Number(item.success_rate) * 100); });
    var watchLatency = watch.map(function(item){ return item.latency_ms; });
    var memoryLatency = memory.map(function(item){ return item.latency_ms; });
    var memoryHitRate = memory.map(function(item){
      if(item.hit === true) return 100;
      if(item.hit === false) return 0;
      return null;
    });

    var html = '';
    html += metricChartHtml(
      'Query Latency (avg and p95)',
      hybrid.length ? svgLineChart(latencyAvg, latencyP95) : metricChartEmpty('No hybrid query samples yet in the selected window.')
    );
    html += metricChartHtml(
      'Success Rate',
      hybrid.length ? svgAreaChart(successRate) : metricChartEmpty('Success rate appears after hybrid query events are recorded.')
    );
    html += metricChartHtml(
      'Watch Flush Latency',
      watch.length ? svgBarChart(watchLatency) : metricChartEmpty('No watch flush samples yet. Start watch-index or trigger index refreshes to populate this chart.')
    );
    html += metricChartHtml(
      'Memory Query Latency',
      memory.length ? svgBarChart(memoryLatency) : metricChartEmpty('No memory search samples found in the selected window.')
    );
    html += metricChartHtml(
      'Memory Hit Rate',
      memory.length ? svgAreaChart(memoryHitRate) : metricChartEmpty('Memory hit-rate appears once memory search events are recorded.')
    );

    if(shouldRenderMetricsEmptyState(timeline, samples)){
      html = '<div class="empty-state" style="padding:24px"><p>No metrics samples recorded yet.</p></div>';
    }
    return html;
  }

  function renderMetricsAvailability(metrics, tuner){
    var inputs = metrics && metrics.inputs ? metrics.inputs : {};
    var sampleSizes = metrics && metrics.sample_sizes ? metrics.sample_sizes : {};
    var tunerSummary = tuner && tuner.summary ? tuner.summary : {};
    var cards = summaryGridHtml([
      {
        label: 'Hybrid Events',
        value: fmt(sampleSizes.hybrid_events || 0),
        sub: inputs.hybrid_file && inputs.hybrid_file.exists ? 'file present' : 'file missing'
      },
      {
        label: 'Watch Flush',
        value: fmt(sampleSizes.watch_flush_events || 0),
        sub: inputs.watch_flush_file && inputs.watch_flush_file.exists ? 'file present' : 'file missing'
      },
      {
        label: 'Memory Events',
        value: fmt(sampleSizes.memory_events || 0),
        sub: inputs.memory_file && inputs.memory_file.exists ? 'file present' : 'file missing'
      },
      {
        label: 'Tuner Decisions',
        value: fmt(tunerSummary.decision_count || 0),
        sub: tuner && tuner.inputs && tuner.inputs.tuner_db && tuner.inputs.tuner_db.exists ? 'db present' : 'db missing'
      }
    ]);

    var items = [
      {
        title: 'Hybrid Query Metrics',
        status: (sampleSizes.hybrid_events || 0) > 0 ? 'ok' : (inputs.hybrid_file && inputs.hybrid_file.exists ? 'warn' : 'info'),
        message: (sampleSizes.hybrid_events || 0) > 0
          ? fmt(sampleSizes.hybrid_events || 0) + ' events in the current window.'
          : (inputs.hybrid_file && inputs.hybrid_file.exists
            ? 'Metric file exists, but no hybrid events are inside the current window.'
            : 'No hybrid metric file yet. Run hybrid queries to generate data.')
      },
      {
        title: 'Watch Flush Metrics',
        status: (sampleSizes.watch_flush_events || 0) > 0 ? 'ok' : (inputs.watch_flush_file && inputs.watch_flush_file.exists ? 'warn' : 'info'),
        message: (sampleSizes.watch_flush_events || 0) > 0
          ? fmt(sampleSizes.watch_flush_events || 0) + ' watch flush events available.'
          : (inputs.watch_flush_file && inputs.watch_flush_file.exists
            ? 'Watch metrics file exists, but there are no flush events in the current window.'
            : 'No watch metrics file yet. Start watch-index or trigger reindex work to populate it.')
      },
      {
        title: 'Memory Metrics',
        status: (sampleSizes.memory_events || 0) > 0 ? 'ok' : (inputs.memory_file && inputs.memory_file.exists ? 'warn' : 'info'),
        message: (sampleSizes.memory_events || 0) > 0
          ? fmt(sampleSizes.memory_events || 0) + ' memory search events available.'
          : 'No memory search samples recorded yet.'
      },
      {
        title: 'Online Tuner',
        status: (tunerSummary.decision_count || 0) > 0 ? 'ok' : 'info',
        message: (tunerSummary.decision_count || 0) > 0
          ? fmt(tunerSummary.decision_count || 0) + ' tuner decisions and ' + fmt(tunerSummary.outcome_count || 0) + ' outcomes recorded.'
          : 'No tuner decisions yet. This is normal until online tuner data is collected.'
      }
    ];

    return '<div class="card fade-in" style="margin-bottom:16px"><div class="card-title">Data Availability</div>' + cards +
      '<div class="ops-list">' + items.map(function(item){
        return '<div class="ops-item"><div class="ops-item-head"><span class="ops-item-title">' + h(item.title) + '</span>' + statusPill(item.status) + '</div>' +
          '<div class="ops-item-sub">' + h(item.message) + '</div></div>';
      }).join('') + '</div></div>';
  }

  function renderOverviewSkeleton(){
    $('#overview-cards').innerHTML = skeletonCards(4);
    $('#server-info').innerHTML = skeletonStats(6);
  }

  function renderIndexesSkeleton(){
    $('#index-cards').innerHTML = skeletonCards(4);
  }

  function renderMemorySkeleton(){
    $('#memory-summary-cards').innerHTML = skeletonCards(3);
    $('#memory-details').innerHTML = skeletonStats(5);
  }

  function renderMetricsSkeleton(){
    $('#metrics-content').innerHTML = skeletonStats(8);
  }

  function renderLogsSkeleton(){
    $('#logs-view').innerHTML = '<div class="skeleton" style="height:320px"></div>';
  }

  var iconDb = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
  var iconTree = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  var iconBrain = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>';
  var iconChart = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  async function loadOverview(showSkeleton){
    if(showSkeleton) renderOverviewSkeleton();
    var data = await api('overview');
    if(!data) return;
    currentOverview = data;

    var ix = data.indexes || {};
    var sparkSource = ((lastTimeline && lastTimeline.hybrid) || []).map(function(item){ return item.avg_latency_ms; }).filter(function(v){ return Number.isFinite(Number(v)); });
    var spark = sparkSource.length > 1 ? svgSparkline(sparkSource, '#60a5fa') : '';
    var cards = [
      cardHtml(iconDb, 'indigo', 'Code Index', ix.code_files != null ? fmt(ix.code_files) : '-', 'files indexed', spark),
      cardHtml(iconTree, 'green', 'Syntax Index', ix.syntax_files != null ? fmt(ix.syntax_files) : '-', 'files parsed'),
      cardHtml(iconBrain, 'amber', 'Semantic Graph', ix.semantic_nodes != null ? fmt(ix.semantic_nodes) : '-', 'nodes'),
      cardHtml(iconChart, 'blue', 'Vector Index', ix.vector_chunks != null ? fmt(ix.vector_chunks) : '-', 'embeddings')
    ];
    $('#overview-cards').innerHTML = cards.join('');

    var info = data.server || {};
    var rows = [
      ['Transport', h(info.transport || '-')],
      ['Host', h(info.host || '-')],
      ['Port', h(String(info.port || '-'))],
      ['Workspace', h(info.workspace_root || '-')],
      ['Toolsets', (info.toolsets || []).map(function(name){ return '<span class="pill info">' + h(name) + '</span>'; }).join(' ') || '-'],
      ['Low-level exposed', info.expose_low_level ? '<span class="pill warn">Yes</span>' : '<span class="pill ok">No</span>']
    ];
    if(data.memory){ rows.push(['Memory lessons', fmt(data.memory.total_lessons)]); }
    $('#server-info').innerHTML = statRowsHtml(rows);
    if(info.version){ $('#server-version').textContent = 'Clawty MCP v' + info.version; }

    if(info.started_at){
      var startedMs = Date.parse(info.started_at);
      if(Number.isFinite(startedMs)) uptimeBaseMs = startedMs;
    } else if(Number.isFinite(Number(info.uptime_ms))){
      uptimeBaseMs = Date.now() - Number(info.uptime_ms);
    }
    updateUptime();
  }

  async function loadIndexes(showSkeleton){
    if(showSkeleton) renderIndexesSkeleton();
    var data = await api('index-stats');
    if(!data){
      $('#index-cards').innerHTML = '<div class="empty-state"><p>Failed to load index stats</p></div>';
      return;
    }
    var sections = [
      { key: 'code', title: 'Code Index (FTS5)', render: renderCodeIndex },
      { key: 'syntax', title: 'Syntax Index', render: renderSyntaxIndex },
      { key: 'semantic', title: 'Semantic Graph', render: renderSemanticIndex },
      { key: 'vector', title: 'Vector Index', render: renderVectorIndex }
    ];
    var html = '';
    sections.forEach(function(section){
      var dataItem = data[section.key];
      html += '<div class="card fade-in"><div class="card-title" style="display:flex;justify-content:space-between;align-items:center">' + h(section.title) + ' ' + pillHtml(dataItem && dataItem.ok) + '</div>';
      if(dataItem && dataItem.ok !== false){ html += section.render(dataItem); }
      else { html += '<div class="empty-state" style="padding:24px"><p>' + h((dataItem && dataItem.error) || 'Not built yet') + '</p></div>'; }
      html += '</div>';
    });
    $('#index-cards').innerHTML = html;
  }

  function renderCodeIndex(d){
    var queryMetrics = d.query_metrics || {};
    var html = summaryGridHtml([
      { label: 'Files', value: fmt(d.total_files) },
      { label: 'Chunks', value: fmt(d.total_chunks) },
      { label: 'Symbols', value: fmt(d.total_symbols || 0) },
      { label: 'Unique Tokens', value: fmt(d.unique_tokens || 0), sub: 'symbol terms ' + fmt(d.total_symbol_terms || 0) }
    ]);
    html += indexSectionHtml('Index Configuration', statRowsHtml([
      ['Engine', h(d.engine || '-')],
      ['Updated', h(formatTimestampShort(d.updated_at))],
      ['Max files', fmt(d.config && d.config.max_files)],
      ['Max file size', h(formatKilobytes(d.config && d.config.max_file_size_kb))]
    ]));
    html += indexSectionHtml('Query Metrics', statRowsHtml([
      ['Total queries', fmt(queryMetrics.total_queries || 0)],
      ['Cache hit rate', Number(queryMetrics.total_queries || 0) > 0 ? fmtPct(queryMetrics.cache_hit_rate) : '-'],
      ['Avg latency', Number(queryMetrics.total_queries || 0) > 0 ? fmtMs(queryMetrics.avg_latency_ms) : '-'],
      ['Zero-hit queries', fmt(queryMetrics.zero_hit_queries || 0)]
    ]));
    if(d.languages && d.languages.length){
      html += indexSectionHtml('Languages', barChartHtml(d.languages.map(function(lang){
        return { label: lang.language, value: lang.count };
      }), 'indigo'));
    }
    if(d.top_files && d.top_files.length){
      html += indexSectionHtml('Largest Indexed Files', indexListHtml(d.top_files.slice(0, 6).map(function(item){
        return {
          title: tailPath(item.path, 2),
          titleTooltip: item.path,
          path: compactPath(item.path, 4),
          pathTooltip: item.path,
          meta: formatBytes(item.size) + ' · ' + fmt(item.line_count) + ' lines'
        };
      })));
    }
    return html;
  }

  function renderSyntaxIndex(d){
    var latestRun = d.latest_run || {};
    var html = summaryGridHtml([
      { label: 'Files', value: fmt(d.total_files) },
      { label: 'Imports', value: fmt(d.total_imports) },
      { label: 'Calls', value: fmt(d.total_calls || 0) },
      { label: 'Provider', value: d.provider || '-', sub: d.parser_version || '-' }
    ]);
    html += indexSectionHtml('Latest Run', statRowsHtml([
      ['Mode', h(latestRun.mode || '-')],
      ['Parsed files', fmt(latestRun.parsed_files || 0)],
      ['Reused files', fmt(latestRun.reused_files || 0)],
      ['Errors', fmt(latestRun.error_count || 0)],
      ['Duration', h(formatDurationBetween(latestRun.started_at, latestRun.completed_at))],
      ['Completed', h(formatTimestampShort(latestRun.completed_at))]
    ]));
    if(d.top_callers && d.top_callers.length){
      html += indexSectionHtml('Top Callers', indexListHtml(d.top_callers.slice(0, 8).map(function(item){
        return {
          title: tailPath(item.path, 2),
          titleTooltip: item.path,
          path: compactPath(item.path, 4),
          pathTooltip: item.path,
          meta: fmt(item.call_count) + ' calls'
        };
      })));
    }
    if(d.top_imported && d.top_imported.length){
      html += indexSectionHtml('Top Imported Modules', indexListHtml(d.top_imported.slice(0, 8).map(function(item){
        var importedPath = String(item.imported_path || '');
        var isPackage = importedPath.indexOf('pkg:') === 0;
        return {
          title: isPackage ? importedPath.replace(/^pkg:/, '') : tailPath(importedPath, 2),
          titleTooltip: importedPath,
          path: isPackage ? '' : compactPath(importedPath, 4),
          pathTooltip: importedPath,
          meta: fmt(item.count) + ' imports'
        };
      })));
    }
    return html;
  }

  function renderSemanticIndex(d){
    var rows = [['Nodes', fmt(d.total_nodes || d.node_count)], ['Edges', fmt(d.total_edges || d.edge_count)]];
    if(d.node_types){
      Object.entries(d.node_types).forEach(function(entry){ rows.push([entry[0], fmt(entry[1])]); });
    }
    return statRowsHtml(rows);
  }

  function renderVectorIndex(d){
    var rows = [['Total chunks', fmt(d.total_chunks || d.total)]];
    if(d.layers){
      Object.entries(d.layers).forEach(function(entry){ rows.push(['Layer: ' + entry[0], fmt(entry[1])]); });
    }
    if(d.model){ rows.push(['Model', h(d.model)]); }
    return statRowsHtml(rows);
  }

  async function loadMemory(showSkeleton){
    if(showSkeleton) renderMemorySkeleton();
    var data = await api('memory-stats');
    if(!data || !data.ok){
      $('#memory-summary-cards').innerHTML = '';
      $('#memory-details').innerHTML = '<div class="empty-state"><p>' + h((data && data.error) || 'Memory system not available') + '</p></div>';
      return;
    }

    var cards = [
      cardHtml(iconBrain, 'indigo', 'Lessons', fmt(data.total_lessons), 'total stored'),
      cardHtml(iconDb, 'amber', 'Episodes', fmt(data.total_episodes), 'recorded'),
      cardHtml(iconChart, 'green', 'Feedback', fmt(data.total_feedback), 'entries')
    ];
    $('#memory-summary-cards').innerHTML = cards.join('');

    var detailHtml = '<div class="card fade-in"><div class="card-title">Details</div>';
    var rows = [['Scope', h(data.scope || '-')], ['Quarantined', fmt(data.quarantined || 0)]];
    if(data.db_path){ rows.push(['DB path', h(data.db_path)]); }
    detailHtml += statRowsHtml(rows);

    if(data.top_lessons && data.top_lessons.length){
      detailHtml += '<div style="margin-top:16px"><div class="card-title">Top Lessons</div>';
      detailHtml += data.top_lessons.map(function(item){
        return '<div class="tool-item"><div class="tool-name">' + h(item.title || item.id) + '</div><div class="tool-desc">Score: ' + fmt(item.confidence || item.score) + ' · Updated: ' + h(item.updated_at || '-') + '</div></div>';
      }).join('');
      detailHtml += '</div>';
    }

    detailHtml += '</div>';
    $('#memory-details').innerHTML = detailHtml;
  }

  function metricValue(first, second){
    if(first != null) return first;
    return second != null ? second : null;
  }

  function metricsWindowLabel(hours){
    var normalized = Number(hours) || 24;
    if(normalized === 1) return 'Last 1 hour';
    if(normalized === 24) return 'Last 24 hours';
    if(normalized === 168) return 'Last 7 days';
    if(normalized % 24 === 0) return 'Last ' + (normalized / 24) + ' days';
    return 'Last ' + normalized + ' hours';
  }

  function setMetricsWindowActive(){
    $$('.metrics-window-btn').forEach(function(button){
      var hours = Number(button.dataset.hours || 24);
      button.classList.toggle('active', hours === metricsState.windowHours);
    });
    var note = $('#metrics-window-note');
    if(note) note.textContent = metricsWindowLabel(metricsState.windowHours);
  }

  async function loadMetrics(showSkeleton){
    if(showSkeleton) renderMetricsSkeleton();
    setMetricsWindowActive();
    var query = '?window_hours=' + encodeURIComponent(String(metricsState.windowHours || 24));
    var data = await api('metrics' + query);
    var timeline = await api('metrics-timeline?limit=40&window_hours=' + encodeURIComponent(String(metricsState.windowHours || 24)));
    if(timeline) lastTimeline = timeline;

    if(!data && !timeline){
      $('#metrics-content').innerHTML = '<div class="empty-state"><p>Failed to load metrics</p></div>';
      return;
    }

    var html = '';
    var metrics = data ? data.metrics : null;
    var tuner = data ? data.tuner : null;

    if(metrics){
      var kpi = metrics.kpi || {};
      var sampleSizes = metrics.sample_sizes || {};
      html += renderMetricsAvailability(metrics, tuner);
      var rows = [
        ['Hybrid P95 latency', fmtMs(metricValue(kpi.query_hybrid_p95_ms, metrics?.hybrid_query?.p95_latency_ms))],
        ['Degrade rate', fmtPct(metricValue(kpi.degrade_rate, metrics?.hybrid_query?.degrade_rate))],
        ['Watch refresh P95', fmtMs(metricValue(kpi.watch_refresh_p95_ms, metrics?.watch_flush?.p95_latency_ms))],
        ['Memory query P95', fmtMs(metricValue(kpi.memory_query_p95_ms, metrics?.memory_search?.p95_latency_ms))],
        ['Memory hit rate', fmtPct(kpi.memory_hit_rate)],
        ['Memory fallback rate', fmtPct(kpi.memory_fallback_rate)],
        ['Window', fmt(metrics.window_hours) + 'h'],
        ['Memory samples', fmt(sampleSizes.memory_events || 0)]
      ];
      html += '<div class="card fade-in" style="margin-bottom:16px"><div class="card-title">KPI Summary</div>' + statRowsHtml(rows);
      html += renderMetricsCharts(timeline, sampleSizes);
      html += '</div>';
    } else {
      html += '<div class="card fade-in" style="margin-bottom:16px"><div class="card-title">Timeline Charts</div>' + renderMetricsCharts(timeline) + '</div>';
    }

    if(tuner){
      html += '<div class="card fade-in"><div class="card-title">Online Tuner</div>';
      if(tuner.arms && tuner.arms.length){
        html += barChartHtml(tuner.arms.map(function(arm){ return { label: arm.name || arm.arm, value: arm.pulls || arm.count || 0 }; }), 'amber');
        var tunerRows = [];
        if(tuner.summary && tuner.summary.decision_count != null) tunerRows.push(['Decisions', fmt(tuner.summary.decision_count)]);
        if(tuner.summary && tuner.summary.outcome_count != null) tunerRows.push(['Outcomes', fmt(tuner.summary.outcome_count)]);
        if(tuner.summary && tuner.summary.success_rate != null) tunerRows.push(['Success rate', fmtPct(tuner.summary.success_rate)]);
        if(tuner.total_pulls != null) tunerRows.push(['Total pulls', fmt(tuner.total_pulls)]);
        if(tuner.best_arm) tunerRows.push(['Best arm', h(tuner.best_arm)]);
        html += '<div style="margin-top:12px">' + statRowsHtml(tunerRows) + '</div>';
      } else {
        html += '<div class="empty-state" style="padding:16px"><p>No tuner data yet. This section fills in after online tuner decisions are recorded.</p></div>';
      }
      html += '</div>';
    }

    $('#metrics-content').innerHTML = html;
  }

  function tryParseJson(text){
    if(typeof text !== 'string') return null;
    var trimmed = text.trim();
    if(!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function statusPill(status, fallback){
    var normalized = String(status || fallback || 'unknown').toLowerCase();
    var cls = 'info';
    if(normalized === 'pass' || normalized === 'ok' || normalized === 'success' || normalized === 'true') cls = 'ok';
    else if(normalized === 'warn' || normalized === 'warning') cls = 'warn';
    else if(normalized === 'fail' || normalized === 'error' || normalized === 'false') cls = 'err';
    return '<span class="pill ' + cls + '">' + h(normalized.toUpperCase()) + '</span>';
  }

  function cfgPathParts(pathText){
    return String(pathText || '').split('.').filter(Boolean);
  }

  function cfgGet(target, pathText){
    var parts = cfgPathParts(pathText);
    var current = target;
    for(var i = 0; i < parts.length; i += 1){
      if(!current || typeof current !== 'object') return undefined;
      current = current[parts[i]];
    }
    return current;
  }

  function cfgSet(target, pathText, value){
    var parts = cfgPathParts(pathText);
    if(parts.length === 0) return;
    var current = target;
    for(var i = 0; i < parts.length - 1; i += 1){
      var key = parts[i];
      if(!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])){
        current[key] = {};
      }
      current = current[key];
    }
    current[parts[parts.length - 1]] = value;
  }

  function cfgDelete(target, pathText){
    var parts = cfgPathParts(pathText);
    if(parts.length === 0) return;
    var current = target;
    for(var i = 0; i < parts.length - 1; i += 1){
      var key = parts[i];
      if(!current[key] || typeof current[key] !== 'object') return;
      current = current[key];
    }
    delete current[parts[parts.length - 1]];
  }

  function cfgClone(input){
    if(!input || typeof input !== 'object') return {};
    try {
      return JSON.parse(JSON.stringify(input));
    } catch {
      return {};
    }
  }

  function cfgPruneEmpty(value){
    if(value === null || value === undefined) return undefined;
    if(Array.isArray(value)){
      return value;
    }
    if(typeof value !== 'object'){
      return value;
    }
    var out = {};
    Object.entries(value).forEach(function(entry){
      var key = entry[0];
      var val = cfgPruneEmpty(entry[1]);
      if(val === undefined) return;
      if(val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0){
        return;
      }
      out[key] = val;
    });
    return out;
  }

  function formatConfigValue(value){
    if(value === null || value === undefined) return '(unset)';
    if(typeof value === 'boolean') return value ? 'true' : 'false';
    if(typeof value === 'number') return String(value);
    if(typeof value === 'string') return value;
    if(Array.isArray(value)) return '[' + value.length + ' items]';
    return '[object]';
  }

  function shouldShowConfigField(field){
    var fileValue = cfgGet(configState.fileData, field.path);
    var effectivePath = field.effectivePath || field.path;
    var effectiveValue = cfgGet(configState.effectiveData, effectivePath);
    if(configState.showAdvanced) return true;
    if(field.always) return true;
    return fileValue !== undefined || effectiveValue !== undefined;
  }

  function renderConfigInput(field, fileValue, effectiveValue){
    var inputId = 'cfg-' + field.path.replace(/[^a-zA-Z0-9_]+/g, '-');
    var commonAttr = ' id="' + h(inputId) + '" data-cfg-path="' + h(field.path) + '" data-cfg-type="' + h(field.type) + '"';
    if(field.type === 'bool'){
      var boolValue = fileValue === true ? 'true' : fileValue === false ? 'false' : '';
      var effectiveHint = formatConfigValue(effectiveValue);
      return '<select' + commonAttr + '>' +
        '<option value="">(default: ' + h(effectiveHint) + ')</option>' +
        '<option value="true"' + (boolValue === 'true' ? ' selected' : '') + '>true</option>' +
        '<option value="false"' + (boolValue === 'false' ? ' selected' : '') + '>false</option>' +
        '</select>';
    }
    if(field.type === 'select'){
      var selected = typeof fileValue === 'string' ? fileValue : '';
      var options = (field.options || []).map(function(option){
        return '<option value="' + h(option) + '"' + (selected === option ? ' selected' : '') + '>' + h(option) + '</option>';
      }).join('');
      return '<select' + commonAttr + '><option value="">(default)</option>' + options + '</select>';
    }
    if(field.type === 'password'){
      var placeholder = cfgGet(configState.fileData, field.path) !== undefined
        ? 'Configured. Leave blank to keep existing'
        : (cfgGet(configState.effectiveData, field.effectivePath || field.path) !== undefined
          ? 'Provided by env/default. Set to override'
          : (field.placeholder || 'Enter value'));
      return '<input type="password"' + commonAttr + ' value="" placeholder="' + h(placeholder) + '" autocomplete="new-password">';
    }
    if(field.type === 'number' || field.type === 'float'){
      var numeric = Number(fileValue);
      var valueText = Number.isFinite(numeric) ? String(numeric) : '';
      var step = field.type === 'float' ? (field.step || 0.01) : 1;
      var minAttr = field.min != null ? ' min="' + field.min + '"' : '';
      var maxAttr = field.max != null ? ' max="' + field.max + '"' : '';
      return '<input type="number"' + commonAttr + ' value="' + h(valueText) + '" step="' + h(String(step)) + '"' + minAttr + maxAttr + '>';
    }
    var textValue = typeof fileValue === 'string' ? fileValue : '';
    return '<input type="text"' + commonAttr + ' value="' + h(textValue) + '">';
  }

  function renderConfigEditor(){
    var html = '';
    CONFIG_SCHEMA.forEach(function(section){
      var visibleFields = section.fields.filter(shouldShowConfigField);
      if(visibleFields.length === 0) return;
      html += '<div class="cfg-section"><div class="cfg-title">' + h(section.title) + '</div>';
      visibleFields.forEach(function(field){
        var fileValue = cfgGet(configState.fileData, field.path);
        var effectiveValue = cfgGet(configState.effectiveData, field.effectivePath || field.path);
        var sourceBadge = '';
        if(fileValue !== undefined && effectiveValue !== undefined && formatConfigValue(fileValue) !== formatConfigValue(effectiveValue)){
          sourceBadge = '<span class="cfg-badge">effective override</span>';
        } else if(fileValue === undefined && effectiveValue !== undefined){
          sourceBadge = '<span class="cfg-badge">default/effective</span>';
        }
        html += '<div class="cfg-row"><div><div class="cfg-label">' + h(field.path.split('.').slice(-1)[0]) + sourceBadge + '</div><div class="cfg-path">' + h(field.path) + '</div></div>';
        html += '<div class="cfg-input-wrap">' + renderConfigInput(field, fileValue, effectiveValue) + '<div class="cfg-note">Effective: ' + h(formatConfigValue(effectiveValue)) + '</div></div></div>';
      });
      html += '</div>';
    });

    if(!html){
      html = '<div class="data-empty">No editable fields found for current config.</div>';
    }
    $('#config-content').innerHTML = html;
  }

  function collectConfigPayload(){
    var payload = cfgClone(configState.fileData);
    $$('[data-cfg-path]').forEach(function(element){
      var pathText = element.dataset.cfgPath;
      var type = element.dataset.cfgType;
      if(type === 'password'){
        var passwordValue = String(element.value || '');
        if(passwordValue.trim().length > 0){
          cfgSet(payload, pathText, passwordValue.trim());
        }
        return;
      }
      if(type === 'bool'){
        if(element.value === ''){
          cfgDelete(payload, pathText);
        } else {
          cfgSet(payload, pathText, element.value === 'true');
        }
        return;
      }
      if(type === 'select'){
        if(element.value === ''){
          cfgDelete(payload, pathText);
        } else {
          cfgSet(payload, pathText, String(element.value));
        }
        return;
      }
      if(type === 'number' || type === 'float'){
        var raw = String(element.value || '').trim();
        if(raw.length === 0){
          cfgDelete(payload, pathText);
          return;
        }
        var numeric = Number(raw);
        if(Number.isFinite(numeric)){
          cfgSet(payload, pathText, numeric);
        }
        return;
      }
      var textValue = String(element.value || '').trim();
      if(textValue.length === 0){
        cfgDelete(payload, pathText);
      } else {
        cfgSet(payload, pathText, textValue);
      }
    });
    return cfgPruneEmpty(payload) || {};
  }

  function setConfigStatus(message, type){
    var node = $('#config-status');
    if(!node) return;
    node.textContent = message || '';
    if(type === 'ok') node.style.color = 'var(--success)';
    else if(type === 'err') node.style.color = 'var(--error)';
    else node.style.color = 'var(--text-muted)';
  }

  function renderSummaryCard(label, value){
    return '<div class="ops-summary-card"><div class="ops-summary-k">' + h(label) + '</div><div class="ops-summary-v">' + h(String(value)) + '</div></div>';
  }

  function renderDoctorResult(payload){
    if(!payload){
      return '<div class="data-empty">No report yet.</div>';
    }
    if(payload.ok === false && payload.error){
      return '<div class="data-empty">' + h(payload.error) + '</div>';
    }
    var summary = payload.summary || {};
    var checks = payload.checks || [];
    var summaryHtml = '<div class="ops-summary">' +
      renderSummaryCard('Total', summary.total != null ? summary.total : checks.length) +
      renderSummaryCard('Pass', summary.pass != null ? summary.pass : 0) +
      renderSummaryCard('Warn', summary.warn != null ? summary.warn : 0) +
      renderSummaryCard('Fail', summary.fail != null ? summary.fail : 0) +
      '</div>';
    var listHtml = checks.slice(0, 40).map(function(check){
      return '<div class="ops-item"><div class="ops-item-head"><span class="ops-item-title">' + h(check.title || check.id || 'check') + '</span>' + statusPill(check.status) + '</div>' +
        '<div class="ops-item-sub">' + h(check.message || '') + '</div></div>';
    }).join('');
    return summaryHtml + (listHtml ? '<div class="ops-list">' + listHtml + '</div>' : '<div class="data-empty">No checks returned.</div>');
  }

  function extractStepDetail(step){
    if(!step || !step.result || typeof step.result !== 'object') return '';
    var fields = [];
    if(step.result.mode) fields.push('mode=' + step.result.mode);
    if(step.result.elapsed_ms != null) fields.push('elapsed=' + fmtMs(step.result.elapsed_ms));
    if(step.result.processed_files != null) fields.push('files=' + step.result.processed_files);
    if(step.result.total_files != null) fields.push('total=' + step.result.total_files);
    return fields.join(' · ');
  }

  function renderReindexResult(payload){
    if(!payload){
      return '<div class="data-empty">No run yet.</div>';
    }
    if(payload.ok === false && payload.error){
      return '<div class="data-empty">' + h(payload.error) + '</div>';
    }
    var steps = payload.steps || [];
    var failed = steps.filter(function(step){ return step.ok === false; }).length;
    var summaryHtml = '<div class="ops-summary">' +
      renderSummaryCard('Status', payload.ok ? 'OK' : 'FAILED') +
      renderSummaryCard('Steps', steps.length) +
      renderSummaryCard('Failed', failed) +
      renderSummaryCard('Elapsed', payload.elapsed_ms != null ? fmtMs(payload.elapsed_ms) : '-') +
      '</div>';
    var listHtml = steps.map(function(step){
      var detail = step.error ? step.error : extractStepDetail(step);
      return '<div class="ops-item"><div class="ops-item-head"><span class="ops-item-title">' + h(step.name || step.tool || 'step') + '</span>' + statusPill(step.ok ? 'ok' : 'error') + '</div>' +
        (detail ? '<div class="ops-item-sub">' + h(detail) + '</div>' : '') + '</div>';
    }).join('');
    return summaryHtml + (listHtml ? '<div class="ops-list">' + listHtml + '</div>' : '<div class="data-empty">No steps returned.</div>');
  }

  function renderMemorySearchResult(payload){
    if(!payload){
      return '<div class="data-empty">No search yet.</div>';
    }
    if(payload.ok === false){
      return '<div class="data-empty">' + h(payload.error || 'Search failed') + '</div>';
    }
    var items = Array.isArray(payload.results) ? payload.results : (Array.isArray(payload.items) ? payload.items : []);
    var summaryHtml = '<div class="ops-summary">' +
      renderSummaryCard('Hits', items.length) +
      renderSummaryCard('Latency', payload.query_total_ms != null ? fmtMs(payload.query_total_ms) : '-') +
      renderSummaryCard('Tokens', payload.token_count != null ? payload.token_count : '-') +
      renderSummaryCard('Scope', payload.scope || '-') +
      '</div>';
    if(items.length === 0){
      return summaryHtml + '<div class="data-empty">No matching memory items.</div>';
    }
    var listHtml = items.slice(0, 20).map(function(item){
      var score = item.confidence != null ? item.confidence : item.score;
      var title = item.title || item.id || 'Untitled';
      var meta = [];
      if(score != null) meta.push('score=' + score);
      if(item.updated_at) meta.push('updated=' + item.updated_at);
      if(Array.isArray(item.tags) && item.tags.length) meta.push('tags=' + item.tags.join(','));
      return '<div class="ops-memory-item"><div class="ops-memory-title">' + h(String(title)) + '</div>' +
        (item.lesson ? '<div class="ops-item-sub">' + h(String(item.lesson).slice(0, 220)) + '</div>' : '') +
        '<div class="ops-memory-meta">' + h(meta.join(' · ')) + '</div></div>';
    }).join('');
    return summaryHtml + '<div class="ops-memory-list">' + listHtml + '</div>';
  }

  function renderLogEntries(entries){
    if(!entries || !entries.length){
      return '<div class="empty-state" style="padding:24px"><p>No matching logs</p></div>';
    }
    return entries.map(function(entry){
      var lvl = entry.level || 'unknown';
      var parsed = tryParseJson(entry.raw || '');
      if(parsed && typeof parsed === 'object'){
        var ts = parsed.ts || entry.timestamp || '';
        var levelText = String(parsed.level || lvl).toLowerCase();
        var eventText = parsed.event || parsed.type || 'event';
        var componentText = parsed.component || parsed.module || '';
        var message = parsed.message || (parsed.error && parsed.error.message) || parsed.hint || '';
        var meta = [];
        if(ts) meta.push(ts);
        if(componentText) meta.push(componentText);
        if(parsed.command) meta.push('cmd=' + parsed.command);
        if(parsed.tool_name) meta.push('tool=' + parsed.tool_name);
        if(parsed.duration_ms != null) meta.push('t=' + parsed.duration_ms + 'ms');
        return '<div class="log-entry level-' + h(levelText) + '">' +
          '<div class="log-entry-head">' + statusPill(levelText, lvl) + '<span class="pill info">' + h(String(eventText)) + '</span></div>' +
          (message ? '<div class="log-entry-msg">' + h(String(message)) + '</div>' : '') +
          (meta.length ? '<div class="log-entry-meta">' + h(meta.join(' · ')) + '</div>' : '') +
          '</div>';
      }
      return '<div class="log-entry level-' + h(lvl) + '"><div class="log-entry-head">' + statusPill(lvl) + '</div><div class="log-entry-msg">' + h(entry.raw || '') + '</div></div>';
    }).join('');
  }

  function renderLogsSummary(payload){
    if(!payload || payload.ok === false){
      return '';
    }
    var counts = payload.counts_by_level || {};
    return '<div class="ops-summary">' +
      renderSummaryCard('Source', payload.source_label || payload.source || '-') +
      renderSummaryCard('Scope', payload.scope === 'current' ? 'CURRENT' : 'ALL') +
      renderSummaryCard('Errors', counts.error != null ? counts.error : 0) +
      renderSummaryCard('Warn', counts.warn != null ? counts.warn : 0) +
      '</div>';
  }

  function logsQueryString(){
    var params = new URLSearchParams();
    params.set('source', String(logsState.source || 'mcp'));
    params.set('scope', String(logsState.scope || 'current'));
    params.set('lines', String(logsState.lines));
    if(logsState.level) params.set('level', logsState.level);
    if(logsState.query) params.set('q', logsState.query);
    return params.toString();
  }

  async function loadLogs(showSkeleton){
    if(showSkeleton) renderLogsSkeleton();
    var view = $('#logs-view');
    var nearBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 28;
    var data = await api('logs?' + logsQueryString());
    if(!data){
      $('#logs-meta').textContent = 'Failed to load logs';
      $('#logs-summary').innerHTML = '';
      return;
    }
    if(data.ok === false){
      $('#logs-meta').textContent = data.error || 'Log file unavailable';
      $('#logs-summary').innerHTML = '';
      view.innerHTML = '<div class="empty-state" style="padding:24px"><p>' + h(data.error || 'Log file unavailable') + '</p></div>';
      return;
    }

    var scopeLabel = data.scope === 'current' ? 'Current session' : 'All history';
    var latestText = data.latest_timestamp ? (' · Latest: ' + data.latest_timestamp) : '';
    var inScope = data.scoped_lines != null ? (' · In scope: ' + fmt(data.scoped_lines)) : '';
    $('#logs-note').textContent = data.scope === 'current'
      ? 'Showing only entries after this MCP server started at ' + (data.session_started_at || '-')
      : 'Showing full log history for ' + (data.source_label || data.source || 'logs') + '.';
    $('#logs-meta').textContent = (data.source_label || 'Log') + ' · Scope: ' + scopeLabel + ' · Path: ' + (data.path || '-') + ' · Returned: ' + fmt(data.lines_returned) + ' / Requested: ' + fmt(data.lines_requested) + inScope + latestText + (data.truncated ? ' · Truncated' : '');
    $('#logs-summary').innerHTML = renderLogsSummary(data);
    view.innerHTML = renderLogEntries(data.entries || []);
    if(nearBottom){ view.scrollTop = view.scrollHeight; }
  }

  async function loadConfig(){
    setConfigStatus('Loading...', '');
    var responses = await Promise.all([api('config-file'), api('config')]);
    var filePayload = responses[0];
    var effectivePayload = responses[1];

    if(!filePayload || filePayload.ok === false){
      $('#config-content').innerHTML = '<div class="data-empty">' + h((filePayload && filePayload.error) || 'Failed to load project config file.') + '</div>';
      setConfigStatus('Load failed', 'err');
      return;
    }
    if(!effectivePayload || dashboardPayloadHasError(effectivePayload)){
      $('#config-content').innerHTML = '<div class="data-empty">' + h((effectivePayload && effectivePayload.error) || 'Failed to load effective config.') + '</div>';
      setConfigStatus('Load failed', 'err');
      return;
    }

    configState.fileData = filePayload && filePayload.ok && typeof filePayload.data === 'object'
      ? cfgClone(filePayload.data)
      : {};
    configState.effectiveData = effectivePayload && typeof effectivePayload === 'object'
      ? cfgClone(effectivePayload)
      : {};
    configState.path = filePayload.path || null;
    configState.isLegacyPath = Boolean(filePayload.is_legacy_path);
    renderConfigEditor();
    $('#config-advanced-toggle').checked = configState.showAdvanced;
    setConfigStatus(
      'Loaded from ' + (configState.path || '.clawty/config.json') + (configState.isLegacyPath ? ' (legacy project config)' : ''),
      'ok'
    );
  }

  async function saveConfig(){
    var saveBtn = $('#config-save-btn');
    if(saveBtn) saveBtn.disabled = true;
    setConfigStatus('Saving...', '');
    var payload = collectConfigPayload();
    var result = await api('config-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: payload })
    });
    if(saveBtn) saveBtn.disabled = false;

    if(!result || result.ok === false){
      setConfigStatus((result && result.error) || 'Save failed', 'err');
      return;
    }
    configState.path = result.path || configState.path;
    configState.isLegacyPath = Boolean(result.is_legacy_path);
    configState.fileData = cfgClone(payload);
    var refreshedEffective = await api('config');
    var refreshFailed = !refreshedEffective || dashboardPayloadHasError(refreshedEffective);
    if(!refreshFailed && typeof refreshedEffective === 'object'){
      configState.effectiveData = cfgClone(refreshedEffective);
    }
    renderConfigEditor();
    if(refreshFailed){
      setConfigStatus(
        'Saved to ' + (configState.path || '.clawty/config.json') + '. Effective config refresh failed: ' + ((refreshedEffective && refreshedEffective.error) || 'reload failed') + '. Restart service to apply runtime changes.',
        ''
      );
      return;
    }
    setConfigStatus(
      'Saved to ' + (configState.path || '.clawty/config.json') + '. Restart service to apply runtime changes.',
      'ok'
    );
  }

  function resetConfigEditor(){
    renderConfigEditor();
    setConfigStatus('Reset to last loaded state', '');
  }

  async function loadTools(){
    var data = await api('tools');
    if(!data || !data.tools || !data.tools.length){
      $('#tools-content').innerHTML = '<div class="empty-state"><p>No tools registered</p></div>';
      return;
    }
    var grouped = {};
    data.tools.forEach(function(tool){
      var category = tool.category || 'general';
      if(!grouped[category]) grouped[category] = [];
      grouped[category].push(tool);
    });

    var html = '<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">' + data.tools.length + ' tools registered</div>';
    Object.entries(grouped).forEach(function(entry){
      var category = entry[0];
      var list = entry[1];
      html += '<div style="margin-bottom:16px"><div class="card-title" style="margin-bottom:8px">' + h(category.toUpperCase()) + '</div><div class="tool-list">';
      list.forEach(function(tool){
        html += '<div class="tool-item"><div class="tool-name">' + h(tool.name) + '</div>' + (tool.description ? '<div class="tool-desc">' + h(tool.description) + '</div>' : '') + '</div>';
      });
      html += '</div></div>';
    });
    $('#tools-content').innerHTML = html;
  }

  async function runDoctor(){
    if(opsState.doctorBusy) return;
    opsState.doctorBusy = true;
    var btn = $('#ops-doctor-btn');
    btn.disabled = true;
    btn.textContent = 'Running...';
    $('#ops-doctor-result').innerHTML = '<div class="data-empty">Running checks...</div>';
    var payload = await api('ops/doctor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    opsState.doctorResult = payload;
    $('#ops-doctor-result').innerHTML = renderDoctorResult(payload);
    btn.disabled = false;
    btn.textContent = 'Run Doctor';
    opsState.doctorBusy = false;
  }

  async function runReindex(){
    if(opsState.reindexBusy) return;
    if(!window.confirm('Rebuild code/syntax/semantic indexes now?')) return;
    opsState.reindexBusy = true;
    var btn = $('#ops-reindex-btn');
    btn.disabled = true;
    btn.textContent = 'Rebuilding...';
    $('#ops-reindex-result').innerHTML = '<div class="data-empty">Running reindex pipeline...</div>';
    var payload = await api('ops/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    opsState.reindexResult = payload;
    $('#ops-reindex-result').innerHTML = renderReindexResult(payload);
    btn.disabled = false;
    btn.textContent = 'Rebuild Indexes';
    opsState.reindexBusy = false;
  }

  async function runMemorySearch(){
    if(opsState.memoryBusy) return;
    var query = ($('#ops-memory-query').value || '').trim();
    if(!query){
      $('#ops-memory-result').innerHTML = '<div class="data-empty">Please enter a search query.</div>';
      return;
    }
    var topK = Number($('#ops-memory-topk').value || 5);
    opsState.memoryBusy = true;
    var btn = $('#ops-memory-btn');
    btn.disabled = true;
    btn.textContent = 'Searching...';
    $('#ops-memory-result').innerHTML = '<div class="data-empty">Running memory search...</div>';
    var payload = await api('ops/memory-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, top_k: topK })
    });
    opsState.memoryResult = payload;
    $('#ops-memory-result').innerHTML = renderMemorySearchResult(payload);
    btn.disabled = false;
    btn.textContent = 'Search';
    opsState.memoryBusy = false;
  }

  function loadOperations(){
    if(opsState.doctorResult){ $('#ops-doctor-result').innerHTML = renderDoctorResult(opsState.doctorResult); }
    if(opsState.reindexResult){ $('#ops-reindex-result').innerHTML = renderReindexResult(opsState.reindexResult); }
    if(opsState.memoryResult){ $('#ops-memory-result').innerHTML = renderMemorySearchResult(opsState.memoryResult); }
  }

  var loaders = {
    overview: loadOverview,
    indexes: loadIndexes,
    memory: loadMemory,
    metrics: loadMetrics,
    logs: loadLogs,
    operations: loadOperations,
    config: loadConfig,
    tools: loadTools
  };

  function updateUptime(){
    if(!uptimeBaseMs){
      $('#uptime-value').textContent = '-';
      return;
    }
    var elapsed = Math.max(0, Date.now() - uptimeBaseMs);
    $('#uptime-value').textContent = fmtUptime(elapsed);
    $('#uptime-badge').style.display = '';
  }

  async function loadSection(section, showSkeleton){
    var loader = loaders[section];
    if(!loader) return;
    if(loadingSection[section]) return;
    startSectionLoading(section);
    try {
      await loader(showSkeleton);
    } catch (error) {
      console.error('Load error:', section, error);
    } finally {
      finishSectionLoading(section);
    }
  }

  function bindNavigation(){
    $$('.nav-item').forEach(function(btn){
      btn.addEventListener('click', function(){
        navigateTo(btn.dataset.section, { updateHash: true });
      });
    });

    window.addEventListener('hashchange', function(){
      navigateTo(parseSectionHash(location.hash), { updateHash: false });
    });
  }

  function bindTopbar(){
    $('#refresh-btn').addEventListener('click', function(){
      loadSection(currentSection, true);
    });
    $('#menu-btn').addEventListener('click', function(){
      var root = $('#layout-root');
      root.classList.toggle('sidebar-open');
    });
    $('#sidebar-backdrop').addEventListener('click', closeSidebar);
  }

  function bindLogsActions(){
    $('#logs-refresh').addEventListener('click', function(){ loadLogs(true); });
    $('#logs-clear').addEventListener('click', function(){
      logsState.source = 'mcp';
      logsState.scope = 'current';
      logsState.level = '';
      logsState.query = '';
      logsState.lines = 200;
      $('#logs-source').value = 'mcp';
      $('#logs-scope').value = 'current';
      $('#logs-level').value = '';
      $('#logs-query').value = '';
      $('#logs-lines').value = '200';
      loadLogs(true);
    });
    $('#logs-bottom').addEventListener('click', function(){
      var view = $('#logs-view');
      view.scrollTop = view.scrollHeight;
    });

    $('#logs-level').addEventListener('change', function(){
      logsState.level = String(this.value || '');
      loadLogs(true);
    });
    $('#logs-source').addEventListener('change', function(){
      logsState.source = String(this.value || 'mcp');
      loadLogs(true);
    });
    $('#logs-scope').addEventListener('change', function(){
      logsState.scope = String(this.value || 'current');
      loadLogs(true);
    });
    $('#logs-lines').addEventListener('change', function(){
      logsState.lines = Number(this.value || 200);
      loadLogs(true);
    });
    $('#logs-query').addEventListener('keydown', function(event){
      if(event.key === 'Enter'){
        logsState.query = String(this.value || '').trim();
        loadLogs(true);
      }
    });
    $('#logs-query').addEventListener('blur', function(){
      logsState.query = String(this.value || '').trim();
    });
  }

  function bindMetricsActions(){
    $$('.metrics-window-btn').forEach(function(button){
      button.addEventListener('click', function(){
        var nextHours = Number(button.dataset.hours || 24);
        if(nextHours === metricsState.windowHours) return;
        metricsState.windowHours = nextHours;
        setMetricsWindowActive();
        loadMetrics(true);
      });
    });
    setMetricsWindowActive();
  }

  function bindConfigActions(){
    $('#config-save-btn').addEventListener('click', function(){
      saveConfig().catch(function(error){
        console.error('Config save failed:', error);
        setConfigStatus(error && error.message ? error.message : 'Save failed', 'err');
      });
    });
    $('#config-reset-btn').addEventListener('click', function(){
      resetConfigEditor();
    });
    $('#config-reload-btn').addEventListener('click', function(){
      loadConfig().catch(function(error){
        console.error('Config reload failed:', error);
        setConfigStatus(error && error.message ? error.message : 'Reload failed', 'err');
      });
    });
    $('#config-advanced-toggle').addEventListener('change', function(){
      configState.showAdvanced = Boolean(this.checked);
      renderConfigEditor();
      setConfigStatus(configState.showAdvanced ? 'Showing advanced fields' : 'Showing essential fields', '');
    });
  }

  function bindOperationActions(){
    $('#ops-doctor-btn').addEventListener('click', runDoctor);
    $('#ops-reindex-btn').addEventListener('click', runReindex);
    $('#ops-memory-btn').addEventListener('click', runMemorySearch);
    $('#ops-memory-query').addEventListener('keydown', function(event){
      if(event.key === 'Enter'){ runMemorySearch(); }
    });
  }

  function isInputTarget(target){
    if(!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return target.isContentEditable === true;
  }

  function bindKeyboardShortcuts(){
    var help = $('#kbd-help');
    window.addEventListener('keydown', function(event){
      if(event.key === 'Escape'){
        help.classList.remove('open');
        closeSidebar();
        return;
      }
      if(isInputTarget(event.target)) return;

      if(event.key === '?'){
        event.preventDefault();
        help.classList.toggle('open');
        return;
      }
      if(event.key === 'r' || event.key === 'R'){
        event.preventDefault();
        loadSection(currentSection, true);
        return;
      }
      if(/^[1-8]$/.test(event.key)){
        event.preventDefault();
        var index = Number(event.key) - 1;
        var section = SECTIONS[index] || 'overview';
        navigateTo(section, { updateHash: true });
      }
    });
    help.addEventListener('click', function(event){
      if(event.target === help) help.classList.remove('open');
    });
  }

  function startAutoRefresh(){
    if(refreshTicker) clearInterval(refreshTicker);
    refreshTicker = setInterval(function(){
      if(REFRESHABLE_SECTIONS.has(currentSection)){
        loadSection(currentSection, false);
      }
    }, 15000);
  }

  bindNavigation();
  bindTopbar();
  bindMetricsActions();
  bindLogsActions();
  bindConfigActions();
  bindOperationActions();
  bindKeyboardShortcuts();
  startAutoRefresh();

  navigateTo(parseSectionHash(location.hash), { updateHash: true, force: true });
  setInterval(updateUptime, 1000);
})();
</script>
</body>
</html>`;
}
