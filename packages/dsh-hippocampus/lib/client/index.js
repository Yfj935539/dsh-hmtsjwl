// 插件入口：注册词典 / 挂载 Remote / 注入「记忆」标签页
const { zh, en } = require("./i18n.js");
const { CONTRIBUTION } = require("./remote.js");
const { MemoryView, prefetchMemory } = require("./view.js");
const { injectStyles } = require("./styles.js");

const NS = "hippocampus";

// 样式在插件装载时注入一次
injectStyles();

const inject = ["slots", "locale", "remote"];

async function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "hippocampus: dictionaries");
	const t = ctx.locale.bind(NS);
	const remote = ctx.get("remote");
	await remote.$mount(CONTRIBUTION);
	// 与轨迹/对话一致：预加载记忆数据，点开标签页直接展示
	prefetchMemory(ctx);
	ctx.slots.inject("conversation.view", () => ctx.slots.register({
		name: "conversation.view",
		id: "hippocampus",
		order: 20,
		locale: NS,
		label: () => t("view.memory"),
		inject: (sessionId) => ({ __ctx: ctx, sessionId })
	}, MemoryView));
}

exports.inject = inject;
exports.apply = apply;
