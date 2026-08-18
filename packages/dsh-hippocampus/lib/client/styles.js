// 样式：一次性注入到页面 <head>（带插件标记，供 HMR 记账）
const css = `
.hp-root{height:100%;max-height:calc(100vh - 140px);min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px;box-sizing:border-box;overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.hp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
.hp-stats{display:flex;align-items:center;gap:16px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:6px 14px}
.hp-stat{display:flex;flex-direction:column;line-height:1.25}
.hp-stat-v{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#eef4fb)}
.hp-stat-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa4b2)}
.hp-search{flex:1;min-width:140px;max-width:260px;height:32px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:13px;outline:none}
.hp-search:focus{border-color:#3d6df2}
.hp-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.hp-chip{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;cursor:pointer}
.hp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-chip[data-on]{background:#1f3a8a33;border-color:#3d6df2;color:#7ea6ff}
.hp-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;cursor:pointer;white-space:nowrap}
.hp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-btn-primary{border-color:#3d6df2;color:#8ab4ff;background:#1f3a8a33}
.hp-btn-danger{color:#ff7b72}
.hp-body{display:flex;gap:10px;flex:1;min-height:0}
.hp-canvas-wrap{flex:1;min-width:280px;position:relative;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,#070b12)}
.hp-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair}
.hp-hints{position:absolute;left:10px;bottom:8px;display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b96a5);pointer-events:none;user-select:none;font-family:ui-sans-serif,system-ui,sans-serif}
.hp-empty-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary,#5b6472);font-size:12px;pointer-events:none;text-align:center;padding:0 30px}
.hp-list{width:min(400px,42%);flex:none;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
/* v5.3：分类抽屉盒（按种类分组） */
.hp-group-head{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:8px;cursor:pointer;user-select:none;background:transparent;transition:background .12s}
.hp-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-group-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}
.hp-group-name{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bfcc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-group-count{font-size:10px;color:#7d8590;background:#1c2432;border-radius:999px;padding:0 7px;line-height:16px;flex:none;font-family:ui-monospace,Menlo,monospace}
.hp-group-arrow{font-size:10px;color:#7d8590;flex:none}
/* v5.3：全屏专注模式 —— 隐藏左右/顶部工具栏，3D 视图占满 */
.hp-focus .hp-header,.hp-focus .hp-left,.hp-focus .hp-list{display:none}
.hp-focus{max-height:none;padding:8px;gap:0}
.hp-focus .hp-body{flex:1}
.hp-focus .hp-canvas-wrap{min-width:0;border-radius:12px}
.hp-exit-focus{position:absolute;top:12px;right:12px;z-index:20;height:30px;padding:0 14px;border:1px solid #3d6df2;border-radius:8px;background:rgba(13,20,32,.88);color:#8ab4ff;font-size:12px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);backdrop-filter:blur(4px)}
.hp-exit-focus:hover{background:#1f3a8a55}
.hp-card{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .12s, transform .12s, box-shadow .12s}
.hp-card:hover{border-color:#3d6df2aa;transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.22)}
.hp-card[data-selected]{border-color:#3d6df2;box-shadow:0 0 0 1px #3d6df255}
.hp-card.hp-due{border-color:#ffd47988}
.hp-due-badge{font-size:11px;flex:none}
.hp-card-top{display:flex;align-items:center;gap:8px}
.hp-badge{font-size:11px;padding:1px 9px;border-radius:999px;flex:none;color:#0b0e14;font-weight:600}
.hp-card-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#eef4fb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-card-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa4b2);flex:none}
.hp-strength{height:3px;border-radius:2px;background:#1c2432;margin:7px 0 6px;overflow:hidden}
.hp-strength i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#3d6df2,#4fc3f7)}
.hp-card-content{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#b6bfcc);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.hp-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.hp-tag{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:1px 7px;border-radius:999px}
.hp-card-actions{display:flex;gap:6px;margin-top:8px}
.hp-mini{font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);background:transparent;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:6px;padding:3px 9px;cursor:pointer}
.hp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-modal{position:fixed;inset:0;background:rgba(2,6,12,.6);display:flex;align-items:center;justify-content:center;z-index:1200;backdrop-filter:blur(2px)}
.hp-modal-box{width:min(560px,92vw);max-height:86vh;overflow-y:auto;background:var(--dsw-alias-bg-base,#0b1018);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.hp-modal-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);margin-bottom:14px}
.hp-field{margin-bottom:12px}
.hp-field label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);margin-bottom:5px}
.hp-input{width:100%;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:13px;outline:none}
.hp-input:focus{border-color:#3d6df2}
.hp-textarea{width:100%;box-sizing:border-box;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:8px 10px;font-size:13px;line-height:1.55;outline:none;font-family:inherit}
.hp-textarea:focus{border-color:#3d6df2}
.hp-row{display:flex;gap:10px}
.hp-row .hp-field{flex:1}
.hp-range{width:100%;accent-color:#3d6df2}
.hp-range-val{font-size:11px;color:#7ea6ff;margin-left:6px}
.hp-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.hp-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);margin-top:10px;line-height:1.6}
.hp-history{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);margin-top:6px}
.hp-history div{display:flex;gap:6px}
.hp-toast{position:fixed;right:18px;bottom:18px;background:#123;border:1px solid #3d6df2;color:#8ab4ff;padding:8px 14px;border-radius:10px;font-size:12px;z-index:1300;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.hp-error{color:#ff7b72;font-size:12px;padding:8px 0}
.hp-loading{color:#5b6472;font-size:12px;padding:20px 0;text-align:center}
.hp-left{width:208px;flex:none;display:flex;flex-direction:column;gap:10px;min-width:188px;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:2px;scrollbar-width:thin;scrollbar-color:#2a3550 transparent}
.hp-left::-webkit-scrollbar{width:6px}
.hp-left::-webkit-scrollbar-thumb{background:#2a3550;border-radius:3px}
.hp-collapse{cursor:pointer;user-select:none;justify-content:space-between}
.hp-collapse:hover{color:#b6bfcc}
.hp-collapse-arrow{font-size:10px;color:#7d8590;margin-left:auto;flex:none}
.hp-panel{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px}
.hp-panel-title{font-size:11px;letter-spacing:.08em;color:#7d8590;text-transform:uppercase;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace;display:flex;align-items:center;gap:6px}
.hp-panel-title i{width:6px;height:6px;border-radius:50%;display:inline-block;box-shadow:0 0 6px currentColor}
.hp-legend{display:flex;flex-direction:column;gap:5px}
.hp-legend-row{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc)}
.hp-legend-dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 7px currentColor}
.hp-legend-hint{display:flex;align-items:center;gap:7px;font-size:11px;color:#7d8590;margin-top:3px}
.hp-legend-size{width:14px;height:3px;border-radius:2px;flex:none;background:linear-gradient(90deg,#5b6472,#4fc3f7)}
.hp-legend-line{width:16px;height:3px;border-radius:2px;flex:none;background:currentColor;box-shadow:0 0 5px currentColor}
.hp-tag-cloud{display:flex;flex-wrap:wrap;gap:5px}
.hp-tag-chip{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:2px 8px;border-radius:999px;cursor:pointer;user-select:none;border:1px solid transparent}
.hp-tag-chip:hover{background:#1f3a8a55}
.hp-tag-chip[data-on]{background:#ffd47922;border-color:#ffd479;color:#ffd479}
.hp-quality{font-size:10px;padding:0 6px;border-radius:999px;flex:none;line-height:16px}
.hp-quality[data-q=good]{color:#3fb950;background:#2ea04322}
.hp-quality[data-q=mid]{color:#d29922;background:#9e6a031f}
.hp-quality[data-q=low]{color:#ff7b72;background:#f851491f}
.hp-ctrl-status{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;background:#2ea04333;color:#3fb950;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-status[data-off]{background:#f8514933;color:#ff7b72}
.hp-ctrl-row{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary,#b6bfcc);margin-bottom:4px}
.hp-ctrl-row b{color:var(--dsw-alias-label-primary,#eef4fb);font-weight:600;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-btns{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.hp-ctrl-btns .hp-btn{width:100%}
.hp-tut-toggle{width:100%;height:26px;margin-top:2px;border:1px dashed #3d6df288;border-radius:8px;background:#1f3a8a22;color:#8ab4ff;font-size:12px;cursor:pointer}
.hp-tut-toggle:hover{background:#1f3a8a44}
.hp-tut{font-size:12px;line-height:1.7;color:#aab4c2;padding:8px 10px 9px;margin-top:2px;background:rgba(10,16,28,.6);border:1px solid #1c2432;border-radius:8px}
.hp-tut-item{margin-bottom:6px}
.hp-tut-item:last-child{margin-bottom:0}
.hp-tut-item b{color:#8ab4ff;font-weight:700}
.hp-tut-k{color:#81c784}
.hp-tut-e{color:#ba68c8}
.hp-statusbar{position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;gap:14px;padding:0 12px;background:color-mix(in srgb, var(--dsw-alias-bg-elevated,#0e1420) 88%, transparent);backdrop-filter:blur(3px);border-top:1px solid var(--dsw-alias-border-l2,#1c2432);font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa4b2);pointer-events:none;z-index:3;overflow:hidden;white-space:nowrap}
.hp-statusbar b{color:var(--dsw-alias-label-primary,#e6f1ff);font-weight:600}
.hp-statusbar .hp-sel{display:flex;gap:14px;min-width:0;overflow:hidden}
.hp-statusbar .hp-sel span{overflow:hidden;text-overflow:ellipsis}
.hp-status-right{margin-left:auto;display:flex;gap:14px;color:#7d8590;flex:none}
.hp-status-right b{color:#9aa4b2}
.hp-layer-label{position:absolute;top:8px;font-size:9px;letter-spacing:.06em;color:rgba(120,140,190,.38);pointer-events:none;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;transform:translateX(-50%)}
.hp-layer-arrow{position:absolute;top:22px;font-size:8px;color:rgba(120,140,190,.22);pointer-events:none;font-family:ui-monospace,Menlo,monospace;transform:translateX(-50%)}
.hp-degree{font-size:10px;color:#7ea6ff;background:#1f3a8a33;border-radius:999px;padding:1px 7px;flex:none}
.hp-age{font-size:10px;color:#7d8590;flex:none}
.hp-review{border-color:#ffd479;color:#ffd479}
.hp-review[data-on]{background:#ffd47922;border-color:#ffd479}
.hp-inject-log,.hp-evolog-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow-y:auto}
.hp-log-row{display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;font-size:12px}
.hp-log-time{color:#7d8590;font-family:ui-monospace,Menlo,monospace;flex:none}
.hp-log-mode{font-size:10px;padding:1px 7px;border-radius:999px;flex:none;background:#1f3a8a33;color:#7ea6ff}
.hp-log-mode[data-mode=tool]{background:#81c78422;color:#81c784}
.hp-log-mode[data-mode=refresh]{background:#ffd47922;color:#ffd479}
.hp-log-count{color:#b6bfcc;flex:none}
.hp-log-chars{color:#7d8590;flex:none}
.hp-log-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3}
.hp-link-list{display:flex;flex-wrap:wrap;gap:5px}
.hp-link-item{font-size:11px;color:#7ea6ff;background:#1f3a8a33;padding:2px 8px;border-radius:999px;cursor:pointer;user-select:none}
.hp-link-item:hover{background:#1f3a8a55}
.hp-evolog-row{padding:7px 9px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px}
.hp-evolog-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.hp-evolog-epoch{font-size:12px;font-weight:600;color:#c792ea;font-family:ui-monospace,Menlo,monospace}
.hp-evolog-time{font-size:11px;color:#7d8590;font-family:ui-monospace,Menlo,monospace}
.hp-evolog-stats{display:flex;gap:12px;font-size:11px;color:#b6bfcc}
.hp-evolog-stats span{color:#7ea6ff}
/* v5.2：头部「工具」下拉 */
.hp-tools{position:relative;flex:none}
.hp-tools-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:168px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:5px;display:flex;flex-direction:column;gap:2px;z-index:60;box-shadow:0 12px 36px rgba(0,0,0,.45);backdrop-filter:blur(4px)}
.hp-tools-item{height:30px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#b6bfcc);font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.hp-tools-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#e6edf3)}
.hp-tools-item:disabled{opacity:.4;cursor:not-allowed}
/* v5.2：滚动条与过渡微调 */
.hp-list::-webkit-scrollbar{width:7px}
.hp-list::-webkit-scrollbar-thumb{background:#2a3550;border-radius:4px}
.hp-list::-webkit-scrollbar-thumb:hover{background:#35416a}
.hp-btn{transition:border-color .12s, background .12s, color .12s}
.hp-toast{animation:hp-toast-in .18s ease-out}
@keyframes hp-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
`;

function injectStyles() {
	if (typeof document === "undefined" || document.querySelector("style[data-plugin-css=\"@local/dsh-hippocampus/MemoryView\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "@local/dsh-hippocampus";
	tag.dataset.pluginCss = "@local/dsh-hippocampus/MemoryView";
	tag.textContent = css;
	document.head.appendChild(tag);
}

exports.injectStyles = injectStyles;
