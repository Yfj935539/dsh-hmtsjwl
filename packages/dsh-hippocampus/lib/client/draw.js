// 3D 渲染：深度透视 + 球体体积感 + 层级轨道。
// v5.6：主题自适应（浅/深色）+ 旋转参照（轨道卫星点/增强网格）+ 方位罗盘（镜头朝向）。
const { rotate3, lexScore } = require("./sim.js");

// —— v5.6 主题调色板：从 DSH CSS 变量读取背景色，自动适配浅色/深色主题 ——
const DARK_PALETTE = {
	dark: true,
	bgTop: "#0b1220", bgBottom: "#060a12",
	grid: "rgba(90,110,160,0.05)",
	floor: "rgba(130,165,220,0.16)",
	floorDot: "rgba(130,165,220,0.30)",
	shell: ["rgba(150,190,255,0.34)", "rgba(255,206,130,0.28)", "rgba(200,170,255,0.24)"],
	shellSat: ["rgba(170,205,255,0.75)", "rgba(255,220,150,0.7)", "rgba(215,185,255,0.65)"],
	layerText: "rgba(150,180,230,0.62)",
	labelBg: "rgba(6,10,18,0.88)", labelText: "#ffffff",
	hitRing: "rgba(255,255,255,0.8)",
	selRing: "rgba(255,255,255,0.98)",
	hoverRing: "rgba(255,255,255,0.35)",
	compassBg: "rgba(6,10,18,0.72)", compassText: "#cfe0ff",
	axisX: "#ff6b6b", axisY: "#69db7c", axisZ: "#74c0fc"
};
const LIGHT_PALETTE = {
	dark: false,
	bgTop: "#eef2f8", bgBottom: "#dde4ef",
	grid: "rgba(60,80,120,0.12)",
	floor: "rgba(70,100,160,0.30)",
	floorDot: "rgba(70,100,160,0.55)",
	shell: ["rgba(80,110,180,0.36)", "rgba(190,140,70,0.32)", "rgba(140,100,190,0.28)"],
	shellSat: ["rgba(60,90,160,0.85)", "rgba(170,120,50,0.8)", "rgba(120,80,170,0.75)"],
	layerText: "rgba(70,95,150,0.75)",
	labelBg: "rgba(255,255,255,0.92)", labelText: "#16202e",
	hitRing: "rgba(30,60,100,0.85)",
	selRing: "rgba(20,40,80,0.95)",
	hoverRing: "rgba(60,90,150,0.6)",
	compassBg: "rgba(255,255,255,0.85)", compassText: "#3a4a68",
	axisX: "#e05b5b", axisY: "#3da35d", axisZ: "#3a7fc9"
};

let _themeCache = { at: 0, p: null };
function luminanceOf(hex) {
	try {
		const n = parseInt(hex.slice(1), 16);
		const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	} catch { return 0; }
}
/** 读取当前主题调色板（2s 缓存；首次/主题切换后自动刷新） */
function themePalette() {
	const nowMs = Date.now();
	if (_themeCache.p && nowMs - _themeCache.at < 2000) return _themeCache.p;
	let p = DARK_PALETTE;
	try {
		if (typeof document !== "undefined") {
			const cs = getComputedStyle(document.documentElement);
			const read = (n, fb) => { const v = cs.getPropertyValue(n).trim(); return v && v.startsWith("#") ? v : fb; };
			const bgBase = read("--dsw-alias-bg-base", "#0b1018");
			if (luminanceOf(bgBase) >= 0.5) p = LIGHT_PALETTE;
		}
	} catch { /* 读取失败保持深色 */ }
	_themeCache = { at: nowMs, p };
	return p;
}

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

/** 画一条 3D 空间中的环（绕 Y 轴圆环经投影），并返回环上各标记点 */
function traceRing(ctx, r, rotX, rotY, scale, fov, cx, cy, n = 60) {
	const pts = [];
	ctx.beginPath();
	for (let i = 0; i <= n; i++) {
		const th = (i / n) * Math.PI * 2;
		const p = rotate3(Math.cos(th) * r, 0, Math.sin(th) * r, rotX, rotY);
		const k = scale / (fov + p.z);
		const sx = cx + p.x * k, sy = cy - p.y * k;
		if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
		pts.push({ sx, sy, depth: fov + p.z, th });
	}
	ctx.stroke();
	return pts;
}

/**
 * v5.6 方位罗盘：右下角小型 3D 坐标轴指示器 —— 随时知道镜头朝向。
 * X=红(右) Y=绿(上) Z=蓝(前)；蓝点即「镜头正对方向」，拖拽时跟随旋转。
 */
function drawCompass(ctx, w, h, rotX, rotY, p) {
	const cxp = w - 46, cyp = h - 44, R = 17;
	ctx.save();
	ctx.globalAlpha = 0.9;
	// 底盘
	ctx.fillStyle = p.compassBg;
	ctx.beginPath();
	ctx.arc(cxp, cyp, R + 7, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = p.dark ? "rgba(120,150,210,0.4)" : "rgba(70,100,160,0.4)";
	ctx.lineWidth = 1;
	ctx.stroke();
	// 坐标轴（与主视图同旋转）
	const axes = [
		{ v: rotate3(1, 0, 0, rotX, rotY), color: p.axisX, label: "X" },
		{ v: rotate3(0, 1, 0, rotX, rotY), color: p.axisY, label: "Y" },
		{ v: rotate3(0, 0, 1, rotX, rotY), color: p.axisZ, label: "Z" }
	];
	for (const a of axes) {
		ctx.globalAlpha = 0.95;
		ctx.strokeStyle = a.color;
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		ctx.moveTo(cxp, cyp);
		ctx.lineTo(cxp + a.v.x * R, cyp - a.v.y * R);
		ctx.stroke();
	}
	// 前向标记（Z+ 蓝点 = 镜头正对方向）
	const f = rotate3(0, 0, 1, rotX, rotY);
	ctx.globalAlpha = 1;
	ctx.fillStyle = p.axisZ;
	ctx.beginPath();
	ctx.arc(cxp + f.x * R, cyp - f.y * R, 3, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = p.dark ? "#0b1220" : "#ffffff";
	ctx.lineWidth = 1;
	ctx.stroke();
	// 中心点
	ctx.fillStyle = p.compassText;
	ctx.beginPath();
	ctx.arc(cxp, cyp, 2.2, 0, Math.PI * 2);
	ctx.fill();
	// 方位文本（前/后/上/下 的当前朝向）
	const front = Math.round((((rotY % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2));
	const faces = ["前", "右", "后", "左"];
	const face = faces[front % 4];
	const pitch = rotX > 0.35 ? "下" : rotX < -0.35 ? "上" : "平视";
	ctx.globalAlpha = 0.95;
	ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.fillStyle = p.compassText;
	ctx.fillText(face + "·" + pitch, cxp, cyp + R + 14);
	ctx.textAlign = "left";
	ctx.restore();
}

// 3D 球形渲染 —— 旋转 + 透视投影 + 深度排序 + 背面衰减
// v5.4：draw 增加 anchors 参数（激活锚点集合 → 金色锚环 + 呼吸脉冲可视化工作记忆）
function draw(canvas, sim, selectedId, size, searchQuery, view, anchors) {
	if (!canvas || size.w === 0) return;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const P = themePalette(); // v5.6 主题调色板
	const anchorSet = anchors && anchors.size ? anchors : null;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const w = size.w;
	const h = size.h;
	const rotX = view.rotX ?? -0.35;
	const rotY = view.rotY ?? 0.6;
	const zoom = view.zoom || 1;
	const dragging = view.dragging ?? false;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	// 背景（主题自适应：浅色主题 → 浅色渐变背景）
	const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
	bg.addColorStop(0, P.bgTop);
	bg.addColorStop(1, P.bgBottom);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	// 点阵星空（主题化）
	ctx.fillStyle = P.grid;
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

	// —— 层级轨道：三层壳赤道环 ——
	// v5.6：轨道环上带「卫星标记点」—— 环随球体旋转时标记点明显移动，
	// 让「球在转」可感知（解决主体变化不明显/看不出在动的问题）
	const SHELLS = [
		{ r: 0.08, label: "核心 · 中枢" },
		{ r: 0.34, label: "工作区 · 项目" },
		{ r: 0.78, label: "衍生 · 记忆" }
	];
	ctx.lineWidth = 1;
	SHELLS.forEach((sh, idx) => {
		ctx.strokeStyle = P.shell[idx];
		const ringPts = traceRing(ctx, sh.r, rotX, rotY, scale, fov, cx, cy);
		// 卫星标记点：环上 3 个均匀分布的点，随旋转移动（方位参照）
		ctx.fillStyle = P.shellSat[idx];
		for (const mk of [0.33, 0.66, 0.99]) {
			const m = ringPts[Math.floor(mk * (ringPts.length - 1))];
			if (!m || m.depth < 0.25) continue; // 背面的标记点不画（避免视觉歧义）
			const sz = idx === 0 ? 2 : 2.5;
			ctx.beginPath();
			ctx.arc(m.sx, m.sy, sz, 0, Math.PI * 2);
			ctx.fill();
		}
	});
	// 层标签（左上角固定，主题化）
	ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
	ctx.textBaseline = "top";
	SHELLS.forEach((sh, i) => {
		const ly = 30 + i * 18;
		ctx.fillStyle = P.labelBg;
		ctx.fillRect(10, ly - 1, 142, 17);
		ctx.fillStyle = P.shell[i];
		ctx.fillText(sh.label, 15, ly);
	});
	ctx.textBaseline = "alphabetic";

	// —— 透视地平线网格（y=-1.55 平面，随球体旋转）—— v5.6 增强：透明度提升 + 交点小点 ——
	const FLOOR_Y = -1.55, FLOOR_HALF = 2.2, GRID_N = 6;
	const proj3 = (v) => { const dd = fov + v.z; if (dd < 0.25) return null; return { x: cx + v.x * (scale / dd), y: cy - v.y * (scale / dd) }; };
	ctx.lineWidth = 1;
	ctx.strokeStyle = P.floor;
	for (let i = 0; i <= GRID_N; i++) {
		const t = -1 + (2 * i) / GRID_N;
		const p1 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, -FLOOR_HALF, rotX, rotY));
		const p2 = proj3(rotate3(t * FLOOR_HALF, FLOOR_Y, FLOOR_HALF, rotX, rotY));
		const p3 = proj3(rotate3(-FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		const p4 = proj3(rotate3(FLOOR_HALF, FLOOR_Y, t * FLOOR_HALF, rotX, rotY));
		if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
		if (p3 && p4) { ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke(); }
	}
	// 网格交点小点（v5.6：让网格运动更可感知）
	ctx.fillStyle = P.floorDot;
	for (let i = 0; i <= GRID_N; i += 2) {
		for (let j = 0; j <= GRID_N; j += 2) {
			const pv = proj3(rotate3(-1 + (2 * i) / GRID_N * FLOOR_HALF, FLOOR_Y, -1 + (2 * j) / GRID_N * FLOOR_HALF, rotX, rotY));
			if (pv) { ctx.fillRect(pv.x - 1, pv.y - 1, 2, 2); }
		}
	}

	// —— 连接（真实突触权重；按连接原因着色；悬停/选中边标注原因+权重）——
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
		const lwScale = Math.min(2.2, Math.max(0.6, zoom));
		if (isFocusEdge) {
			ctx.strokeStyle = "rgba(255,255,255," + Math.min(0.96, (0.6 + e.weight * 0.4) * back).toFixed(3) + ")";
			ctx.lineWidth = (1.8 + e.weight * 2.2) * lwScale;
			ctx.shadowColor = reason.color;
			ctx.shadowBlur = 9 * Math.min(1.6, zoom);
		} else {
			ctx.strokeStyle = hexA(reason.color, (0.06 + e.weight * 0.20) * ad * back);
			ctx.lineWidth = (0.4 + e.weight * 0.8) * lwScale;
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
		// 连接原因标注（主题化标签底）
		if (isFocusEdge) {
			const mx = (pa.sx + pb.sx) / 2;
			const my = (pa.sy + pb.sy) / 2;
			const label = reason.label + " · " + e.weight.toFixed(2);
			ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(label).width;
			const bx = Math.min(w - tw - 10, Math.max(6, mx - tw / 2));
			const byy = Math.max(18, my - 8);
			ctx.fillStyle = P.labelBg;
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
		const base = (p.k / (scale / fov)) * zoom;
		// v5.5：节点半径已在 sim 端按 强度×连接度×层级 综合计算，此处不再重复放大
		const r = Math.max(1.5, node.r * base);
		const highlighted = isHighlighted(node.id);
		const isSelected = node.id === selectedId;
		const glow = isSelected ? 12 + node.energy * 14
			: highlighted ? 8 + node.energy * 10
			: 1.5 + node.energy * 4;
		ctx.shadowColor = isSelected ? "#ffffff" : (highlighted ? "#aaddff" : node.color);
		ctx.shadowBlur = glow;
		ctx.globalAlpha = (0.55 + node.strength * 0.45) * d * back;
		if (node.type === "workdir") {
			// v5.7 工作区目录：真正 3D 立方体 —— 8 顶点旋转投影 + 面深度排序 + 明暗面，
			// 旋转时有体积感（此前是 2D 扁平圆角矩形，看起来像贴图）
			ctx.globalAlpha = 1; // 面的透明度由 hexA 控制（避免与 globalAlpha 双重叠加）
			const hs = (r / Math.max(1e-6, p.k)) * 0.95; // 世界半边长（把屏幕半径换算回世界单位）
			const V = [
				[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
				[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
			];
			const corners = [];
			for (const [sx, sy, sz] of V) {
				const wv = rotate3(node.x + sx * hs, node.y + sy * hs, node.z + sz * hs, rotX, rotY);
				const dd = fov + wv.z;
				const kk = scale / dd;
				corners.push({ x: cx + wv.x * kk, y: cy - wv.y * kk, depth: dd });
			}
			const faces = [
				{ idx: [0, 1, 2, 3], c: shade(node.color, 60) },   // z- 主面
				{ idx: [4, 7, 6, 5], c: shade(node.color, -20) },  // z+ 背面
				{ idx: [0, 1, 5, 4], c: shade(node.color, -50) },  // y- 底面
				{ idx: [3, 2, 6, 7], c: shade(node.color, 30) },   // y+ 顶面
				{ idx: [0, 3, 7, 4], c: shade(node.color, -60) },  // x- 左面
				{ idx: [1, 2, 6, 5], c: shade(node.color, 10) }    // x+ 右面
			];
			faces.forEach((f) => { f.depth = f.idx.reduce((s, vi) => s + corners[vi].depth, 0) / 4; });
			faces.sort((a, b) => a.depth - b.depth); // 画家算法：远 → 近
			for (const f of faces) {
				ctx.fillStyle = hexA(f.c, 0.88 * back);
				ctx.beginPath();
				f.idx.forEach((vi, i) => { i ? ctx.lineTo(corners[vi].x, corners[vi].y) : ctx.moveTo(corners[vi].x, corners[vi].y); });
				ctx.closePath();
				ctx.fill();
				ctx.strokeStyle = "rgba(255,255,255," + (0.14 * back).toFixed(2) + ")";
				ctx.lineWidth = 0.7;
				ctx.stroke();
			}
			// 顶面高光角点（增强体积感）
			const topIdx = [3, 2, 6, 7];
			ctx.fillStyle = "rgba(255,255,255," + (0.18 * back).toFixed(2) + ")";
			ctx.beginPath();
			topIdx.forEach((vi, i) => { i ? ctx.lineTo(corners[vi].x, corners[vi].y) : ctx.moveTo(corners[vi].x, corners[vi].y); });
			ctx.closePath();
			ctx.fill();
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
		// 搜索命中环（主题化）
		const isHit = sr ? sr.hits.has(node.id) : !!(q && lexScore(node, q) > 0);
		if (isHit && !highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = P.hitRing;
			ctx.lineWidth = 1.1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// 选中/关联节点高亮环（主题化）
		if (highlighted) {
			ctx.shadowBlur = 0;
			ctx.strokeStyle = isSelected
				? P.selRing
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
		// 标签：仅聚焦（选中）节点显示名称并放大（主题化标签底）
		if (isSelected) {
			ctx.font = "bold 16px ui-sans-serif, system-ui, sans-serif";
			const tw = ctx.measureText(node.title).width;
			const tx = Math.min(w - tw - 6, Math.max(6, p.sx - tw / 2));
			const ty = Math.max(18, p.sy - r - 15);
			ctx.fillStyle = P.labelBg;
			ctx.fillRect(tx - 6, ty - 14, tw + 12, 20);
			ctx.fillStyle = P.labelText;
			ctx.fillText(node.title, tx, ty);
		} else if (node.id === sim.hover && !highlighted) {
			// 悬停反馈：仅细光环（主题化）
			ctx.shadowBlur = 0;
			ctx.strokeStyle = P.hoverRing;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r + 2, 0, Math.PI * 2);
			ctx.stroke();
		}
		// v5.4 激活锚点：金色锚环 + 呼吸脉冲
		if (anchorSet && anchorSet.has(node.id) && !highlighted) {
			const breath = 0.5 + 0.5 * Math.sin(sim.t * 0.05 + (hash01(node.id) * 6.28));
			const ar = r + 7 + breath * 2;
			ctx.shadowBlur = 0;
			ctx.strokeStyle = "rgba(255,212,121," + (0.30 + breath * 0.35).toFixed(2) + ")";
			ctx.lineWidth = 1.4;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, ar, 0, Math.PI * 2);
			ctx.stroke();
			ctx.strokeStyle = "rgba(255,212,121," + (0.16 + breath * 0.2).toFixed(2) + ")";
			ctx.setLineDash([2, 3]);
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, ar + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		// v5.5 联想交汇节点标识：紫色星标
		if (node.title && node.title.startsWith("⟡") && !highlighted && !anchorSet?.has(node.id)) {
			const tw = ctx.measureText("⟡").width;
			ctx.shadowBlur = 0;
			ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
			ctx.fillStyle = "rgba(186,104,200," + (0.55 + node.energy * 0.35).toFixed(2) + ")";
			ctx.fillText("⟡", p.sx - tw / 2, p.sy - r - 6);
			ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
		}
	}

	// v5.6 方位罗盘：右下角，随时知道镜头朝向（前/后/左/右 + 上/下/平视）
	drawCompass(ctx, w, h, rotX, rotY, P);
}

// 字符串哈希（锚点呼吸相位用，与 sim.js 同构）
function hash01(str) {
	let x = 0;
	for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
	return x / 4294967296;
}

exports.draw = draw;
