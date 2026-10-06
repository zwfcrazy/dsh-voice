//#region src/tools.ts
const name = "dsh-voice-tools";
const inject = ["tools", "systemPrompt"];
const ENGINE_WS = "ws://127.0.0.1:8076";
/** resolve+import(URL) 装载 defineTool（锚点与 dsh-voice importCompactionBasic 一致）。 */
async function loadDefineTool() {
	const { createRequire } = await import("node:module");
	const { pathToFileURL } = await import("node:url");
	const os = await import("node:os");
	const anchors = [
		"/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/index.js",
		os.homedir() + "/.dsh/profiles/node_modules/index.js",
		os.homedir() + "/.dsh/profiles/web/index.js"
	];
	const req0 = createRequire(import.meta.url);
	let path;
	try {
		path = req0.resolve("@deepseek-ai/dsh-tools");
	} catch {}
	for (const a of anchors) {
		if (path !== void 0) break;
		try {
			path = createRequire(a).resolve("@deepseek-ai/dsh-tools");
		} catch {}
	}
	if (path === void 0) throw new Error("找不到 @deepseek-ai/dsh-tools（包旁/部署/profile 均未命中）");
	return (await import(pathToFileURL(path).href)).defineTool;
}
/** daemon 短连 RPC：跳过状态广播，只收匹配 id 的回复。 */
function daemonRpc(method, params, timeoutMs = 5e3) {
	return new Promise((resolve, reject) => {
		let ws;
		try {
			ws = new WebSocket(ENGINE_WS);
		} catch (e) {
			reject(e);
			return;
		}
		let settled = false;
		const finish = (fn) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {}
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(/* @__PURE__ */ new Error("daemon RPC 超时(" + method + ")"))), timeoutMs);
		ws.onopen = () => {
			try {
				ws.send(JSON.stringify({
					id: 1,
					method,
					params
				}));
			} catch (e) {
				finish(() => reject(e));
			}
		};
		ws.onmessage = (ev) => {
			try {
				const m = JSON.parse(String(ev.data));
				if (m && m.id === 1) finish(() => resolve(m));
			} catch {}
		};
		ws.onerror = () => finish(() => reject(/* @__PURE__ */ new Error("daemon WS 连接失败（语音引擎不在线？）")));
		ws.onclose = () => finish(() => reject(/* @__PURE__ */ new Error("daemon WS 连接中断")));
	});
}
async function apply(ctx) {
	const defineTool = await loadDefineTool();
	ctx.systemPrompt.section({
		name: "tool:voice_volume",
		order: 111,
		text: "Use the voice_volume tool when the user asks to change or check this assistant's speaking volume (e.g. 大声一点/小声一点/音量调到百分之六十/现在音量多少). Omit percent to query the current volume; for relative requests (大一点/小一点), query first, then set the computed absolute percent."
	});
	ctx.tools.register(defineTool({
		name: "voice_volume",
		description: "调节或查询语音助手自己的播报音量（丁满说话的响度，不影响其他设备声音）。用户提出音量相关请求时调用。",
		parameters: { percent: {
			type: "number",
			description: "目标音量百分比（5–150，100 为正常）。省略则只查询当前音量。相对调整请先查询再换算成绝对百分比。"
		} },
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{
					type: "text",
					text: String(value)
				}];
			}
		},
		async execute(args) {
			const pct = args?.percent;
			if (pct === void 0 || pct === null) {
				const r = await daemonRpc("config/get", {});
				const v = r?.result?.config?.["tts.volume"]?.value;
				if (typeof v !== "number") return "查询失败：语音引擎未返回音量（" + JSON.stringify(r).slice(0, 120) + "）";
				return "当前播报音量：" + Math.round(v * 100) + "%";
			}
			const p = Math.max(5, Math.min(150, Math.round(Number(pct))));
			if (!Number.isFinite(p)) return "音量数值无效";
			const r = await daemonRpc("config/set", { updates: { "tts.volume": p / 100 } });
			if ((r?.result?.ok ?? r?.ok) !== true) {
				const errs = r?.result?.errors ?? r;
				return "音量调整失败：" + JSON.stringify(errs).slice(0, 200);
			}
			return "播报音量已调到 " + p + "%（立即生效，已记住）";
		}
	}));
}
//#endregion
export { apply, inject, name };
