// 海马体记忆 Agent —— 浏览器半边（client half）v3（Wazome Memory Network v3.1）
// 职责：
//   1. 在「对话 / 轨迹」之后注册「记忆」标签页（conversation.view 插槽，order 20）
//   2. 神经元网络可视化（Wazome Memory Network v3.1 风格深化）：
//      - 连接为宿主端持久化「突触」（links 表）真实权重，向量相似度仅兜底
//      - 搜索驱动激活：输入搜索词时相关节点能量提升、高亮，其余节点变暗
//      - 自学习 / 自演化面板展示真实数据（神经元/突触/适应度/代际/已修剪），
//        按钮调用宿主端真实演化（合并近重复）与修剪（归档弱且久的记忆）
//      - 分层纵向图层（按记忆种类）、扩散激活动画、图例、节点检视状态栏
//   3. 记忆分支列表：每条分支可手动编辑、修正、归档、删除（显示连接数/年龄）
//   4. 通过 remote.namespaces 数据通道与宿主端交互
window.__ModuleLoader__.load({
	id: "@local/dsh-hippocampus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useRef, useMemo, useCallback } = React;
		const { createElement: h, Fragment } = React;

		// ------------------------------------------------------------------
		// 词典
		// ------------------------------------------------------------------
		const NS = "hippocampus";
		const zh = {
			"view.memory": "记忆",
			"tab.hint": "海马体记忆",
			"scope.global": "全局记忆",
			"scope.project": "项目记忆",
			"scope.noProject": "未检测到当前项目（工作区），已回退全局记忆",
			"stats.neurons": "神经元",
			"stats.connections": "突触",
			"stats.activation": "激活强度",
			"stats.epoch": "Epoch",
			"stats.fitness": "适应度",
			"search.placeholder": "搜索记忆…（驱动网络激活）",
			"filter.all": "全部",
			"kind.preference": "偏好",
			"kind.communication": "交流方式",
			"kind.workstate": "工作状态",
			"kind.insight": "洞察",
			"kind.other": "其他",
			"kind.workdir": "工作区目录",
			"btn.new": "＋ 新建分支",
			"btn.refresh": "刷新",
			"btn.edit": "编辑",
			"btn.archive": "归档",
			"btn.restore": "恢复",
			"btn.delete": "删除",
			"btn.save": "保存",
			"btn.cancel": "取消",
			"btn.evolve": "演化 F",
			"btn.prune": "修剪 E",
			"btn.anim": "动画 空格",
			"hint.reset": "双击 = 重置视图",
			"hint.clear": "右键 = 清除选择",
			"hint.drag": "拖拽 = 旋转球体",
			"empty.title": "海马体还没有记忆",
			"empty.body": "点击「新建分支」手动写入，或让我在任务中用 memory_write 记录你的偏好、交流方式与工作状态。项目记忆按项目文件夹隔离，随项目推进自动沉淀。",
			"loading": "记忆读取中…",
			"error": "记忆服务不可用：",
			"edit.title": "编辑记忆分支",
			"new.title": "新建记忆分支",
			"field.title": "标题",
			"field.kind": "种类",
			"field.tags": "标签（逗号分隔，留空自动生成）",
			"field.content": "内容",
			"field.strength": "强度",
			"field.status": "状态",
			"status.active": "活跃",
			"status.archived": "已归档",
			"history": "修正历史",
			"saved": "已保存 ✓",
			"deleted": "已删除",
			"archived": "已归档",
			"restored": "已恢复",
			"confirm.delete": "确定彻底删除这条记忆？此操作不可恢复。",
			"source.agent": "Agent",
			"source.user": "用户",
			"source.system": "系统",
			"strength.high": "牢固",
			"strength.mid": "稳定",
			"strength.low": "易忘",
			"legend.title": "图例",
			"legend.kind": "种类",
			"legend.activation": "激活强度",
			"legend.strong": "牢固记忆",
			"legend.weak": "易忘记忆",
			"legend.links": "突触连接",
			"ctrl.learning": "自学习",
			"ctrl.evolution": "自演化",
			"ctrl.learning.en": "SELF-LEARNING",
			"ctrl.evolution.en": "SELF-EVOLUTION",
			"ctrl.neurons": "神经元",
			"ctrl.synapses": "突触",
			"ctrl.connections": "连接",
			"ctrl.fitness": "适应度",
			"ctrl.pruned": "已修剪",
			"ctrl.merged": "已合并",
			"ctrl.gen": "代际",
			"ctrl.active": "ACTIVE",
			"ctrl.paused": "PAUSED",
			"ctrl.toggle": "开关学习 空格",
			"ctrl.evolve": "演化：合并近重复",
			"ctrl.prune": "修剪弱连接",
			"ctrl.pruneWeak": "修剪弱记忆",
			"status.selected": "选中",
			"status.kind": "种类",
			"status.activation": "激活",
			"status.degree": "连接",
			"status.age": "年龄",
			"status.none": "未选中节点 — 点击节点检视",
			"status.fps": "FPS",
			"status.gen": "Gen",
			"status.lr": "LR",
			"status.fit": "Fit",
			"evolved": "演化完成",
			"prunedDone": "修剪完成",
			"fed": "轨迹喂养完成",
			"btn.feed": "喂养轨迹"
		};
		const en = {
			"view.memory": "Memory",
			"scope.global": "Global",
			"scope.project": "Project",
			"stats.neurons": "Neurons",
			"stats.connections": "Links",
			"stats.activation": "Activation",
			"stats.epoch": "Epoch",
			"stats.fitness": "Fitness",
			"search.placeholder": "Search memory…",
			"filter.all": "All",
			"btn.new": "+ New branch",
			"btn.edit": "Edit",
			"btn.save": "Save",
			"btn.cancel": "Cancel",
			"empty.title": "No memory yet",
			"loading": "Loading…"
		};

		// ------------------------------------------------------------------
		// Remote 契约（与宿主端 HippocampusService 的 src 方法一一对应）
		// ------------------------------------------------------------------
		const PASSTHROUGH = { parse: (v) => v };
		const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: PASSTHROUGH });
		const P = (name) => ({ name, wire: name, source: "json", codec: codec("@local/dsh-hippocampus#hippocampus/" + name) });
		const D = (method, params, result) => ({
			id: "@local/dsh-hippocampus#hippocampus/" + method,
			service: "hippocampus",
			namespace: "hippocampus",
			method,
			invocation: { kind: "direct" },
			parameters: params,
			result: { mode: "strict", typeSymbol: "@local/dsh-hippocampus#hippocampus/" + method + ":result", schema: PASSTHROUGH },
			sourceLocation: { file: "packages/hippocampus/src/index.ts", line: 1, column: 1 }
		});
		const CONTRIBUTION = {
			package: "@local/dsh-hippocampus",
			descriptors: [
				D("list", [P("request")], "list"),
				D("get", [P("request")], "get"),
				D("create", [P("request")], "create"),
				D("update", [P("request")], "update"),
				D("forget", [P("request")], "forget"),
				D("search", [P("request")], "search"),
				D("graph", [P("request")], "graph"),
				D("stats", [P("request")], "stats"),
				D("evolve", [P("request")], "evolve"),
				D("prune", [P("request")], "prune"),
				D("context", [P("request")], "context"),
				D("feed", [P("request")], "feed"),
				D("optimize", [P("request")], "optimize"),
				D("resolveProject", [P("request")], "resolveProject"),
				D("archiveWorkdir", [P("request")], "archiveWorkdir"),
				D("reportWork", [P("request")], "reportWork")
			].map((d) => ({ ...d, result: d.result }))
		};

		function remoteCall(ctx, method, args) {
			const remote = ctx.get("remote");
			const ns = remote.namespaces?.get("hippocampus")?.service;
			const fn = ns?.[method];
			if (typeof fn !== "function") {
				return Promise.resolve({ ok: false, error: { code: "not-mounted", message: "hippocampus Remote 未挂载" } });
			}
			return args === void 0 ? fn() : fn(args);
		}

		// ------------------------------------------------------------------
		// 样式
		// ------------------------------------------------------------------
		const KIND_COLORS = {
			preference: "#4fc3f7",
			communication: "#ffb74d",
			workstate: "#81c784",
			insight: "#ba68c8",
			other: "#90a4ae",
			workdir: "#ffd479"
		};
		const css = `
.hp-root{height:100%;max-height:calc(100vh - 140px);min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px 14px;box-sizing:border-box;overflow:hidden}
.hp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
.hp-stats{display:flex;align-items:center;gap:16px;background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:6px 14px}
.hp-stat{display:flex;flex-direction:column;line-height:1.25}
.hp-stat-v{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3)}
.hp-stat-k{font-size:10px;color:var(--dsw-alias-label-tertiary,#7d8590)}
.hp-search{flex:1;min-width:140px;max-width:260px;height:30px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:12px;outline:none}
.hp-search:focus{border-color:#3d6df2}
.hp-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.hp-chip{height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#a5adba);font-size:11px;cursor:pointer}
.hp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-chip[data-on]{background:#1f3a8a33;border-color:#3d6df2;color:#7ea6ff}
.hp-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-secondary,#a5adba);font-size:11px;cursor:pointer;white-space:nowrap}
.hp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-btn-primary{border-color:#3d6df2;color:#8ab4ff;background:#1f3a8a33}
.hp-btn-danger{color:#ff7b72}
.hp-body{display:flex;gap:10px;flex:1;min-height:0}
.hp-canvas-wrap{flex:1;min-width:280px;position:relative;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:12px;overflow:hidden;background:#070b12}
.hp-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair}
.hp-hints{position:absolute;left:10px;bottom:8px;display:flex;gap:10px;font-size:10px;color:#5b6472;pointer-events:none;user-select:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hp-empty-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#5b6472;font-size:12px;pointer-events:none;text-align:center;padding:0 30px}
.hp-list{width:min(400px,42%);flex:none;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}
.hp-card{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .12s}
.hp-card:hover{border-color:#3d6df2aa}
.hp-card[data-selected]{border-color:#3d6df2;box-shadow:0 0 0 1px #3d6df255}
.hp-card-top{display:flex;align-items:center;gap:8px}
.hp-badge{font-size:10px;padding:1px 8px;border-radius:999px;flex:none;color:#0b0e14}
.hp-card-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-card-meta{font-size:10px;color:var(--dsw-alias-label-tertiary,#7d8590);flex:none}
.hp-strength{height:3px;border-radius:2px;background:#1c2432;margin:7px 0 6px;overflow:hidden}
.hp-strength i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#3d6df2,#4fc3f7)}
.hp-card-content{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#a5adba);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.hp-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.hp-tag{font-size:10px;color:#7ea6ff;background:#1f3a8a33;padding:1px 7px;border-radius:999px}
.hp-card-actions{display:flex;gap:6px;margin-top:8px}
.hp-mini{font-size:11px;color:var(--dsw-alias-label-secondary,#a5adba);background:transparent;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:6px;padding:2px 8px;cursor:pointer}
.hp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-modal{position:fixed;inset:0;background:rgba(2,6,12,.6);display:flex;align-items:center;justify-content:center;z-index:1200;backdrop-filter:blur(2px)}
.hp-modal-box{width:min(560px,92vw);max-height:86vh;overflow-y:auto;background:var(--dsw-alias-bg-base,#0b1018);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.hp-modal-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);margin-bottom:14px}
.hp-field{margin-bottom:12px}
.hp-field label{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,#a5adba);margin-bottom:5px}
.hp-input{width:100%;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:0 10px;font-size:13px;outline:none}
.hp-input:focus{border-color:#3d6df2}
.hp-textarea{width:100%;box-sizing:border-box;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:8px;background:var(--dsw-alias-bg-elevated,#0e1420);color:var(--dsw-alias-label-primary,#e6edf3);padding:8px 10px;font-size:13px;line-height:1.55;outline:none;font-family:inherit}
.hp-textarea:focus{border-color:#3d6df2}
.hp-row{display:flex;gap:10px}
.hp-row .hp-field{flex:1}
.hp-range{width:100%;accent-color:#3d6df2}
.hp-range-val{font-size:11px;color:#7ea6ff;margin-left:6px}
.hp-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.hp-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d8590);margin-top:10px;line-height:1.6}
.hp-history{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d8590);margin-top:6px}
.hp-history div{display:flex;gap:6px}
.hp-toast{position:fixed;right:18px;bottom:18px;background:#123;border:1px solid #3d6df2;color:#8ab4ff;padding:8px 14px;border-radius:10px;font-size:12px;z-index:1300;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.hp-error{color:#ff7b72;font-size:12px;padding:8px 0}
.hp-loading{color:#5b6472;font-size:12px;padding:20px 0;text-align:center}
.hp-left{width:188px;flex:none;display:flex;flex-direction:column;gap:10px;min-width:170px}
.hp-panel{background:var(--dsw-alias-bg-elevated,#0e1420);border:1px solid var(--dsw-alias-border-l2,#232b3a);border-radius:10px;padding:10px 12px}
.hp-panel-title{font-size:10px;letter-spacing:.1em;color:#5b6472;text-transform:uppercase;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace;display:flex;align-items:center;gap:6px}
.hp-panel-title i{width:6px;height:6px;border-radius:50%;display:inline-block;box-shadow:0 0 6px currentColor}
.hp-legend{display:flex;flex-direction:column;gap:5px}
.hp-legend-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary,#a5adba)}
.hp-legend-dot{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 7px currentColor}
.hp-legend-hint{display:flex;align-items:center;gap:7px;font-size:10px;color:#5b6472;margin-top:3px}
.hp-legend-size{width:14px;height:3px;border-radius:2px;flex:none;background:linear-gradient(90deg,#5b6472,#4fc3f7)}
.hp-ctrl-status{display:inline-block;font-size:9px;padding:1px 7px;border-radius:999px;background:#2ea04333;color:#3fb950;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-status[data-off]{background:#f8514933;color:#ff7b72}
.hp-ctrl-row{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary,#a5adba);margin-bottom:4px}
.hp-ctrl-row b{color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600;font-family:ui-monospace,Menlo,monospace}
.hp-ctrl-btns{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.hp-ctrl-btns .hp-btn{width:100%}
.hp-statusbar{position:absolute;left:0;right:0;bottom:0;height:26px;display:flex;align-items:center;gap:14px;padding:0 12px;background:rgba(6,10,18,.8);backdrop-filter:blur(3px);border-top:1px solid #1c2432;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#8b96a5;pointer-events:none;z-index:3;overflow:hidden;white-space:nowrap}
.hp-statusbar b{color:#dbe7ff;font-weight:600}
.hp-statusbar .hp-sel{display:flex;gap:14px;min-width:0;overflow:hidden}
.hp-statusbar .hp-sel span{overflow:hidden;text-overflow:ellipsis}
.hp-status-right{margin-left:auto;display:flex;gap:14px;color:#5b6472;flex:none}
.hp-status-right b{color:#8b96a5}
.hp-layer-label{position:absolute;top:8px;font-size:9px;letter-spacing:.06em;color:rgba(120,140,190,.38);pointer-events:none;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;transform:translateX(-50%)}
.hp-layer-arrow{position:absolute;top:22px;font-size:8px;color:rgba(120,140,190,.22);pointer-events:none;font-family:ui-monospace,Menlo,monospace;transform:translateX(-50%)}
.hp-degree{font-size:9px;color:#7ea6ff;background:#1f3a8a33;border-radius:999px;padding:1px 6px;flex:none}
.hp-age{font-size:9px;color:#5b6472;flex:none}
`;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"@local/dsh-hippocampus/MemoryView\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-hippocampus";
			tag.dataset.pluginCss = "@local/dsh-hippocampus/MemoryView";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// 神经元网络可视化（Wazome Memory Network v3.1 风格）
		// ------------------------------------------------------------------

		const KINDS = ["preference", "communication", "workstate", "insight", "other"];

		function hashOf(str) {
			let x = 0;
			for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
			return x / 4294967296;
		}

		// v3.3 3D 球形神经网络：宿主端给出三维理想坐标 x0/y0/z0（归一化 -1..1），
		// 客户端做 3D 旋转 + 透视投影渲染（无物理布局，仅呼吸动画）
		function buildSim(graph, prev) {
			const nodes = graph.nodes.map((node) => {
				const old = prev?.nodes?.find((p) => p.id === node.id);
				return {
					id: node.id,
					title: node.title,
					kind: node.kind,
					type: node.type ?? "leaf",
					workdir: node.workdir ?? null,
					strength: node.strength,
					degree: node.degree ?? 0,
					ageDays: node.ageDays ?? 0,
					x0: node.x0 ?? 0,
					y0: node.y0 ?? 0,
					z0: node.z0 ?? 0,
					x: old?.x ?? node.x0 ?? 0,
					y: old?.y ?? node.y0 ?? 0,
					z: old?.z ?? node.z0 ?? 0,
					phase: hashOf("ph" + node.id) * Math.PI * 2,
					r: 4 + node.strength * 7,
					energy: old?.energy ?? hashOf("e" + node.id),
					color: node.type === "workdir" ? "#ffd479" : (KIND_COLORS[node.kind] ?? KIND_COLORS.other)
				};
			});
			const edges = (graph.edges ?? []).map((e) => ({ a: e.a, b: e.b, weight: e.weight }));
			return {
				nodes,
				edges,
				t: hashOf("t" + (graph.meta?.epoch ?? 1)) * 1000,
				running: prev?.running ?? true,
				prune: prev?.prune ?? false,
				hover: null,
				rotX: prev?.rotX ?? -0.35,
				rotY: prev?.rotY ?? 0.6,
				epoch: graph.meta?.epoch
			};
		}

		// 3D 视图变换：旋转 + 透视投影
		function rotate3(x, y, z, rotX, rotY) {
			const x1 = x * Math.cos(rotY) + z * Math.sin(rotY);
			const z1 = -x * Math.sin(rotY) + z * Math.cos(rotY);
			const y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
			const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
			return { x: x1, y: y1, z: z2 };
		}

		/** 本地词法相关度（搜索驱动激活用） */
		function lexScore(node, q) {
			if (!q) return 0;
			const t = q.toLowerCase();
			const title = String(node.title ?? "").toLowerCase();
			const kind = String(node.kind ?? "");
			let s = 0;
			if (title === t) s = Math.max(s, 1);
			if (title.includes(t)) s = Math.max(s, 0.8);
			if (kind.includes(t)) s = Math.max(s, 0.5);
			return s;
		}

		function GraphCanvas({ graph, selectedId, selectedNode, onSelect, onReset, onEvolve, onPrune, running, setRunning, t, empty, pruneSignal, searchQuery, onArchiveWorkdir }) {
			const canvasRef = useRef(null);
			const wrapRef = useRef(null);
			const simRef = useRef(null);
			const sizeRef = useRef({ w: 0, h: 0 });
			const fpsRef = useRef({ frames: 0, last: performance.now(), fps: 0 });
			// v3.3：滚轮缩放（0.4x ~ 3x），围绕画布中心
			const zoomRef = useRef(1);
			const [zoom, setZoom] = useState(1);

			const onWheel = (e) => {
				e.preventDefault();
				const next = Math.min(3, Math.max(0.4, zoomRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
				zoomRef.current = next;
				setZoom(next);
			};

			useEffect(() => {
				simRef.current = buildSim(graph, simRef.current);
			}, [graph]);

			useEffect(() => {
				const sim = simRef.current;
				if (sim) sim.prune = !sim.prune;
			}, [pruneSignal]);

			useEffect(() => {
				const wrap = wrapRef.current;
				const canvas = canvasRef.current;
				if (!wrap || !canvas) return;
				const ro = new ResizeObserver(() => {
					const rect = wrap.getBoundingClientRect();
					sizeRef.current = { w: rect.width, h: rect.height - 26 };
					const dpr = Math.min(2, window.devicePixelRatio || 1);
					canvas.width = Math.max(1, Math.floor(rect.width * dpr));
					canvas.height = Math.max(1, Math.floor((rect.height - 26) * dpr));
					canvas.style.width = rect.width + "px";
					canvas.style.height = (rect.height - 26) + "px";
				});
				ro.observe(wrap);
				return () => ro.disconnect();
			}, []);

			useEffect(() => {
				let raf = 0;
				const tick = () => {
					const sim = simRef.current;
					const fps = fpsRef.current;
					fps.frames++;
					const elapsed = performance.now() - fps.last;
					if (elapsed >= 500) {
						fps.fps = Math.round(fps.frames / (elapsed / 1000));
						fps.frames = 0;
						fps.last = performance.now();
					}
					if (sim) {
						sim.t += 1;
						// 3D 球形无物理布局：坐标由宿主端 x0/y0/z0 给出，动画在下方呼吸/能量逻辑中执行
						// 扩散激活：能量沿边传播
						if (sim.running) {
							if (Math.random() < 0.06 && sim.nodes.length > 0) {
								const pick = sim.nodes[Math.floor(Math.random() * sim.nodes.length)];
								pick.energy = Math.min(1, pick.energy + 0.5);
							}
							for (const e of sim.edges) {
								const a = sim.nodes.find((x) => x.id === e.a);
								const b = sim.nodes.find((x) => x.id === e.b);
								if (!a || !b) continue;
								const flow = (a.energy - b.energy) * 0.08 * e.weight;
								a.energy -= flow;
								b.energy += flow;
							}
							for (const node of sim.nodes) node.energy *= 0.965;
						}
						// 搜索驱动激活：相关节点能量拉升
						if (searchQuery && searchQuery.trim()) {
							const q = searchQuery.trim();
							for (const node of sim.nodes) {
								const s = lexScore(node, q);
								if (s > 0) node.energy = Math.min(1, Math.max(node.energy, 0.35 + s * 0.65));
							}
						}
						// 3D 呼吸动画（球体轻微脉动）
						if (sim.running) {
							for (const node of sim.nodes) {
								const amp = 0.012 + node.energy * 0.02;
								node.x = node.x0 + Math.sin(sim.t * 0.002 + node.phase) * amp;
								node.y = node.y0 + Math.cos(sim.t * 0.0021 + node.phase) * amp;
								node.z = node.z0 + Math.sin(sim.t * 0.0018 + node.phase * 1.3) * amp;
							}
						}
						draw(canvasRef.current, sim, selectedId, sizeRef.current, searchQuery && searchQuery.trim() ? searchQuery.trim() : null, { rotX: sim.rotX, rotY: sim.rotY, zoom: zoomRef.current });
					}
					raf = requestAnimationFrame(tick);
				};
				raf = requestAnimationFrame(tick);
				return () => cancelAnimationFrame(raf);
			}, [selectedId, searchQuery]);

			useEffect(() => {
				const onKey = (e) => {
					if (document.querySelector(".hp-modal") !== null) return;
					const tag = e.target?.tagName;
					if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
					if (e.code === "Space") {
						e.preventDefault();
						setRunning((r) => !r);
					} else if (e.key === "f" || e.key === "F") {
						onEvolve();
					} else if (e.key === "e" || e.key === "E") {
						onPrune();
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onEvolve, onPrune, setRunning]);

			// 3D 命中：投影后按屏幕距离判定
			const hitTest = useCallback((sim, cx, cy) => {
				const rect = canvasRef.current?.getBoundingClientRect();
				if (!rect) return null;
				const w = rect.width;
				const h = Math.max(1, rect.height - 26);
				const scale = Math.min(w, h) * 0.46 * (zoomRef.current || 1);
				const fov = 2.1;
				let best = null;
				let bestD = Infinity;
				for (const node of sim.nodes) {
					const r3 = rotate3(node.x, node.y, node.z, sim.rotX, sim.rotY);
					const depth = fov + r3.z;
					const k = scale / depth;
					const sx = w / 2 + r3.x * k;
					const sy = h / 2 - r3.y * k;
					const px = (cx - rect.left);
					const py = (cy - rect.top);
					const d = Math.sqrt((sx - px) * (sx - px) + (sy - py) * (sy - py));
					const hitR = Math.max(10, node.r * 1.8 * (k / (scale / fov)));
					if (d < hitR && d < bestD) {
						bestD = d;
						best = node;
					}
				}
				return best;
			}, []);

			const pointer = useRef(null);
			const onPointerDown = (e) => {
				const sim = simRef.current;
				if (!sim) return;
				const hit = hitTest(sim, e.clientX, e.clientY);
				pointer.current = { x: e.clientX, y: e.clientY, moved: false, hit };
				// 命中节点：记录待选中；空白处：进入球体旋转
				if (!hit) {
					canvasRef.current?.setPointerCapture?.(e.pointerId);
				}
			};
			const onPointerMove = (e) => {
				const sim = simRef.current;
				if (!sim) return;
				if (pointer.current?.moved === false) {
					const dx = e.clientX - pointer.current.x;
					const dy = e.clientY - pointer.current.y;
					if (dx * dx + dy * dy > 16) pointer.current.moved = true;
				}
				const down = pointer.current;
				if (down && !down.hit && down.moved) {
					// 空白拖拽 = 3D 球体旋转
					const dx = (e.clientX - down.x) * 0.005;
					const dy = (e.clientY - down.y) * 0.005;
					sim.rotY += dx;
					sim.rotX += dy;
					down.x = e.clientX;
					down.y = e.clientY;
					return;
				}
				const hit = hitTest(sim, e.clientX, e.clientY);
				sim.hover = hit?.id ?? null;
			};
			const onPointerUp = (e) => {
				const sim = simRef.current;
				if (!sim) return;
				const moved = pointer.current?.moved === true;
				const hit = pointer.current?.hit ?? null;
				if (!moved && hit) onSelect(hit.id);
				pointer.current = null;
			};
			const onContextMenu = (e) => {
				e.preventDefault();
				const sim = simRef.current;
				if (!sim) return;
				const hit = hitTest(sim, e.clientX, e.clientY);
				// v3.3：右键工作区目录节点 → 主动归档（断开其全部连接，含偏好/交流永久连接）
				if (hit && hit.type === "workdir") {
					if (window.confirm("归档工作区「" + hit.title + "」？\n将断开该工作区的全部连接（含与偏好/交流的永久连接），除非再次使用该目录，否则不再重建。")) {
						onArchiveWorkdir?.(hit.workdir);
					}
					return;
				}
				onSelect(null);
			};
			const onDoubleClick = () => {
				simRef.current = buildSim(graph, null);
				onReset?.();
			};

			const fps = fpsRef.current?.fps ?? 0;
			const m = graph?.meta ?? {};
			const sel = selectedNode ?? null;

			return h("div", { className: "hp-canvas-wrap", ref: wrapRef, style: { position: "relative" } },
				h("canvas", { className: "hp-canvas", ref: canvasRef, onPointerDown, onPointerMove, onPointerUp, onContextMenu, onDoubleClick, onWheel }),
				empty ? h("div", { className: "hp-empty-overlay", style: { bottom: 26 } },
					h("div", { style: { fontSize: 20, opacity: 0.5 } }, "🧠"),
					h("div", { style: { fontSize: 13 } }, t("empty.title")),
					h("div", { style: { fontSize: 11 } }, t("empty.body"))) : null,
				h("div", { className: "hp-hints", style: { bottom: 34 } },
					h("span", null, "滚轮 = 缩放"),
					h("span", null, t("hint.reset")),
					h("span", null, t("hint.drag")),
					h("span", null, running ? "▸" : "▮")),
				h("div", { className: "hp-statusbar" },
						sel
							? h("div", { className: "hp-sel" },
								h("span", null, t("status.selected") + ": ", h("b", null, sel.id)),
								h("span", null, t("status.kind") + ": ", h("b", null, sel.type === "workdir" ? t("kind.workdir") : t("kind." + (sel.kind ?? "other")))),
								h("span", null, t("status.activation") + ": ", h("b", null, (sel.strength ?? 0).toFixed(3))),
								h("span", null, t("status.degree") + ": ", h("b", null, String(sel.degree ?? 0))),
								sel.type === "workdir" && sel.workdir ? h("span", { style: { color: "#8b96a5" } }, sel.workdir) : null)
							: h("div", { className: "hp-sel" }, h("span", { style: { color: "#5b6472" } }, t("status.none"))),
						h("div", { className: "hp-status-right" },
							h("span", null, "Zoom: ", h("b", null, Math.round(zoom * 100) + "%")),
							h("span", null, t("status.fps") + ": ", h("b", null, String(fps))),
							h("span", null, t("status.gen") + ": ", h("b", null, String(m.epoch ?? "—"))),
							h("span", null, t("status.lr") + ": ", h("b", null, (m.learningRate ?? 0.01).toFixed(4))),
							h("span", null, t("status.fit") + ": ", h("b", null, (m.fitness ?? 0).toFixed(3)))))
			);
		}

		// v3.3：3D 球形渲染 —— 旋转 + 透视投影 + 深度排序 + 背面衰减
		function draw(canvas, sim, selectedId, size, searchQuery, view) {
			if (!canvas || size.w === 0) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const w = size.w;
			const h = size.h;
			const rotX = view.rotX ?? -0.35;
			const rotY = view.rotY ?? 0.6;
			const zoom = view.zoom || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			// 背景
			const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
			bg.addColorStop(0, "#0b1220");
			bg.addColorStop(1, "#060a12");
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, w, h);
			// 点阵网格
			ctx.fillStyle = "rgba(90,110,160,0.10)";
			for (let gx = 18; gx < w; gx += 18) {
				for (let gy = 18; gy < h; gy += 18) {
					ctx.fillRect(gx, gy, 1, 1);
				}
			}
			// 投影参数
			const scale = Math.min(w, h) * 0.46 * zoom;
			const fov = 2.1;
			const cx = w / 2;
			const cy = h / 2;
			// 节点投影（含 3D 旋转）
			const pts = sim.nodes.map((node) => {
				const r3 = rotate3(node.x, node.y, node.z, rotX, rotY);
				const depth = fov + r3.z;
				const k = scale / depth;
				return { node, depth, k, sx: cx + r3.x * k, sy: cy - r3.y * k };
			});
			const byId = new Map(pts.map((p) => [p.node.id, p]));
			const q = searchQuery ? searchQuery.toLowerCase() : null;
			const dim = (node) => (q ? (lexScore(node, q) > 0 ? 1 : 0.35) : 1);
			// 背面衰减（z 深入背面时变暗变小）
			const faceA = (p) => Math.max(0.16, Math.min(1, 1.55 - p.depth / fov));
			// 连接（真实突触权重；3D 端点 + 脉冲沿 3D 线段插值）
			for (const e of sim.edges) {
				const pa = byId.get(e.a);
				const pb = byId.get(e.b);
				if (!pa || !pb) continue;
				if (sim.prune && e.weight < 0.3) continue;
				const ad = dim(pa.node) * dim(pb.node);
				if (ad <= 0.05) continue;
				const back = Math.min(faceA(pa), faceA(pb));
				ctx.strokeStyle = "rgba(110,160,255," + ((0.10 + e.weight * 0.30) * ad * back).toFixed(3) + ")";
				ctx.lineWidth = 0.5 + e.weight * 1.1;
				ctx.beginPath();
				ctx.moveTo(pa.sx, pa.sy);
				ctx.lineTo(pb.sx, pb.sy);
				ctx.stroke();
				// 激活脉冲（两端 3D 插值后投影）
				const t = (sim.t * 0.0016 * (0.6 + e.weight) + hashOf(e.a + e.b)) % 1;
				const ix = pa.node.x + (pb.node.x - pa.node.x) * t;
				const iy = pa.node.y + (pb.node.y - pa.node.y) * t;
				const iz = pa.node.z + (pb.node.z - pa.node.z) * t;
				const r3i = rotate3(ix, iy, iz, rotX, rotY);
				const ki = scale / (fov + r3i.z);
				ctx.fillStyle = "rgba(160,200,255," + ((0.3 + e.weight * 0.5) * ad * back).toFixed(3) + ")";
				ctx.beginPath();
				ctx.arc(cx + r3i.x * ki, cy - r3i.y * ki, 1.4 + e.weight, 0, Math.PI * 2);
				ctx.fill();
			}
			// 节点：按深度从远到近绘制（画家算法）
			pts.sort((a, b) => b.depth - a.depth);
			for (const p of pts) {
				const node = p.node;
				const d = dim(node);
				const back = faceA(p);
				const base = p.k / (scale / fov);
				const r = Math.max(2, node.r * base);
				const glow = 6 + node.energy * 16;
				ctx.shadowColor = node.color;
				ctx.shadowBlur = glow;
				ctx.fillStyle = node.color;
				ctx.globalAlpha = (0.55 + node.strength * 0.45) * d * back;
				if (node.type === "workdir") {
					// 工作区目录：方形节点（文件夹）
					const s = r * 1.5;
					ctx.beginPath();
					ctx.roundRect ? ctx.roundRect(p.sx - s, p.sy - s, s * 2, s * 2, 4) : ctx.rect(p.sx - s, p.sy - s, s * 2, s * 2);
					ctx.fill();
				} else {
					ctx.beginPath();
					ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
					ctx.fill();
				}
				ctx.globalAlpha = 1;
				// 搜索命中环
				if (q && lexScore(node, q) > 0) {
					ctx.shadowBlur = 0;
					ctx.strokeStyle = "rgba(255,255,255," + (0.8 * back).toFixed(2) + ")";
					ctx.lineWidth = 1.1;
					ctx.setLineDash([3, 3]);
					ctx.beginPath();
					ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
					ctx.stroke();
					ctx.setLineDash([]);
				}
				if (node.id === selectedId) {
					ctx.shadowBlur = 0;
					ctx.strokeStyle = "rgba(255,255,255," + (0.95 * back).toFixed(2) + ")";
					ctx.lineWidth = 1.6;
					ctx.beginPath();
					ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
					ctx.stroke();
				}
				ctx.shadowBlur = 0;
				if (node.id === sim.hover || node.id === selectedId) {
					ctx.font = "10px ui-monospace, Menlo, monospace";
					const tw = ctx.measureText(node.title).width;
					const tx = Math.min(w - tw - 6, Math.max(6, p.sx - tw / 2));
					const ty = Math.max(12, p.sy - r - 8);
					ctx.fillStyle = "rgba(8,12,20,0.72)";
					ctx.fillRect(tx - 4, ty - 10, tw + 8, 14);
					ctx.fillStyle = "rgba(230,240,255,0.92)";
					ctx.fillText(node.title, tx, ty);
				}
			}
		}

		// ------------------------------------------------------------------
		// 记忆分支列表 + 编辑器
		// ------------------------------------------------------------------

		function strengthLabel(s, t) {
			if (s >= 0.75) return t("strength.high");
			if (s >= 0.45) return t("strength.mid");
			return t("strength.low");
		}

		function ageText(ms, t) {
			const days = Math.max(0, (Date.now() - ms) / 86400000);
			if (days < 1) return Math.max(1, Math.round(days * 24)) + "h";
			return Math.round(days) + "d";
		}

		function BranchCard({ branch, selected, degree, onSelect, onEdit, onArchive, onRestore, onDelete, t }) {
			const color = KIND_COLORS[branch.kind] ?? KIND_COLORS.other;
			const strength = Number(branch.strength) || 0;
			const date = new Date(branch.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
			return h("div", { className: "hp-card", "data-id": branch.id, "data-selected": selected || undefined, onClick: () => onSelect(branch.id) },
				h("div", { className: "hp-card-top" },
					h("span", { className: "hp-badge", style: { background: color } }, t("kind." + branch.kind)),
					h("span", { className: "hp-card-title", title: branch.title }, branch.title),
					typeof degree === "number" && degree > 0 ? h("span", { className: "hp-degree", title: t("status.degree") }, "⚡" + degree) : null,
					h("span", { className: "hp-age", title: t("status.age") }, ageText(branch.updatedAt, t)),
					h("span", { className: "hp-card-meta" }, (branch.source === "user" ? t("source.user") : branch.source === "agent" ? t("source.agent") : t("source.system")) + " · " + date)),
				h("div", { className: "hp-strength", title: t("field.strength") + " " + strength.toFixed(2) + " · " + strengthLabel(strength, t) },
					h("i", { style: { width: Math.round(strength * 100) + "%" } })),
				h("div", { className: "hp-card-content" }, branch.content),
				branch.tags.length > 0 ? h("div", { className: "hp-tags" }, branch.tags.map((tag) => h("span", { className: "hp-tag", key: tag }, "#" + tag))) : null,
				h("div", { className: "hp-card-actions", onClick: (e) => e.stopPropagation() },
					h("button", { className: "hp-mini", onClick: () => onEdit(branch) }, t("btn.edit")),
					branch.status === "active"
						? h("button", { className: "hp-mini", onClick: () => onArchive(branch) }, t("btn.archive"))
						: h("button", { className: "hp-mini", onClick: () => onRestore(branch) }, t("btn.restore")),
					h("button", { className: "hp-mini", style: { color: "#ff7b72" }, onClick: () => onDelete(branch) }, t("btn.delete"))));
		}

		function EditorModal(props) {
			// t 兜底：调用方未传词典时回退 zh，避免渲染崩溃
			const { branch, isNew, onSave, onClose } = props;
			const t = typeof props.t === "function" ? props.t : (k) => (zh[k] ?? k);
			const [title, setTitle] = useState("");
			const [kind, setKind] = useState("other");
			const [tags, setTags] = useState("");
			const [content, setContent] = useState("");
			const [strength, setStrength] = useState(0.6);
			const [status, setStatus] = useState("active");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);

			useEffect(() => {
				setTitle(branch?.title ?? "");
				setKind(branch?.kind ?? "other");
				setTags((branch?.tags ?? []).join(", "));
				setContent(branch?.content ?? "");
				setStrength(branch?.strength ?? 0.6);
				setStatus(branch?.status ?? "active");
				setBusy(false);
				setError(null);
			}, [branch]);

			const submit = async () => {
				if (!title.trim()) {
					setError("标题不能为空");
					return;
				}
				setBusy(true);
				try {
					await onSave({
						title: title.trim(),
						kind,
						tags: tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
						content,
						strength: Number(strength),
						status
					});
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setBusy(false);
				}
			};

			return h("div", { className: "hp-modal", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h("div", { className: "hp-modal-box" },
					h("div", { className: "hp-modal-title" }, isNew ? t("new.title") : t("edit.title")),
					h("div", { className: "hp-field" },
						h("label", null, t("field.title")),
						h("input", { className: "hp-input", value: title, onChange: (e) => setTitle(e.target.value), placeholder: "一句话概括这条记忆" })),
					h("div", { className: "hp-row" },
						h("div", { className: "hp-field" },
							h("label", null, t("field.kind")),
							h("select", { className: "hp-input", value: kind, onChange: (e) => setKind(e.target.value) },
								KINDS.map((k) => h("option", { key: k, value: k }, t("kind." + k))))),
						h("div", { className: "hp-field" },
							h("label", null, t("field.status")),
							h("select", { className: "hp-input", value: status, onChange: (e) => setStatus(e.target.value) },
								h("option", { value: "active" }, t("status.active")),
								h("option", { value: "archived" }, t("status.archived"))))),
					h("div", { className: "hp-field" },
						h("label", null, t("field.tags")),
						h("input", { className: "hp-input", value: tags, onChange: (e) => setTags(e.target.value), placeholder: "例如: 偏好, 中文, 任务A（留空自动生成）" })),
					h("div", { className: "hp-field" },
						h("label", null, t("field.content")),
						h("textarea", { className: "hp-textarea", value: content, onChange: (e) => setContent(e.target.value) })),
					h("div", { className: "hp-field" },
						h("label", null, t("field.strength") + ": " + Number(strength).toFixed(2) + " · " + strengthLabel(Number(strength), t)),
						h("input", { className: "hp-range", type: "range", min: 0, max: 1, step: 0.05, value: strength, onChange: (e) => setStrength(e.target.value) })),
					error ? h("div", { className: "hp-error" }, error) : null,
					h("div", { className: "hp-modal-actions" },
						h("button", { className: "hp-btn", onClick: onClose }, t("btn.cancel")),
						h("button", { className: "hp-btn hp-btn-primary", onClick: submit, disabled: busy }, busy ? "…" : t("btn.save"))),
					!isNew && (branch.history ?? []).length > 0
						? h("div", { className: "hp-history" },
							h("div", null, t("history")),
							branch.history.slice(-4).reverse().map((row, i) => h("div", { key: i }, "· " + new Date(row.at).toLocaleString("zh-CN") + " — " + row.by + "：" + row.summary.slice(0, 80))))
						: null)
			);
		}

		// ------------------------------------------------------------------
		// 主视图
		// ------------------------------------------------------------------

		function MemoryView(props) {
			const { t: tIn } = props;
			const t = (key) => (tIn ? tIn(key) : (zh[key] ?? key));
			const [branches, setBranches] = useState(null);
			const [graph, setGraph] = useState(null);
			const [meta, setMeta] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(null);
			const [search, setSearch] = useState("");
			const [kindFilter, setKindFilter] = useState(null);
			const [selectedId, setSelectedId] = useState(null);
			const [editing, setEditing] = useState(null);
			const [isNew, setIsNew] = useState(false);
			const [running, setRunning] = useState(true);
			const [toast, setToast] = useState(null);
			const toastTimer = useRef(null);

			const ctx = useMemo(() => props.__ctx ?? null, [props.__ctx]);

			// v3.2 统一记忆库：所有信息内容记忆在同一记录中，跨工作区目录打通。
			// 不再有 项目/全局 作用域切换；projectPath 仅用于显示当前工作目录。
			const [projectPath, setProjectPath] = useState(null);

			// 当前会话 id：优先框架注入（inject: (sessionId) => …），反射兜底
			const sessionIdOf = useCallback(() => {
				if (typeof props.sessionId === "string" && props.sessionId) return props.sessionId;
				try {
					const sessions = ctx?.reflect?.get("sessions", false);
					const info = sessions?.currentProvideInfo?.getSnapshot?.();
					return info?.sessionId ?? null;
				} catch { return null; }
			}, [ctx, props.sessionId]);

			// 初始化时解析当前会话的工作目录（cwd）用于展示；
			// 解析链：① 宿主端权威解析（sessionQuery.readSession → header.cwd）
			//        ② 反射兜底（修正 getSnapshot 链）③ 5 秒后重试一次（启动绑定）
			useEffect(() => {
				let alive = true;
				let tried = false;
				const resolve = async () => {
					try {
						// ① 宿主端权威解析
						const sid = sessionIdOf();
						if (sid) {
							const res = await remoteCall(ctx, "resolveProject", { sessionId: sid });
							if (res.ok && typeof res.value?.cwd === "string" && res.value.cwd) {
								if (alive) setProjectPath(res.value.cwd);
								return true;
							}
						}
					} catch { /* 走兜底 */ }
					try {
						// ② 反射兜底（hooks.session 是 HostObservable，需 getSnapshot()）
						const sessions = ctx?.reflect?.get("sessions", false);
						const info = sessions?.currentProvideInfo?.getSnapshot?.();
						const sessionObj = info?.hooks?.session;
						const cwd = sessionObj && typeof sessionObj.getSnapshot === "function"
							? sessionObj.getSnapshot()?.header?.cwd
							: sessionObj?.header?.cwd;
						if (typeof cwd === "string" && cwd) {
							if (alive) setProjectPath(cwd);
							return true;
						}
					} catch { /* 走回退 */ }
					return false;
				};
				void resolve();
				// ③ 启动/切换会话时若未就绪，5 秒后重试一次
				const retryTimer = setTimeout(() => {
					if (alive && !tried) {
						tried = true;
						void resolve();
					}
				}, 5000);
				return () => { alive = false; clearTimeout(retryTimer); };
			}, [ctx, sessionIdOf]);

			// 统一库请求参数：仅携带当前目录（供宿主端登记会话来源），不再区分作用域
			const scopeArgs = useMemo(() =>
				projectPath ? { scope: "unified", scopePath: projectPath } : { scope: "unified" },
			[projectPath]);

			const notify = useCallback((msg) => {
				setToast(msg);
				if (toastTimer.current) clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(() => setToast(null), 2600);
			}, []);

			const loadAll = useCallback(async () => {
				setLoading(true);
				setError(null);
				try {
					// 并行拉取列表与图（此前串行导致切换项目时加载明显变慢）
					const [listRes, graphRes] = await Promise.all([
						remoteCall(ctx, "list", { includeArchived: true, ...scopeArgs }),
						remoteCall(ctx, "graph", scopeArgs).catch(() => ({ ok: false }))
					]);
					if (!listRes.ok) throw new Error(listRes.error?.message ?? "list failed");
					setBranches(listRes.value.branches ?? []);
					setMeta(listRes.value.meta ?? null);
					if (graphRes.ok) setGraph(graphRes.value);
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setLoading(false);
				}
			}, [ctx, scopeArgs]);

			useEffect(() => { loadAll(); }, [loadAll]);
			useEffect(() => { setSelectedId(null); }, [projectPath]);
			useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

			const saveBranch = useCallback(async (data) => {
				if (editing && !isNew) {
					const res = await remoteCall(ctx, "update", { id: editing.id, patch: data, by: "user", ...scopeArgs });
					if (!res.ok) throw new Error(res.error?.message ?? "update failed");
				} else {
					const res = await remoteCall(ctx, "create", { ...data, source: "user", ...scopeArgs });
					if (!res.ok) throw new Error(res.error?.message ?? "create failed");
					if (res.value?.dedup) notify("检测到相似记忆，已合并强化原记忆");
				}
				setEditing(null);
				notify(t("saved"));
				await loadAll();
			}, [ctx, editing, isNew, loadAll, notify, t, scopeArgs]);

			const archiveBranch = useCallback(async (branch) => {
				const res = await remoteCall(ctx, "update", { id: branch.id, patch: { status: branch.status === "active" ? "archived" : "active" }, by: "user", ...scopeArgs });
				if (!res.ok) return;
				notify(branch.status === "active" ? t("archived") : t("restored"));
				await loadAll();
			}, [ctx, loadAll, notify, t, scopeArgs]);

			const deleteBranch = useCallback(async (branch) => {
				if (!window.confirm(t("confirm.delete"))) return;
				const res = await remoteCall(ctx, "forget", { id: branch.id, hard: true, ...scopeArgs });
				if (!res.ok) return;
				notify(t("deleted"));
				if (selectedId === branch.id) setSelectedId(null);
				await loadAll();
			}, [ctx, loadAll, notify, selectedId, t, scopeArgs]);

			// 真实演化（宿主端合并近重复 + 修剪弱连接 + 代际推进）
			const evolve = useCallback(async () => {
				const res = await remoteCall(ctx, "evolve", scopeArgs);
				if (!res.ok) return;
				const v = res.value ?? {};
				notify(t("evolved") + "：合并 " + (v.merged ?? 0) + " · 修剪连接 " + (v.prunedLinks ?? 0) + " · Gen " + (v.meta?.generation ?? 0));
				setGraph(res.value);
				await loadAll();
			}, [ctx, loadAll, notify, t, scopeArgs]);

			// 真实修剪（宿主端归档弱且久的记忆）
			const prune = useCallback(async () => {
				const res = await remoteCall(ctx, "prune", scopeArgs);
				if (!res.ok) return;
				const v = res.value ?? {};
				notify(t("prunedDone") + "：归档 " + (v.pruned ?? 0) + " 条弱记忆 · 修剪连接 " + (v.prunedLinks ?? 0));
				setGraph(res.value);
				await loadAll();
			}, [ctx, loadAll, notify, t, scopeArgs]);

			// 仅切换画布内「弱连接隐藏」（E 键视觉开关）
			const [pruneTick, setPruneTick] = useState(0);
			const doPruneView = useCallback(() => {
				setPruneTick((v) => v + 1);
				notify("已隐藏弱连接（<0.3）；再次按 E 恢复显示");
			}, [notify]);

			// v3.1 轨迹喂养：把当前对话的「轨迹」内容（用户/助手/工具消息，
			// 与轨迹标签页同源）喂养到本项目记忆。手动点击 = 全量喂养整个对话历史；
			// 每小时定时任务自动增量喂养。显式携带 sessionId，确保命中当前会话轨迹。
			const feed = useCallback(async () => {
				const res = await remoteCall(ctx, "feed", { ...scopeArgs, sessionId: sessionIdOf(), sinceMs: 0 });
				if (!res.ok) { notify("喂养失败：" + (res.error?.message ?? "未知")); return; }
				const v = res.value ?? {};
				const detail = v.wrote
					? " → 写入「" + (v.title ?? "会话精华") + "」（" + (v.chars ?? 0) + " 字）"
					: v.reason
						? "（" + v.reason + "）"
						: "";
				notify("轨迹喂养：" + (v.fed ?? 0) + " 条事件" + detail + (v.size?.triggered ? " · 存储超限已自动优化" : ""));
				await loadAll();
			}, [ctx, loadAll, notify, scopeArgs]);

			const filtered = useMemo(() => {
				if (!branches) return [];
				let list = branches.slice().sort((a, b) => {
					if (a.status !== b.status) return a.status === "active" ? -1 : 1;
					return b.updatedAt - a.updatedAt;
				});
				if (kindFilter) list = list.filter((b) => b.kind === kindFilter);
				if (search.trim()) {
					const q = search.trim().toLowerCase();
					list = list.filter((b) =>
						b.title.toLowerCase().includes(q) ||
						b.content.toLowerCase().includes(q) ||
						(b.tags ?? []).some((tag) => tag.toLowerCase().includes(q)));
				}
				return list;
			}, [branches, kindFilter, search]);

			const activeCount = useMemo(() => (branches ?? []).filter((b) => b.status === "active").length, [branches]);
			const archivedCount = useMemo(() => (branches ?? []).filter((b) => b.status === "archived").length, [branches]);

			const stats = graph?.meta ?? meta ?? {};
			// v3.3：选中节点 —— 分支列表优先，工作区目录等图节点从 graph 解析
			const selectedNode = useMemo(() => {
				const b = (branches ?? []).find((x) => x.id === selectedId);
				if (b) return b;
				return (graph?.nodes ?? []).find((n) => n.id === selectedId) ?? null;
			}, [branches, graph, selectedId]);

			// v3.3：用户主动归档工作区目录（断开其全部连接，含偏好/交流永久连接）
			const archiveWorkdir = useCallback(async (workdirPath) => {
				const res = await remoteCall(ctx, "archiveWorkdir", { path: workdirPath });
				if (!res.ok) { notify("归档失败：" + (res.error?.message ?? "未知")); return; }
				notify("已归档工作区「" + (workdirPath.split(/[/\\]+/).filter(Boolean).pop() ?? workdirPath) + "」，连接已断开");
				await loadAll();
			}, [ctx, loadAll, notify]);

			// 节点度数（来自突触图）
			const degreeMap = useMemo(() => {
				const m = new Map();
				for (const e of graph?.edges ?? []) {
					m.set(e.a, (m.get(e.a) ?? 0) + 1);
					m.set(e.b, (m.get(e.b) ?? 0) + 1);
				}
				return m;
			}, [graph]);

			// 左侧控制面板（图例 + 自学习 + 自演化 —— 真实数据与操作）
			const leftPanel = h("div", { className: "hp-left" },
				h("div", { className: "hp-panel" },
					h("div", { className: "hp-panel-title" },
						h("i", { style: { color: "#4fc3f7" } }),
						t("legend.title")),
					h("div", { className: "hp-legend" },
						KINDS.map((k) => h("div", { className: "hp-legend-row", key: k },
							h("span", { className: "hp-legend-dot", style: { background: KIND_COLORS[k] ?? KIND_COLORS.other, color: KIND_COLORS[k] ?? KIND_COLORS.other } }),
							t("kind." + k))),
						h("div", { className: "hp-legend-row", key: "workdir" },
							h("span", { className: "hp-legend-dot", style: { background: KIND_COLORS.workdir, color: KIND_COLORS.workdir } }),
							t("kind.workdir")),
						h("div", { className: "hp-legend-hint" },
							h("span", { className: "hp-legend-size" }),
							t("legend.activation")),
						h("div", { className: "hp-legend-hint" },
							h("span", { className: "hp-legend-size" }),
							t("legend.links")))),
				h("div", { className: "hp-panel" },
					h("div", { className: "hp-panel-title" },
						h("i", { style: { color: "#81c784" } }),
						t("ctrl.learning.en")),
					h("span", { className: "hp-ctrl-status", "data-off": !running || undefined },
						running ? t("ctrl.active") : t("ctrl.paused")),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.neurons")), h("b", null, String(stats.neurons ?? activeCount))),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.synapses")), h("b", null, String(stats.connections ?? 0))),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.fitness")), h("b", null, (stats.fitness ?? 0).toFixed(3))),
					h("div", { className: "hp-ctrl-btns" },
						h("button", { className: "hp-btn", onClick: () => setRunning((r) => !r) }, t("ctrl.toggle")))),
				h("div", { className: "hp-panel" },
					h("div", { className: "hp-panel-title" },
						h("i", { style: { color: "#ba68c8" } }),
						t("ctrl.evolution.en")),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.gen")), h("b", null, String(stats.generation ?? 0))),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.merged")), h("b", null, String(stats.merged ?? 0))),
					h("div", { className: "hp-ctrl-row" }, h("span", null, t("ctrl.pruned")), h("b", null, String(stats.pruned ?? 0))),
					h("div", { className: "hp-ctrl-btns" },
						h("button", { className: "hp-btn hp-btn-primary", onClick: () => { evolve(); } }, t("ctrl.evolve")),
						h("button", { className: "hp-btn", onClick: () => { prune(); } }, t("ctrl.pruneWeak")),
						h("button", { className: "hp-btn", onClick: () => { feed(); } }, t("btn.feed")),
						h("button", { className: "hp-btn", onClick: doPruneView }, t("ctrl.prune")))));

			return h("div", { className: "hp-root" },
					h("div", { className: "hp-header" },
						h("div", { className: "hp-scope", style: { display: "flex", alignItems: "center", gap: "8px", background: "var(--dsw-alias-bg-elevated,#0e1420)", border: "1px solid var(--dsw-alias-border-l2,#232b3a)", borderRadius: "10px", padding: "5px 12px" } },
							h("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary,#e6edf3)" } }, "🧠 " + t("view.memory")),
							h("span", { style: { fontSize: "9px", color: "#5b6472", fontFamily: "ui-monospace,Menlo,monospace" } }, "UNIFIED"),
							projectPath ? h("span", { title: projectPath, style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary,#7d8590)", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "📁 " + projectPath.split(/[/\\]+/).pop() ?? "") : null),
						h("div", { className: "hp-stats" },
							h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.neurons ?? activeCount)), h("span", { className: "hp-stat-k" }, t("stats.neurons"))),
							h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.connections ?? 0)), h("span", { className: "hp-stat-k" }, t("stats.connections"))),
							h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.activation ?? 0)), h("span", { className: "hp-stat-k" }, t("stats.activation"))),
							h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.epoch ?? 1)), h("span", { className: "hp-stat-k" }, t("stats.epoch"))),
							h("div", { className: "hp-stat" }, h("span", { className: "hp-stat-v" }, String(stats.fitness ?? 0)), h("span", { className: "hp-stat-k" }, t("stats.fitness")))),
						h("input", { className: "hp-search", placeholder: t("search.placeholder"), value: search, onChange: (e) => setSearch(e.target.value) }),
						h("div", { className: "hp-chips" },
							h("button", { className: "hp-chip", "data-on": kindFilter === null || undefined, onClick: () => setKindFilter(null) }, t("filter.all")),
							KINDS.map((k) => h("button", { className: "hp-chip", "data-on": kindFilter === k || undefined, key: k, onClick: () => setKindFilter(kindFilter === k ? null : k) }, t("kind." + k)))),
						h("button", { className: "hp-btn hp-btn-primary", onClick: () => { setIsNew(true); setEditing({}); } }, t("btn.new")),
						h("button", { className: "hp-btn", onClick: loadAll }, t("btn.refresh"))),
					h("div", { className: "hp-body" },
					loading
						? h("div", { className: "hp-loading", style: { flex: 1 } }, t("loading"))
						: error
							? h("div", { className: "hp-error", style: { flex: 1 } }, t("error") + " " + error)
							: h(Fragment, null,
								leftPanel,
								h(GraphCanvas, {
									graph: graph ?? { nodes: [], edges: [], meta: {} },
									selectedId,
									selectedNode,
									onSelect: (id) => {
										setSelectedId(id);
										const el = document.querySelector(".hp-card[data-id=\"" + id + "\"]");
										el?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
									},
									onReset: () => { },
									onEvolve: () => { evolve(); },
									onPrune: doPruneView,
									running,
									setRunning,
									t,
									empty: activeCount === 0,
									pruneSignal: pruneTick,
									searchQuery: search,
									onArchiveWorkdir: archiveWorkdir
								}),
									h("div", { className: "hp-list" },
										archivedCount > 0 ? h("div", { className: "hp-card-meta", style: { padding: "0 4px" } }, "活跃 " + activeCount + " · 归档 " + archivedCount) : null,
										filtered.map((branch) => h(BranchCard, {
											key: branch.id,
											branch,
											selected: branch.id === selectedId,
											degree: degreeMap.get(branch.id) ?? 0,
											onSelect: setSelectedId,
											onEdit: (b) => { setIsNew(false); setEditing(b); },
											onArchive: archiveBranch,
											onRestore: archiveBranch,
											onDelete: deleteBranch,
											t
										})),
										filtered.length === 0 ? h("div", { className: "hp-loading" }, t("empty.title")) : null))),
					editing ? h(EditorModal, {
						branch: isNew ? null : editing,
						isNew,
						onSave: saveBranch,
						onClose: () => { setEditing(null); setIsNew(false); },
						t
					}) : null,
					toast ? h("div", { className: "hp-toast" }, toast) : null
				);
		}

		// ------------------------------------------------------------------
		// 插件主体
		// ------------------------------------------------------------------

		const inject = ["slots", "locale", "remote"];

		async function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "hippocampus: dictionaries");
			const t = ctx.locale.bind(NS);
			const remote = ctx.get("remote");
			await remote.$mount(CONTRIBUTION);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "hippocampus",
				order: 20,
				locale: NS,
				label: () => t("view.memory"),
				inject: (sessionId) => ({ __ctx: ctx, sessionId })
			}, MemoryView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
