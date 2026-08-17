// 3D 渲染：以「视觉修正」为目标 —— 深度越远越小越暗、球体体积感、层级轨道。
// 不做经纬线网格 / 地面投影 / 子午线等装饰性 3D 动效，避免线条杂乱。
const { rotate3, lexScore } = require("./sim.js");

// 边连接含义：颜色 = 原因（图例 / 连线着色 / 标注共用）
function edgeReason(a, b) {
	if (a.type === "workdir" || b.type === "workdir") {
		const other = a.type === "workdir" ? b : a;
		if (other.type === "core") return { label: "永久锚定", color: "#ffd479" };
		if (other.type === "workdir") return { label: "目录关联", color: "#f2b36b" };
		return { label: "项目归属", color: "#ffb74d" };
	}
	if (a.type === "core" && b.type === "core") return { label: "核心协同", color: "#4fc3f7" };
	if (a.type === "core" || b.type === "core") return { label: "核心关联", color: "#7fa8ff" };
	if (a.workdir && a.workdir === b.workdir) return { label: "同项目", color: "#81c784" };
	return { label: "语义相似", color: "#ba68c8" };
}

function hexA(hex, a) {
	const n = parseInt(hex.slice(1), 16);
	return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a.toFixed(3) + ")";
}

// 明暗偏移（正=提亮，负=压暗），用于球体光照
function shade(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
	const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
	const b = Math.max(0, Math.min(255, (n & 255) + amt));
	return "rgb(" + r + "," + g + "," + b + ")";
}

function distToSeg(px, py, x1, y1, x2, y2) {
	const dx = x2 - x1, dy = y2 - y1;
	const l2 = dx * dx + dy * dy;
	if (l2 === 0) return Math.hypot(px - x1, py - y1);
	let tt = ((px - x1) * dx + (py - y1) * dy) / l2;
	tt = Math.max(0, Math.min(1, tt));
	return Math.hypot(px - (x1 + tt * dx), py - (y1 + tt * dy));
}

// 3D 球形渲染 —— 旋转 + 透视投影 + 深度排序 + 背面衰减
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
	const dragging = view.dragging ?? false;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	// 背景
	const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
	bg.addColorStop(0, "#0b1220");
	bg.addColorStop(1, "#060a12");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	// 点阵网格
	ctx.fillStyle = "rgba(90,110,160,0.07)";
	for (let gx = 18; gx < w; gx += 18) {
		for (let gy = 18; gy < h; gy += 18) ctx.fillRect(gx, gy, 1, 1);
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
	// 搜索态用【服务端真实检索命中】决定变暗/命中环/共激活脉冲
	const sr = q && sim.searchHits && sim.searchHits.q === q ? sim.searchHits : null;
	const nowMs = Date.now();
	const edgeSignal = new Map();
	if (sr) for (const e of sr.edges) edgeSignal.set(e.a + "|" + e.b, e);
	const dim = (node) => {
		if (!q) return 1;
		if (sr) return sr.hits.has(node.id) ? 1 : 0.32;
		return lexScore(node, q) > 0 ? 1 : 0.35;
	};
	// 选中节点关联高亮：计算与 selectedId 直接相连的节点集合和边集合
	const connectedIds = new Set();
	const highlightedEdgeSet = new Set();
	if (selectedId) {
		for (const e of sim.edges) {
			if (e.a === selectedId || e.b === selectedId) {
				highlightedEdgeSet.add(e.a + "|" + e.b);
				highlightedEdgeSet.add(e.b + "|" + e.a);
				if (e.a !== selectedId) connectedIds.add(e.a);
				if (e.b !== selectedId) connectedIds.add(e.b);
			}
		}
	}
	const isHighlighted = (nodeId) => !!selectedId && (nodeId === selectedId || connectedIds.has(nodeId));
	// 选中时非关联节点大幅变暗
	const dimWithSelection = (node) => {
		if (selectedId && !isHighlighted(node.id)) return 0.18;
		return dim(node);
	};
	// 背面衰减（z 深入背面时变暗变小）—— 立体感的「视觉修正」核心
	const faceA = (p) => Math.max(0.16, Math.min(1, 1.55 - p.depth / fov));

	// —— 层级轨道：三层壳（核心/工作区/衍生）赤道环，保留层级语义 ——
	const SHELLS = [
		{ r: 0.08, label: "核心 · 中枢", color: "rgba(150,190,255,0.40)" },
		{ r: 0.34, label: "工作区 · 项目", color: "rgba(255,206,130,0.36)" },
		{ r: 0.78, label: "衍生 · 记忆", color: "rgba(200,170,255,0.30)" }
	];
	ctx.lineWidth = 1;
	for (const sh of SHELLS) {
		ctx.strokeStyle = sh.color;
		ctx.beginPath();
		for (let i = 0; i <= 60; i++) {
			const th = (i / 60) * Math.PI * 2;
			const p = rotate3(Math.cos(th) * sh.r, 0, Math.sin(th) * sh.r, rotX, rotY);
			const k = scale / (fov + p.z);
			const sx = cx + p.x * k, sy = cy - p.y * k;
			if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
		}
		ctx.stroke();
	}
	// 层标签（左上角固定，可读且不随旋转漂移）
	ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
	ctx.textBaseline = "top";
	SHELLS.forEach((sh, i) => {
		const ly = 30 + i * 18;
		ctx.fillStyle = "rgba(6,10,18,0.78)";
		ctx.fillRect(10, ly - 1, 142, 17);
		ctx.fillStyle = sh.color;
		ctx.fillText(sh.label, 15, ly);
	});
	ctx.textBaseline = "alphabetic";

	// —— 透视地平线网格（y=-1.55 平面，随球体旋转）—— 弱化处理，仅提供纵深感 ——
	const FLOOR_Y = -1.55, FLOOR_HALF = 2.2, GRID_N = 6;
	const proj3 = (v) => { const dd = fov + v.z; if (dd < 0.25) return null; return { x: cx + v.x * (scale / dd), y: cy - v.y * (scale / dd) }; };
	ctx.lineWidth = 1;
	for (let i = 0; i <= GRID_N; i++) {
		const t = -1 + (2 * i) / GRID_N;
		const p1 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, -FLOOR_HALF, rotX, rotY));
		const p2 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, FLOOR_HALF, rotX, rotY));
		const p3 = proj3(rotate3(-FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		const p4 = proj3(rotate3(FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		ctx.strokeStyle = "rgba(130,165,220,0.09)";
		if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
		if (p3 && p4) { ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke(); }
	}

	// —— 连接（真实突触权重；按连接原因着色；悬停/选中边标注原因+权重）——
	// 悬停检测：鼠标距离线段最近者
	let hoverEdge = null;
	if (sim.mouse && sim.mouse.inside && !dragging) {
		let bd = 9;
		for (const e of sim.edges) {
			const pa = byId.get(e.a), pb = byId.get(e.b);
			if (!pa || !pb) continue;
			if (sim.prune && e.weight < 0.3) continue;
			if (Math.min(faceA(pa), faceA(pb)) < 0.5) continue;
			const d = distToSeg(sim.mouse.x, sim.mouse.y, pa.sx, pa.sy, pb.sx, pb.sy);
			if (d < bd) { bd = d; hoverEdge = e; }
		}
	}
	sim.hoverEdge = hoverEdge;
	for (const e of sim.edges) {
		const pa = byId.get(e.a);
		const pb = byId.get(e.b);
		if (!pa || !pb) continue;
		if (sim.prune && e.weight < 0.3) continue;
		const ad = dimWithSelection(pa.node) * dimWithSelection(pb.node);
		if (ad <= 0.05) continue;
		const back = Math.min(faceA(pa), faceA(pb));
		const reason = edgeReason(pa.node, pb.node);
		const isHoverEdge = hoverEdge === e;
		const isFocusEdge = isHoverEdge || (selectedId && highlightedEdgeSet.has(e.a + "|" + e.b));
		// 聚焦/悬停边高亮（加粗 + 白 + 原因色发光）；普通边按原因着色
		const lwScale = Math.min(2.2, Math.max(0.6, zoom)); // v5.2：线宽随缩放轻微变化
		if (isFocusEdge) {
			ctx.strokeStyle = "rgba(255,255,255," + Math.min(0.96, (0.6 + e.weight * 0.4) * back).toFixed(3) + ")";
			ctx.lineWidth = (1.8 + e.weight * 2.2) * lwScale;
			ctx.shadowColor = reason.color;
			ctx.shadowBlur = 9 * Math.min(1.6, zoom);
		} else {
			ctx.strokeStyle = hexA(reason.color, (0.10 + e.weight * 0.32) * ad * back);
			ctx.lineWidth = (0.5 + e.weight * 1.2) * lwScale;
			ctx.shadowBlur = 0;
		}
		ctx.beginPath();
		ctx.moveTo(pa.sx, pa.sy);
		ctx.lineTo(pb.sx, pb.sy);
		ctx.stroke();
		ctx.shadowBlur = 0;
		// 脉冲：只对【真实共激活边】在真实检索发生后播放一次（从 a→b）
		const sig = sr ? edgeSignal.get(e.a + "|" + e.b) : null;
		if (sig && (nowMs - sr.at) < 2000) {
			const tt = Math.min(1, (nowMs - sr.at) / 2000);
			const ix = pa.node.x + (pb.node.x - pa.node.x) * tt;
			const iy = pa.node.y + (pb.node.y - pa.node.y) * tt;
			const iz = pa.node.z + (pb.node.z - pa.node.z) * tt;
			const r3i = rotate3(ix, iy, iz, rotX, rotY);
			const ki = scale / (fov + r3i.z);
			ctx.fillStyle = "rgba(170,225,255," + Math.max(0, (0.45 + sig.weight * 0.4) * (1 - tt * 0.6) * ad * back).toFixed(3) + ")";
			ctx.beginPath();
			ctx.arc(cx + r3i.x * ki, cy - r3i.y * ki, 1.6 + sig.weight * 1.6, 0, Math.PI * 2);
			ctx.fill();
		}
		// 连接原因标注：悬停的边、或选中节点的相连边（标注「原因 · 权重」）
		if (isFocusEdge) {
			const mx = (pa.sx + pb.sx) / 2;
			const my = (pa.sy + pb.sy) / 2;
			const label = reason.label + " · " + e.weight.toFixed(2);
			ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(label).width;
			const bx = Math.min(w - tw - 10, Math.max(6, mx - tw / 2));
			const byy = Math.max(18, my - 8);
			ctx.fillStyle = "rgba(6,10,18,0.88)";
			ctx.beginPath();
			ctx.roundRect ? ctx.roundRect(bx - 5, byy - 13, tw + 10, 18, 4) : ctx.rect(bx - 5, byy - 13, tw + 10, 18);
			ctx.fill();
			ctx.fillStyle = reason.color;
			ctx.fillText(label, bx, byy);
		}
	}
	// 节点：按深度从远到近绘制（画家算法）
	pts.sort((a, b) => b.depth - a.depth);
	for (const p of pts) {
		const node = p.node;
		const d = dimWithSelection(node);
		const back = faceA(p);
		// v5.2 修复：节点半径必须随 zoom 缩放（此前 base=fov/depth 不含 zoom，
		// 放大时节点位置散开但大小不变 —— 三维感缺失、视觉像贴图）。
		// 正确投影：屏幕半径 = 世界半径 × scale/depth = r × fov/depth × zoom
		const base = (p.k / (scale / fov)) * zoom;
		// 层级区分：核心更大、衍生略小，配合轨道显示层级
		const sizeK = node.type === "core" ? 1.3 : node.type === "leaf" ? 0.85 : 1;
		const r = Math.max(1.5, node.r * base * sizeK);
		// 选中/关联节点发光更强，普通节点弱发光，避免光晕杂乱
		const highlighted = isHighlighted(node.id);
		const isSelected = node.id === selectedId;
		const glow = isSelected ? 14 + node.energy * 16
			: highlighted ? 9 + node.energy * 12
			: 3 + node.energy * 9;
		ctx.shadowColor = isSelected ? "#ffffff" : (highlighted ? "#aaddff" : node.color);
		ctx.shadowBlur = glow;
		ctx.globalAlpha = (0.55 + node.strength * 0.45) * d * back;
		if (node.type === "workdir") {
			// 工作区目录：方形节点（文件夹），线性渐变 + 描边
			const s = r * 1.5;
			const lg = ctx.createLinearGradient(p.sx - s, p.sy - s, p.sx + s, p.sy + s);
			lg.addColorStop(0, shade(node.color, 70));
			lg.addColorStop(1, shade(node.color, -50));
			ctx.fillStyle = lg;
			ctx.beginPath();
			ctx.roundRect ? ctx.roundRect(p.sx - s, p.sy - s, s * 2, s * 2, 4) : ctx.rect(p.sx - s, p.sy - s, s * 2, s * 2);
			ctx.fill();
			ctx.strokeStyle = "rgba(255,255,255," + (0.18 * back).toFixed(2) + ")";
			ctx.lineWidth = 1;
			ctx.stroke();
		} else {
			// 球体体积感：径向渐变（左上亮 / 右下暗）+ 单一玻璃高光 + 边缘暗环
			const rg = ctx.createRadialGradient(p.sx - r * 0.4, p.sy - r * 0.45, r * 0.1, p.sx, p.sy, r * 1.05);
			rg.addColorStop(0, shade(node.color, 120));
			rg.addColorStop(0.55, node.color);
			rg.addColorStop(1, shade(node.color, -70));
			ctx.fillStyle = rg;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
			ctx.fill();
			// 单一玻璃高光点（不叠加多个光斑，保持干净）
			if (back > 0.6) {
				ctx.fillStyle = "rgba(255,255,255," + (0.45 * back).toFixed(2) + ")";
				ctx.beginPath();
				ctx.arc(p.sx - r * 0.35, p.sy - r * 0.4, Math.max(1.2, r * 0.16), 0, Math.PI * 2);
				ctx.fill();
			}
			// 边缘暗环（环境光遮蔽），增强体积与明暗转折
			const rim = ctx.createRadialGradient(p.sx, p.sy, r * 0.78, p.sx, p.sy, r);
			rim.addColorStop(0, "rgba(0,0,0,0)");
			rim.addColorStop(1, "rgba(3,6,14," + (0.4 * back).toFixed(2) + ")");
			ctx.fillStyle = rim;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
		// 搜索命中环（真实检索命中的节点才有环）
		const isHit = sr ? sr.hits.has(node.id) : !!(q && lexScore(node, q) > 0);
		if (isHit && !highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = "rgba(255,255,255," + (0.8 * back).toFixed(2) + ")";
			ctx.lineWidth = 1.1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// 选中/关联节点高亮环（实心白环 + 外发光）
		if (highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = isSelected
				? "rgba(255,255,255," + (0.98 * back).toFixed(2) + ")"
				: "rgba(170,220,255," + (0.85 * back).toFixed(2) + ")";
			ctx.lineWidth = isSelected ? 2.4 : 1.6;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + (isSelected ? 5 : 4), 0, Math.PI * 2);
			ctx.stroke();
			// 选中节点额外发光圈
			if (isSelected) {
				ctx.strokeStyle = "rgba(255,255,255," + (0.35 * back).toFixed(2) + ")";
				ctx.lineWidth = 5;
				ctx.beginPath();
				ctx.arc(p.sx, p.sy, r + 8, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.shadowBlur = 0;
		// 标签：仅聚焦（选中）节点显示名称并放大；其它节点一律不显示名称
		if (isSelected) {
			ctx.font = "bold 16px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(node.title).width;
			const tx = Math.min(w - tw - 6, Math.max(6, p.sx - tw / 2));
			const ty = Math.max(18, p.sy - r - 15);
			ctx.fillStyle = "rgba(6,10,18,0.88)";
			ctx.fillRect(tx - 6, ty - 14, tw + 12, 20);
			ctx.fillStyle = "#ffffff";
			ctx.fillText(node.title, tx, ty);
		} else if (node.id === sim.hover && !highlighted) {
			// 悬停反馈：仅细光环，不显示名称
			ctx.shadowBlur = 0;
			ctx.strokeStyle = "rgba(255,255,255," + (0.35 * back).toFixed(2) + ")";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 2, 0, Math.PI * 2);
			ctx.stroke();
		}
	}
}

exports.draw = draw;
