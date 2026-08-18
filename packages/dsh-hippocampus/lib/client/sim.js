// 3D 仿真与数学：坐标、旋转、透视投影、搜索相关度
const { KIND_COLORS } = require("./constants.js");

function hashOf(str) {
	let x = 0;
	for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
	return x / 4294967296;
}

// 3D 球形神经网络：宿主端给出三维理想坐标 x0/y0/z0（归一化 -1..1），
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
			// v5.7 节点大小分层（收敛版）：综合 强度 + 连接度 + 层级 ——
			// 中枢节点略大、分支更小，但整体不再挤占（v5.5 公式导致核心/工作区过大重叠）
			//   rStrength: 强度 0.5~1.1（越牢固略大）
			//   rDegree:   连接度 1 + min(0.7, log2(1+degree)*0.10)（最多 ~1.7×，温和）
			//   rLayer:    核心 1.10 / 工作区 1.0 / 衍生 0.66 / 其它 0.85
			r: 3.8 * (0.5 + (node.strength ?? 0.5) * 0.6)
				* (1 + Math.min(0.7, Math.log2(1 + (node.degree ?? 0)) * 0.10))
				* (node.type === "core" ? 1.10 : node.type === "workdir" ? 1.0 : node.type === "leaf" ? 0.66 : 0.85),
			// 节点初始能量 = 真实激活强度（而非随机值），画布亮度/光晕始终反映真实 strength
			energy: old?.energy ?? node.activation ?? node.strength ?? 0,
			// v5.2：能量基线 = 真实强度 —— 非搜索态能量收敛回基线，不再衰减到全黑
			base: node.activation ?? node.strength ?? 0.4,
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
		hoverEdge: null,
		mouse: prev?.mouse ?? { x: -9999, y: -9999, inside: false },
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

exports.hashOf = hashOf;
exports.buildSim = buildSim;
exports.rotate3 = rotate3;
exports.lexScore = lexScore;
