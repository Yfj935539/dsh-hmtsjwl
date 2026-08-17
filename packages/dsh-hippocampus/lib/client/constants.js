// 视觉常量：节点颜色 / 记忆种类 / 连接原因（图例与着色共用）
const KIND_COLORS = {
	preference: "#4fc3f7",
	communication: "#ffb74d",
	workstate: "#81c784",
	insight: "#ba68c8",
	other: "#90a4ae",
	workdir: "#ffd479"
};

const KINDS = ["preference", "communication", "workstate", "insight", "other"];

// 连接含义（颜色 = 原因，用于连线着色与图例）
const REASONS = [
	{ label: "永久锚定", color: "#ffd479" },
	{ label: "项目归属", color: "#ffb74d" },
	{ label: "核心协同", color: "#4fc3f7" },
	{ label: "核心关联", color: "#7fa8ff" },
	{ label: "同项目", color: "#81c784" },
	{ label: "语义相似", color: "#ba68c8" }
];

exports.KIND_COLORS = KIND_COLORS;
exports.KINDS = KINDS;
exports.REASONS = REASONS;
