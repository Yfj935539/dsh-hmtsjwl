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
			// v5.5 节点大小分层：综合 强度 + 连接度 + 层级 —— 重要节点显著更大，
			// 分支/弱记忆明显更小，一眼分辨「中枢/分支」
			//   rStrength: 强度 0.55~1.30（越牢固越大）
			//   rDegree:   连接度 1 + log2(1+degree)*0.16（中枢节点更大，最多 ~2.4×）
			//   rLayer:    核心 1.30 / 工作区 1.18 / 衍生 0.78 / 其它 1.0
			r: 5 * (0.55 + (node.strength ?? 0.5) * 0.75)
				* (1 + Math.log2(1 + (node.degree ?? 0)) * 0.16)
				* (node.type === "core" ? 1.30 : node.type === "workdir" ? 1.18 : node.type === "leaf" ? 0.78 : 1.0),
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
