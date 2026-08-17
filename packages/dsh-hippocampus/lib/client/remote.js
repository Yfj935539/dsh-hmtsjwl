// Remote 契约：与宿主端 HippocampusService 的 src 方法一一对应
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
		D("analyze", [P("request")], "analyze"),
		D("drill", [P("request")], "drill"),
		D("context", [P("request")], "context"),
		D("feed", [P("request")], "feed"),
		D("optimize", [P("request")], "optimize"),
		D("resolveProject", [P("request")], "resolveProject"),
		D("archiveWorkdir", [P("request")], "archiveWorkdir"),
		D("reportWork", [P("request")], "reportWork"),
		D("tags", [P("request")], "tags"),
		D("tagRename", [P("request")], "tagRename"),
		D("exportAll", [P("request")], "exportAll"),
		D("importAll", [P("request")], "importAll"),
		D("reviewDue", [P("request")], "reviewDue"),
	D("review", [P("request")], "review"),
	D("timeline", [P("request")], "timeline"),
	D("linkManual", [P("request")], "linkManual"),
	D("linksOf", [P("request")], "linksOf"),
	D("unlinkManual", [P("request")], "unlinkManual"),
	D("evolog", [P("request")], "evolog"),
	D("injectLog", [P("request")], "injectLog")
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

exports.CONTRIBUTION = CONTRIBUTION;
exports.remoteCall = remoteCall;
