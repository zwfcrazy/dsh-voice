import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
//#region src/paths.ts
/**
* dsh-voice 路径解析（P7d 打包形态）
*
* - PKG_ROOT：包根（本文件构建后位于 lib/，上溯一级）。link: 与 github: 安装
*   均成立——模块永远从 <pkg>/lib/index.js 加载。
* - VOICE_HOME：数据根（config/models/assets/logs/.venv），env 可覆盖，
*   默认 ~/.dsh/voice。与 Python 侧 voice/config.py 的 REPO_ROOT 语义对齐。
* - 引擎启动/bootstrap 脚本随包分发（python/scripts/），与数据根解耦。
*/
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOICE_HOME = process.env.VOICE_HOME || path.join(os.homedir(), ".dsh", "voice");
const ENGINE_SCRIPT = path.join(PKG_ROOT, "python", "scripts", "daemon-start.sh");
const BOOTSTRAP_SCRIPT = path.join(PKG_ROOT, "python", "scripts", "setup-voice.sh");
const VOICE_LOG = path.join(VOICE_HOME, "logs", "voice.log");
const BOOTSTRAP_LOG = path.join(VOICE_HOME, "logs", "bootstrap.log");
const CONTEXT_CFG = path.join(VOICE_HOME, "config", "voice-context.json");
const ARCHIVE_ROOT = path.join(VOICE_HOME, "logs", "session-archive");
/** venv 就绪判定（bootstrap 完成的标志） */
function venvReady() {
	return fs.existsSync(path.join(VOICE_HOME, ".venv", "bin", "python"));
}
/** 首次使用/日志写入前保证数据目录骨架存在（幂等） */
function ensureVoiceHome() {
	fs.mkdirSync(path.join(VOICE_HOME, "logs"), { recursive: true });
	fs.mkdirSync(path.join(VOICE_HOME, "config"), { recursive: true });
}
/** bootstrap 重试冷却：避免宿主 30s 周期探活把失败的 pip 安排成重试风暴 */
const BOOTSTRAP_COOLDOWN_MS = 6e5;
function bootstrapCooldownOk() {
	const marker = path.join(VOICE_HOME, ".bootstrap-last-attempt");
	try {
		const st = fs.statSync(marker);
		return Date.now() - st.mtimeMs > BOOTSTRAP_COOLDOWN_MS;
	} catch {
		return true;
	}
}
function markBootstrapAttempt() {
	try {
		ensureVoiceHome();
		fs.writeFileSync(markerPath(), String(Date.now()) + "\n");
	} catch (e) {
		console.error("dsh-voice: 写 bootstrap 标记失败", e);
	}
}
function markerPath() {
	return path.join(VOICE_HOME, ".bootstrap-last-attempt");
}
//#endregion
//#region src/agentStore.ts
const PRESET_ID = "jarvis-voice";
const AGENTS_CFG = VOICE_HOME + "/config/voice-agents.json";
const SEED_PROMPT = [
	"你是丁满，一个语音助手，性格机灵热心，像个小伙伴。",
	"说话方式：口语化短句，一次只说重点，不用书面语；默认中文。",
	"职责：日常对话、问答、提醒；做不到的坦率说明。"
].join("\n");
const SEED_RULES = [
	"你的回复将被直接转成语音朗读，因此：",
	"1. 只输出适合朗读的纯文本；不要 markdown 符号（*、#、-、`）、emoji、代码块、列表编号。",
	"2. 数字和算式按中文口语写：乘号写「乘以」，结果写阿拉伯数字，例如「1234 乘以 1234 等于 1522756」；不要在数字之间加空格或符号分隔。",
	"3. 网址、文件名等无法朗读的内容，除非用户要求，否则不要念出来。",
	"4. 句子短，一句话一个信息点。",
	"5. 不要使用任何无法转换为语音的输出方式，如选项卡片、沙箱权限询问等。"
].join("\n");
const now = () => Date.now();
function defaultTools() {
	return {
		webSearch: true,
		voiceTools: true
	};
}
/** 激活 Agent 的工具集（preset 模板的数据源；缺失兜底全开）。 */
function activeTools(store) {
	return (store?.agents.find((x) => x.id === store.active))?.tools ?? defaultTools();
}
/** 激活 Agent 的模型选型（null = 跟随部署默认）。 */
function activeModel(store) {
	const m = (store?.agents.find((x) => x.id === store.active))?.model;
	return m && m.provider && m.model ? m : null;
}
/** AgentModelCfg → installModelSelection 的 selection 形状（effort 空=不指定）。 */
function modelSelectionOf(m) {
	if (m === null) return void 0;
	return {
		provider: m.provider,
		model: m.model,
		...m.effort ? { reasoningEffort: m.effort } : {}
	};
}
function seedStore() {
	return {
		version: 1,
		active: "dingman",
		common: { outputRules: SEED_RULES },
		agents: [{
			id: "dingman",
			name: "丁满",
			prompt: SEED_PROMPT,
			tts: {
				preset: "qa-jielidou",
				voice: ""
			},
			createdAt: now(),
			updatedAt: now()
		}]
	};
}
const voiceOk = (v) => typeof v === "string" && (v === "" || v.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(v));
const idOk = (v) => typeof v === "string" && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_.:\-]+$/.test(v);
const effortOk = (v) => typeof v === "string" && v.length >= 1 && v.length <= 16 && /^[a-z]+$/.test(v);
function validateModelCfg(input) {
	if (input === null || input === void 0) return { model: null };
	if (typeof input !== "object") return { error: "模型配置无效" };
	const provider = String(input.provider ?? "").trim();
	const model = String(input.model ?? "").trim();
	const effort = String(input.effort ?? "").trim();
	if (provider === "" && model === "" && effort === "") return { model: null };
	if (!idOk(provider) || !idOk(model)) return { error: "模型 provider/model 需为 ≤64 位合法 id" };
	if (effort !== "" && !effortOk(effort)) return { error: "思考强度档位无效" };
	return { model: {
		provider,
		model,
		...effort ? { effort } : {}
	} };
}
function validateAgent(input) {
	if (input === null || typeof input !== "object") return { error: "agent 无效" };
	const name = String(input.name ?? "").trim();
	const prompt = String(input.prompt ?? "").trim();
	const preset = String(input.tts?.preset ?? "").trim();
	const voice = String(input.tts?.voice ?? "").trim();
	if (name.length < 1 || name.length > 32) return { error: "名称需 1–32 字" };
	if (prompt.length < 1 || prompt.length > 8e3) return { error: "提示词需 1–8000 字" };
	if (!preset) return { error: "音色预设不能为空" };
	if (!voiceOk(voice)) return { error: "自定义音色 id 需为 ≤64 位字母数字_.-" };
	const t = input.tools;
	const tools = {
		webSearch: t?.webSearch !== false,
		voiceTools: t?.voiceTools !== false
	};
	const mv = validateModelCfg(input.model);
	if (mv.error !== void 0) return { error: mv.error };
	return { agent: {
		id: typeof input.id === "string" && input.id ? input.id : "ag-" + now().toString(36),
		name,
		prompt,
		tts: {
			preset,
			voice
		},
		tools,
		model: mv.model ?? null,
		createdAt: Number(input.createdAt) || now(),
		updatedAt: now()
	} };
}
function validateRules(rules) {
	const s = String(rules ?? "").trim();
	if (s.length < 1 || s.length > 4e3) return { error: "输出规则需 1–4000 字" };
	return { rules: s };
}
async function loadAgentsStore() {
	const fs = await import("node:fs/promises");
	try {
		const store = normalize(JSON.parse(await fs.readFile(AGENTS_CFG, "utf-8")));
		if (store.agents.length === 0 || !store.agents.some((a) => a.id === store.active)) return {
			store: seedStore(),
			warn: "voice-agents.json 无有效 Agent，已回落种子配置（原文件保留未覆盖）"
		};
		return {
			store,
			warn: ""
		};
	} catch (e) {
		if (e && e.code === "ENOENT") {
			const seed = seedStore();
			try {
				await saveAgentsStore(seed);
			} catch (e2) {}
			return {
				store: seed,
				warn: ""
			};
		}
		return {
			store: seedStore(),
			warn: "voice-agents.json 读取失败，用种子配置（原文件保留未覆盖）：" + String(e && e.message || e)
		};
	}
}
function normalize(raw) {
	const agents = Array.isArray(raw?.agents) ? raw.agents.map((a) => validateAgent(a).agent).filter((a) => a !== void 0) : [];
	return {
		version: 1,
		active: typeof raw?.active === "string" && agents.some((a) => a.id === raw.active) ? raw.active : agents[0]?.id ?? "",
		common: { outputRules: typeof raw?.common?.outputRules === "string" && raw.common.outputRules.trim() ? raw.common.outputRules : SEED_RULES },
		agents
	};
}
async function saveAgentsStore(store) {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	await fs.mkdir(path.dirname(AGENTS_CFG), { recursive: true });
	await fs.writeFile(AGENTS_CFG, JSON.stringify(store, null, 2) + "\n", "utf-8");
}
function personaText(store) {
	return ((store?.agents.find((x) => x.id === store.active))?.prompt ?? SEED_PROMPT).trim();
}
function rulesText(store) {
	const r = store?.common?.outputRules;
	return (r && r.trim() ? r : SEED_RULES).trim();
}
function activeAgentName(store) {
	return (store?.agents.find((x) => x.id === store.active))?.name ?? "（未配置）";
}
function compositionYml(t) {
	return [
		"# jarvis-voice preset（dsh-voice 插件托管生成；P7b 2026-09-20 人设，P7c 2026-09-25 工具行）。",
		"# 两层工具：①全局缝 web_search（Tavily 后端，人人可用）②丁满私有 dsh-voice/tools（仅语音会话）。",
		"# 开关经面板「工具」页（config/voice-tools.json）→ 本模板动态生成 disabled 行。",
		"# bash 类工具刻意不加：语音无人值守场景没有审批通道（plans/phase-7 P7-4）。",
		"# （注意：preset 结构性修改只影响之后新建的会话，届时需归档重建 jarvis-voice）。",
		"- id: persona",
		"  name: '@deepseek-ai/dsh-persona'",
		"  config:",
		"    text: \"{{voice_persona}}\\n\\n{{voice_output_rules}}\"",
		"- id: tool-web",
		"  name: '@deepseek-ai/dsh-tool-web'",
		...t.webSearch ? [] : ["  disabled: true"],
		"  config:",
		"    fetch: false",
		"    searchTimeoutMs: 60000",
		"- id: tool-voice",
		"  name: 'dsh-voice/tools'",
		...t.voiceTools ? [] : ["  disabled: true"],
		""
	].join("\n");
}
const PRESET_NAME = "丁满语音助手";
const PRESET_DESC = "jarvis-voice 会话人设；文本经 voice_persona/voice_output_rules 提示词变量按轮注入，面板 Agent 页可切换。";
const PRESET_META_YML = [
	"name: " + PRESET_NAME,
	"description: " + PRESET_DESC,
	""
].join("\n");
/** 0.2 硬迁移点 1（2026-10-06）：composition 行的 JS 形态 = 0.2
* PresetDefinition.plugins（Omit<EntryOptions,'id'|'disabled'> & {id?, disabled?}）。
* 与 compositionYml 逐行同源同语义（persona / tool-web / tool-voice），文件
* 通道仅为 0.1 回落。config 值里是真实换行（YAML 通道靠 \\n 转义达成）。 */
function compositionRows(t) {
	return [
		{
			id: "persona",
			name: "@deepseek-ai/dsh-persona",
			config: { prefix: "{{voice_persona}}\n\n{{voice_output_rules}}" }
		},
		{
			id: "tool-web",
			name: "@deepseek-ai/dsh-tool-web",
			...t.webSearch ? {} : { disabled: true },
			config: {
				fetch: false,
				searchTimeoutMs: 6e4
			}
		},
		{
			id: "tool-voice",
			name: "dsh-voice/tools",
			...t.voiceTools ? {} : { disabled: true }
		}
	];
}
let presetDispose;
let firstSync;
function waitForPresetSync(ms = 2e3) {
	if (firstSync === void 0) return Promise.resolve();
	return Promise.race([firstSync, new Promise((r) => setTimeout(r, ms))]);
}
async function syncVoicePreset(registry) {
	const run = (async () => {
		if (registry !== void 0 && typeof registry.register === "function") try {
			if (presetDispose !== void 0) try {
				await presetDispose();
			} catch {}
			presetDispose = await registry.register({
				id: PRESET_ID,
				name: PRESET_NAME,
				description: PRESET_DESC,
				plugins: compositionRows(activeTools((await loadAgentsStore()).store))
			});
			return {
				ok: true,
				wrote: true,
				mode: "register"
			};
		} catch (e) {
			return {
				ok: false,
				error: String(e && e.message || e),
				wrote: false,
				mode: "register"
			};
		}
		return {
			...await ensureVoicePresetFiles(),
			mode: "file"
		};
	})();
	if (firstSync === void 0) firstSync = run.then(() => void 0, () => void 0);
	return run;
}
/** 插件卸载时释放已注册定义（fire-and-forget：host 停机进程即逝）。 */
function disposeVoicePreset() {
	if (presetDispose !== void 0) {
		const d = presetDispose;
		presetDispose = void 0;
		d().catch(() => {});
	}
}
async function ensureVoicePresetFiles() {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const os = await import("node:os");
	try {
		const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
		const dir = path.join(home, ".agent-presets", PRESET_ID);
		await fs.mkdir(dir, { recursive: true });
		const composition = compositionYml(activeTools((await loadAgentsStore()).store));
		let wrote = false;
		const comp = path.join(dir, "agent.cordis.yml");
		if (await fs.readFile(comp, "utf-8").then((t) => t !== composition, () => true)) {
			await fs.writeFile(comp, composition, "utf-8");
			wrote = true;
		}
		const meta = path.join(dir, "preset.yml");
		if (await fs.readFile(meta, "utf-8").then((t) => t !== PRESET_META_YML, () => true)) {
			await fs.writeFile(meta, PRESET_META_YML, "utf-8");
			wrote = true;
		}
		return {
			ok: true,
			wrote
		};
	} catch (e) {
		return {
			ok: false,
			error: String(e && e.message || e),
			wrote: false
		};
	}
}
async function presetBoundTo(ctx, sessionId) {
	try {
		const persistence = ctx.get("sessionPersistence");
		if (persistence === void 0) return false;
		const headers = await persistence.list();
		const h = Array.isArray(headers) ? headers.find((x) => (x.id ?? x.header?.id) === sessionId) : void 0;
		return (h?.agentPreset ?? h?.header?.agentPreset) === PRESET_ID;
	} catch (e) {
		return false;
	}
}
//#endregion
//#region src/index.ts
const name = "dsh-voice";
const inject = [
	"timer",
	"connection",
	"webServer",
	"agents",
	"agentDefaultModel",
	"agentPresets"
];
const SESSION = "jarvis-voice";
const PREFIX = "/voice-bridge";
const ENGINE_WS = "ws://127.0.0.1:8076";
const CLEAR_PENDING = ARCHIVE_ROOT + "/CLEAR-PENDING";
let handle = void 0;
let agent = void 0;
let sseRes = void 0;
let engineTurn = void 0;
let sentAny = false;
let agentsSvc;
let defaultModelSvc;
let presetsSvc;
let agentsStore;
let agentsWarn = "";
function uuid4() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = Math.random() * 16 | 0;
		return (ch === "x" ? r : r & 3 | 8).toString(16);
	});
}
function modelOptions() {
	try {
		const sel = defaultModelSvc !== void 0 ? defaultModelSvc.currentSelection() : void 0;
		if (sel && sel.provider && sel.model) return {
			provider: sel.provider,
			model: sel.model,
			...sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}
		};
	} catch (e) {
		console.error("agentDefaultModel 读取失败", e);
	}
}
function effectiveSelection() {
	const m = modelSelectionOf(activeModel(agentsStore));
	if (m !== void 0) return {
		source: "profile",
		...m
	};
	const d = modelOptions();
	return d === void 0 ? { source: "default" } : {
		source: "default",
		provider: d.provider,
		model: d.model,
		...d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}
	};
}
function sseAlive() {
	return sseRes !== void 0 && !sseRes.writableEnded && !sseRes.destroyed;
}
function push(msg) {
	if (!sseAlive()) return false;
	try {
		sseRes.write("data: " + JSON.stringify(msg) + "\n\n");
		return true;
	} catch (e) {
		console.error("SSE write failed", e);
		engineGone();
		return false;
	}
}
function engineGone() {
	if (sseRes !== void 0) {
		try {
			sseRes.end();
		} catch (e) {}
		sseRes = void 0;
	}
	if (agent !== void 0 && engineTurn !== void 0) try {
		agent.cancel("user");
	} catch (e) {}
	engineTurn = void 0;
}
function onSessionEvent(session, event) {
	if (session.id !== SESSION) return;
	const d = event.data || {};
	if (event.type === "request/header") {
		const c = d.header && d.header.config || {};
		if (c.provider && c.model) lastServed = {
			provider: String(c.provider),
			model: String(c.model),
			...c.reasoningEffort ? { reasoningEffort: String(c.reasoningEffort) } : {},
			at: Date.now()
		};
		return;
	}
	if (event.type === "assistant/chunk") {
		if (streamViaFrames) return;
		const c = d.chunk || {};
		if (c.type === "text-delta" && typeof c.text === "string" && c.text.length > 0) {
			if (engineTurn === void 0) {
				console.log("voice-bridge chunk 丢弃（engineTurn 未设置）:", String(c.text).slice(0, 20));
				return;
			}
			sentAny = true;
			push({
				type: "agent/chunk",
				turn: engineTurn,
				text: c.text
			});
		}
		return;
	}
	if (event.type === "tool/call") {
		if (engineTurn !== void 0 && d && typeof d.name === "string" && d.name.length > 0) push({
			type: "agent/tool",
			turn: engineTurn,
			name: d.name
		});
		return;
	}
	if (event.type === "turn/end") {
		if (engineTurn === void 0) {
			console.log("voice-bridge turn/end 丢弃（engineTurn 未设置）:", JSON.stringify(d.reason || {}));
			return;
		}
		const reason = d.reason && d.reason.kind ? d.reason.kind : "completed";
		const t = engineTurn;
		engineTurn = void 0;
		if (reason !== "completed" && !sentAny) push({
			type: "agent/error",
			turn: t,
			message: "turn " + reason
		});
		else push({
			type: "agent/turn-end",
			turn: t,
			reason
		});
		if (contextCfg !== void 0 && contextCfg.compaction && contextCfg.compaction.autoPressure) setTimeout(() => {
			pressureCompact("每轮").catch(() => {});
		}, 1500);
	}
}
const agentIds = /* @__PURE__ */ new WeakMap();
let agentSeq = 0;
function agentId(a) {
	if (!agentIds.has(a)) agentIds.set(a, ++agentSeq);
	return "#" + agentIds.get(a);
}
/** 面板展示用：最近一轮语音请求的实际出站配置（request/header 即真相）。 */
let lastServed;
/** off 档重派防重入标记（llm/stream 否决+重派路径专用）。 */
const servedStripped = /* @__PURE__ */ new WeakSet();
/** 0.2 硬迁移点 2（2026-10-06）：流式通道选择。0.2 取消 assistant/chunk 持久
* 事件（日志只落整段 assistant/message + 新 assistant/attempt），live 文本改
* 走 agent/assistant-stream 帧（agentEvents 融合派发器发布，payload 带 agent，
* 根级 {global:true} 可听，按 agent.session.id 过滤——与 P7c agent/request 同
* 机制，0.1 已实证）。首帧到达即锁定 frames，legacy assistant/chunk（0.1
* session/event 广播）随之退位——双轨只为升级瞬断与回滚兜底，绝不双推。 */
let streamViaFrames = false;
/**
* P7c v2.1（2026-10-05 深夜）：剥掉单条回放消息里的 reasoning 块。
* content 与 source.replayState.blocks 用同一谓词过滤，保持 replayedAssistant
* 的计数/类型对齐（失配也不炸——那边降级为纯文本历史，只是丢文本签名）。
*/
function stripReplayThinking(x) {
	if (!Array.isArray(x?.content) || !x.content.some((b) => b?.type === "reasoning")) return x;
	const content = x.content.filter((b) => b?.type !== "reasoning");
	const rs = x?.source?.replayState;
	const source = Array.isArray(rs?.blocks) ? {
		...x.source,
		replayState: {
			...rs,
			blocks: rs.blocks.filter((b) => b?.type !== "reasoning")
		}
	} : x.source;
	return {
		...x,
		content,
		...x.source !== void 0 ? { source } : {}
	};
}
/** 读 jarvis-voice 持久化 header 记录的 preset（我们从不换绑，header 即真相）。 */
async function sessionHeaderPreset() {
	try {
		const persistence = ctxRef.get("sessionPersistence");
		if (persistence === void 0) return void 0;
		const headers = await persistence.list();
		const h = Array.isArray(headers) ? headers.find((x) => (x.id ?? x.header?.id) === SESSION) : void 0;
		return h?.agentPreset ?? h?.header?.agentPreset;
	} catch (e) {
		return;
	}
}
async function ensureAgent() {
	if (agentsSvc === void 0) throw new Error("agents 服务不可用");
	const opts = modelOptions();
	const live = agentsSvc.get(SESSION);
	if (live !== void 0 && live !== agent) {
		console.log("voice-bridge agent 实例已换载:", agentId(live));
		agent = live;
		return agent;
	}
	if (live !== void 0) return live;
	if (agent !== void 0) return agent;
	let mountPreset = false;
	if (presetsSvc !== void 0) {
		if (typeof presetsSvc.register === "function") await waitForPresetSync(2e3);
		if (await sessionHeaderPreset() === "jarvis-voice") {
			mountPreset = true;
			console.log("voice-bridge resume 将挂载人设 preset:", PRESET_ID);
		}
	}
	try {
		handle = await agentsSvc.resume({
			resumeSessionId: SESSION,
			agentOptions: opts,
			...mountPreset && presetsSvc !== void 0 ? { setup: async (agentCtx) => {
				await presetsSvc.mount(agentCtx, PRESET_ID);
			} } : {}
		});
	} catch (e) {
		console.log("voice-bridge resume 带挂载失败，降级裸 resume 保语音:", e?.message || e);
		try {
			handle = await agentsSvc.resume({
				resumeSessionId: SESSION,
				agentOptions: opts
			});
		} catch (e2) {
			handle = await agentsSvc.create({
				sessionId: SESSION,
				meta: {
					cwd: VOICE_HOME,
					agentPreset: PRESET_ID
				},
				agentOptions: opts,
				...presetsSvc !== void 0 ? { setup: async (agentCtx) => {
					await presetsSvc.mount(agentCtx, PRESET_ID);
				} } : {}
			});
		}
	}
	agent = handle.agent;
	console.log("voice-bridge 会话就绪:", SESSION);
	return agent;
}
async function ensureStoreLoaded() {
	if (agentsStore === void 0) {
		const r = await loadAgentsStore();
		agentsStore = r.store;
		agentsWarn = r.warn;
	}
	return agentsStore;
}
const badRequest = (msg) => ({
	ok: false,
	error: {
		code: "bad-request",
		message: msg,
		details: { issues: [] }
	}
});
async function onEvent(msg) {
	const t = msg && msg.type;
	if (t === "agent/request") {
		const a = await ensureAgent();
		engineTurn = msg.turn;
		sentAny = false;
		console.log("voice-bridge agent/request turn=" + msg.turn + " agent=" + agentId(a) + " sse=" + sseAlive());
		a.followup({
			id: uuid4(),
			role: "user",
			content: [{
				type: "text",
				text: String(msg.text || "")
			}],
			source: { kind: "user" }
		});
		return { ok: true };
	}
	if (t === "agent/cancel") {
		if (agent !== void 0) try {
			agent.cancel("user");
		} catch (e) {}
		if (msg.turn !== void 0 && msg.turn === engineTurn) engineTurn = void 0;
		return { ok: true };
	}
	if (t === "bridge/ping") return {
		ok: true,
		alive: true,
		session: SESSION
	};
	return {
		ok: false,
		error: "unknown-type:" + String(t)
	};
}
async function readJson(req) {
	const dec = new TextDecoder();
	let s = "";
	for await (const chunk of req) s += dec.decode(chunk, { stream: true });
	s += dec.decode();
	return s ? JSON.parse(s) : {};
}
function jsonRes(res, code, obj) {
	res.statusCode = code;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(obj));
}
let rpcSeq = 0;
async function engineCall(method, params, timeoutMs = 3e3) {
	const id = "panel-" + ++rpcSeq;
	const ws = new WebSocket(ENGINE_WS);
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try {
				ws.close();
			} catch (e) {}
			reject(/* @__PURE__ */ new Error("engine ws timeout"));
		}, timeoutMs);
		ws.onmessage = (ev) => {
			let m;
			try {
				m = JSON.parse(String(ev.data));
			} catch (e) {
				return;
			}
			if (m && m.id === id) {
				clearTimeout(timer);
				try {
					ws.close();
				} catch (e) {}
				if (m.error !== void 0) reject(new Error(String(m.error)));
				else resolve(m.result);
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("engine ws error（引擎离线？）"));
		};
		ws.onopen = () => {
			try {
				ws.send(JSON.stringify({
					id,
					method,
					params: params || {}
				}));
			} catch (e) {
				reject(e);
			}
		};
	});
}
async function engineState() {
	try {
		return await engineCall("get_state", {}, 2500);
	} catch (e) {
		return {
			offline: true,
			error: String(e && e.message || e)
		};
	}
}
const ENGINE_PORT = 8076;
const SPAWN_DEBOUNCE_MS = 15e3;
let ensureInFlight = false;
let lastSpawnAt = 0;
async function engineAlive() {
	const net = await import("node:net");
	return await new Promise((resolve) => {
		let done = false;
		const fin = (v) => {
			if (!done) {
				done = true;
				try {
					s.destroy();
				} catch (e) {}
				resolve(v);
			}
		};
		const s = net.connect(ENGINE_PORT, "127.0.0.1");
		s.once("connect", () => fin(true));
		s.once("error", () => fin(false));
		setTimeout(() => fin(false), 800);
	});
}
async function spawnEngine(extraScript) {
	const { spawn } = await import("node:child_process");
	const fs = await import("node:fs");
	ensureVoiceHome();
	const fd = fs.openSync(VOICE_LOG, "a");
	const child = spawn("bash", extraScript !== void 0 ? ["-c", extraScript] : [ENGINE_SCRIPT], {
		cwd: VOICE_HOME,
		env: {
			...process.env,
			VOICE_HOME
		},
		detached: true,
		stdio: [
			"ignore",
			fd,
			fd
		]
	});
	child.unref();
	return child.pid ?? -1;
}
async function bootstrapEngine() {
	const { spawn } = await import("node:child_process");
	const fs = await import("node:fs");
	ensureVoiceHome();
	const fd = fs.openSync(BOOTSTRAP_LOG, "a");
	const child = spawn("bash", [BOOTSTRAP_SCRIPT], {
		cwd: VOICE_HOME,
		env: {
			...process.env,
			VOICE_HOME
		},
		detached: true,
		stdio: [
			"ignore",
			fd,
			fd
		]
	});
	child.unref();
	console.log("dsh-voice: venv 缺失，后台 bootstrap 已启动 (pid=" + (child.pid ?? -1) + "，日志见 logs/bootstrap.log)");
	return child.pid ?? -1;
}
async function ensureEngine() {
	if (await engineAlive()) return;
	if (ensureInFlight || Date.now() - lastSpawnAt < SPAWN_DEBOUNCE_MS) return;
	if (!venvReady()) {
		if (!bootstrapCooldownOk()) return;
		markBootstrapAttempt();
		await bootstrapEngine();
		return;
	}
	ensureInFlight = true;
	try {
		lastSpawnAt = Date.now();
		const pid = await spawnEngine();
		console.log("dsh-voice: 引擎未运行，已拉起 (pid=" + pid + ")");
	} finally {
		ensureInFlight = false;
	}
}
async function restartEngine() {
	lastSpawnAt = Date.now();
	return await spawnEngine("pkill -f \"voice[.]daemon\" || true; sleep 1.2; exec bash " + JSON.stringify(ENGINE_SCRIPT));
}
const DEFAULT_CONTEXT_CFG = {
	compaction: {
		autoPressure: true,
		thresholdRatio: .7,
		retainRatio: .25,
		schedule: {
			mode: "off",
			time: "03:30",
			intervalHours: 12
		}
	},
	clear: { schedule: {
		mode: "off",
		time: "04:00"
	} }
};
let ctxRef = void 0;
let contextCfg = void 0;
let compactionFiber = void 0;
let compactionEngineInstance = void 0;
let compactionError = "";
let compactionArmRetries = 0;
let scheduleDisposers = [];
async function loadContextCfg() {
	const fs = await import("node:fs/promises");
	let cfg = {};
	try {
		cfg = JSON.parse(await fs.readFile(CONTEXT_CFG, "utf-8"));
	} catch (e) {}
	const merged = JSON.parse(JSON.stringify(DEFAULT_CONTEXT_CFG));
	const c = cfg.compaction || {};
	merged.compaction = {
		...merged.compaction,
		...c
	};
	merged.compaction.schedule = {
		...DEFAULT_CONTEXT_CFG.compaction.schedule,
		...c.schedule || {}
	};
	const cl = cfg.clear || {};
	merged.clear = {
		...merged.clear,
		...cl
	};
	merged.clear.schedule = {
		...DEFAULT_CONTEXT_CFG.clear.schedule,
		...cl.schedule || {}
	};
	return merged;
}
async function saveContextCfg(cfg) {
	await (await import("node:fs/promises")).writeFile(CONTEXT_CFG, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
function validateContextCfg(cfg) {
	const c = cfg && cfg.compaction;
	if (!c || typeof c.autoPressure !== "boolean") return "compaction.autoPressure 无效";
	if (!(typeof c.thresholdRatio === "number" && c.thresholdRatio >= .3 && c.thresholdRatio <= .95)) return "压缩阈值需在 0.3–0.95";
	if (!(typeof c.retainRatio === "number" && c.retainRatio >= .05 && c.retainRatio < c.thresholdRatio)) return "保留比例需 ≥0.05 且小于压缩阈值";
	const s = c.schedule;
	if (!s || ![
		"off",
		"daily",
		"interval"
	].includes(s.mode)) return "定时压缩 mode 无效";
	if (s.mode === "daily" && !/^\d{2}:\d{2}$/.test(s.time || "")) return "定时压缩时间需为 HH:MM";
	if (s.mode === "interval" && !(typeof s.intervalHours === "number" && s.intervalHours >= 1 && s.intervalHours <= 168)) return "压缩间隔需 1–168 小时";
	const cs = cfg.clear && cfg.clear.schedule;
	if (!cs || !["off", "daily"].includes(cs.mode)) return "自动清空 mode 无效";
	if (cs.mode === "daily" && !/^\d{2}:\d{2}$/.test(cs.time || "")) return "自动清空时间需为 HH:MM";
}
async function importCompactionBasic() {
	try {
		return await import("@deepseek-ai/dsh-compaction-basic");
	} catch (e) {}
	const { createRequire } = await import("node:module");
	const { pathToFileURL } = await import("node:url");
	const bases = ["/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/", (await import("node:os")).homedir() + "/.dsh/profiles/node_modules/"];
	for (const base of bases) try {
		return await import(pathToFileURL(createRequire(base + "index.js").resolve("@deepseek-ai/dsh-compaction-basic")).href);
	} catch (e) {}
	throw new Error("找不到 @deepseek-ai/dsh-compaction-basic（部署或 profile node_modules 均未命中）");
}
function compactionAvailable() {
	return compactionEngineInstance !== void 0;
}
async function armCompaction(retry = true) {
	if (compactionFiber !== void 0) {
		try {
			await compactionFiber.dispose();
		} catch (e) {}
		compactionFiber = void 0;
	}
	compactionEngineInstance = void 0;
	compactionError = "";
	try {
		const mod = await importCompactionBasic();
		const Engine = mod.default ?? mod.BasicCompactionEngine;
		const cfg = {
			auto: false,
			thresholdRatio: contextCfg.compaction.thresholdRatio,
			retainRatio: contextCfg.compaction.retainRatio
		};
		compactionFiber = ctxRef.plugin({
			name: "dsh-voice-compaction",
			inject: [
				"llm",
				"tokenMeter",
				"sessions"
			],
			apply(c) {
				compactionEngineInstance = new Engine(c, cfg);
			}
		});
		if (compactionEngineInstance !== void 0) {
			compactionArmRetries = 0;
			console.log("dsh-voice: compaction 引擎已挂载 (threshold=" + cfg.thresholdRatio + ")");
		} else {
			compactionError = "等待 llm/tokenMeter/sessions 就绪";
			if (retry && compactionArmRetries < 6) {
				compactionArmRetries += 1;
				setTimeout(() => {
					if (compactionEngineInstance === void 0) armCompaction();
				}, 5e3);
			}
		}
	} catch (e) {
		compactionError = String(e && e.message || e);
		console.error("dsh-voice: compaction 引擎挂载失败：", compactionError);
	}
}
function compactionEngine() {
	return compactionEngineInstance;
}
function nextDailyDelay(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	const now = /* @__PURE__ */ new Date();
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return next.getTime() - now.getTime();
}
function armSchedules() {
	for (const d of scheduleDisposers) try {
		d();
	} catch (e) {}
	scheduleDisposers = [];
	const addTimer = (fn, delay, rearm) => {
		try {
			const disposer = ctxRef.setTimeout(() => {
				fn();
				if (rearm !== void 0) addTimer(fn, rearm(), rearm);
			}, delay);
			scheduleDisposers.push(typeof disposer === "function" ? disposer : () => {});
		} catch (e) {}
	};
	const cs = contextCfg.compaction.schedule;
	if (cs.mode === "daily") addTimer(() => {
		pressureCompact("定时").catch(() => {});
	}, nextDailyDelay(cs.time), () => nextDailyDelay(cs.time));
	if (cs.mode === "interval") addTimer(() => {
		pressureCompact("定时").catch(() => {});
	}, cs.intervalHours * 36e5, () => cs.intervalHours * 36e5);
	const cls = contextCfg.clear.schedule;
	if (cls.mode === "daily") addTimer(() => {
		clearContext().catch(() => {});
	}, nextDailyDelay(cls.time), () => nextDailyDelay(cls.time));
}
async function contextStats() {
	const meter = ctxRef.get("tokenMeter");
	if (meter === void 0) return {
		available: false,
		reason: "tokenMeter 不可用"
	};
	if (agent === void 0) {
		try {
			await ensureAgent();
		} catch (e) {
			return {
				available: false,
				reason: "agent 未建立"
			};
		}
		if (agent === void 0) return {
			available: false,
			reason: "agent 未建立"
		};
	}
	const m = meter.measure(agent.session);
	let window = void 0;
	try {
		const sel = effectiveSelection();
		if (sel.provider !== void 0) {
			const llm = ctxRef.get("llm");
			if (llm !== void 0) {
				const info = await llm.resolveModelInfo(sel.provider, sel.model);
				window = info && info.context && info.context.contextWindow;
			}
		}
	} catch (e) {}
	return {
		available: true,
		totalTokens: m.totalTokens,
		surfaceTokens: m.surfaceTokens,
		nodes: Array.isArray(m.nodes) ? m.nodes.length : void 0,
		contextWindow: window,
		percent: window ? Math.round(m.totalTokens / window * 1e3) / 10 : void 0,
		compactionAvailable: compactionAvailable(),
		compactionError: compactionAvailable() ? "" : compactionError || "未知原因"
	};
}
async function buildModelCatalog() {
	const llm = ctxRef.get("llm");
	if (llm === void 0) return {
		available: false,
		reason: "llm 服务不可用"
	};
	const groups = [];
	const failures = [];
	for (const p of llm.listProviders()) try {
		const models = [];
		for (const m of await llm.listModels(p.id)) {
			const info = await llm.resolveModelInfo(p.id, m.id);
			const reasoning = info && info.reasoning !== void 0 ? {
				efforts: (info.reasoning.efforts || []).map((e) => ({
					id: String(e.id),
					name: String(e.name)
				})),
				...info.reasoning.defaultEffort !== void 0 ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}
			} : void 0;
			models.push({
				id: String(m.id),
				name: String(m.name ?? m.id),
				...reasoning ? { reasoning } : {}
			});
		}
		if (models.length > 0) groups.push({
			id: String(p.id),
			name: String(p.name ?? p.id),
			models
		});
	} catch (e) {
		failures.push({
			id: String(p.id),
			name: String(p.name ?? p.id),
			message: String(e && e.message || e)
		});
	}
	return {
		available: true,
		groups,
		failures,
		defaultSelection: modelOptions() ?? null
	};
}
/** 保存前活校验：provider/model 必须在目录中可解析；effort（若指定）须在该模型
* 的档位表内。返回 undefined=通过，否则中文错误。 */
async function validateModelAgainstCatalog(m) {
	if (m === null) return void 0;
	const llm = ctxRef.get("llm");
	if (llm === void 0) return void 0;
	let info;
	try {
		info = await llm.resolveModelInfo(m.provider, m.model);
	} catch (e) {
		return `模型不可用：${m.provider}/${m.model}（${String(e && e.message || e)}）`;
	}
	if (m.effort && info && info.reasoning) {
		const ids = (info.reasoning.efforts || []).map((e) => String(e.id));
		if (!ids.includes(m.effort)) return `模型 ${m.model} 不支持思考强度「${m.effort}」（可选：${ids.join("、")}）`;
	}
}
async function pressureCompact(reason) {
	const engine = compactionEngine();
	if (engine === void 0) return {
		ok: false,
		error: "compaction 引擎不可用"
	};
	const a = await ensureAgent();
	try {
		const r = await engine.compactIfNeeded(a, "pressure");
		console.log("dsh-voice: 压缩(" + reason + ") " + (r ? "收敛 ~" + r.shadowedTokenCount + " tokens" : "未过阈值，跳过"));
		return {
			ok: true,
			compacted: r !== null && r !== void 0,
			shadowed: r ? r.shadowedTokenCount : 0
		};
	} catch (e) {
		console.error("dsh-voice: 压缩(" + reason + ") 失败:", e && e.message || e);
		return {
			ok: false,
			error: String(e && e.message || e)
		};
	}
}
async function manualCompact() {
	const engine = compactionEngine();
	if (engine === void 0) return {
		ok: false,
		error: "compaction 引擎不可用"
	};
	const a = await ensureAgent();
	const meter = ctxRef.get("tokenMeter");
	const before = meter !== void 0 ? meter.measure(a.session).totalTokens : void 0;
	let runs = 0, last = void 0;
	try {
		for (let i = 0; i < 3; i++) {
			const r = await engine.compactNow(a);
			if (r === null || r === void 0) break;
			runs += 1;
			last = r;
		}
	} catch (e) {
		const msg = String(e && e.message || e);
		if (msg.includes("busy")) return {
			ok: false,
			error: "Agent 正在对话中，空闲后再试"
		};
		return {
			ok: false,
			error: msg
		};
	}
	const after = meter !== void 0 ? meter.measure(a.session).totalTokens : void 0;
	return {
		ok: true,
		runs,
		before,
		after,
		shadowed: last ? last.shadowedTokenCount : 0
	};
}
async function setClearPending(v) {
	const fs = await import("node:fs/promises");
	try {
		if (v) {
			await fs.mkdir(ARCHIVE_ROOT, { recursive: true });
			await fs.writeFile(CLEAR_PENDING, String(Date.now()), "utf-8");
		} else await fs.rm(CLEAR_PENDING, { force: true });
	} catch (e) {
		console.error("dsh-voice: clear-pending 标记读写失败", e && e.message || e);
	}
}
async function clearContext() {
	try {
		if (agent !== void 0) agent.cancel("user");
	} catch (e) {}
	const h = handle;
	handle = void 0;
	agent = void 0;
	engineTurn = void 0;
	if (h !== void 0) try {
		await h.dispose();
	} catch (e) {}
	await new Promise((r) => {
		setTimeout(r, 400);
	});
	if ((agentsSvc !== void 0 ? agentsSvc.get(SESSION) : void 0) !== void 0) {
		await setClearPending(true);
		return {
			ok: false,
			occupied: true,
			deferred: true,
			error: "jarvis-voice 正被 GUI 会话页占用。已登记：下次 dsh web 启动时自动清空；或现在关闭该会话页后再点一次立即清空。"
		};
	}
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const root = path.join(os.homedir(), ".dsh", "sessions");
	const archiveRoot = ARCHIVE_ROOT;
	const archived = [];
	try {
		await fs.mkdir(archiveRoot, { recursive: true });
		const stamp = Date.now();
		for (const entry of await fs.readdir(root)) {
			const base = path.join(root, entry);
			let st;
			try {
				st = await fs.stat(base);
			} catch (e) {
				continue;
			}
			if (!st.isDirectory()) continue;
			for (const name of await fs.readdir(base)) {
				if (!(name === SESSION || name.startsWith(SESSION + ".bak-"))) continue;
				const src = path.join(base, name);
				try {
					if (!(await fs.stat(src)).isDirectory()) continue;
					const dest = path.join(archiveRoot, name + "-" + stamp);
					await fs.rename(src, dest);
					archived.push(path.basename(dest));
				} catch (e) {}
			}
		}
	} catch (e) {}
	let recreated = false;
	try {
		await ensureAgent();
		recreated = agent !== void 0;
	} catch (e) {
		console.error("dsh-voice: 清空后重建会话失败（下次唤醒自愈）:", e && e.message || e);
	}
	console.log("dsh-voice: 上下文已清空（归档 " + archived.length + " 份，重建 " + (recreated ? "成功" : "待自愈") + "）");
	await setClearPending(false);
	return {
		ok: true,
		archived,
		recreated
	};
}
function apply(ctx) {
	ctxRef = ctx;
	const webServer = ctx.get("webServer");
	agentsSvc = ctx.get("agents");
	defaultModelSvc = ctx.get("agentDefaultModel");
	presetsSvc = ctx.get("agentPresets");
	const connection = ctx.get("connection");
	if (webServer === void 0 || agentsSvc === void 0) {
		console.error("dsh-voice: webServer/agents 服务不可用");
		return;
	}
	syncVoicePreset(presetsSvc).then((r) => {
		if (!r.ok) console.error("dsh-voice: 人设 preset 注册失败：", r.error);
		else console.log("dsh-voice: 人设 preset 已" + (r.mode === "register" ? "注册（agentPresets.register，0.2 通道）" : "写入 <DSH_HOME>/.agent-presets/jarvis-voice/（0.1 文件回落）"));
	});
	ctx.effect(() => () => disposeVoicePreset());
	loadAgentsStore().then((r) => {
		agentsStore = r.store;
		agentsWarn = r.warn;
		if (r.warn) console.warn("dsh-voice:", r.warn);
		else if (!agentsStore?.agents.some((a) => a.id === agentsStore.active)) console.warn("dsh-voice: 激活 Agent 缺失（用兜底文本）");
		else console.log("dsh-voice: Agent 档案就绪：" + agentsStore.agents.length + " 个，激活「" + activeAgentName(agentsStore) + "」");
	});
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt !== void 0) {
		ctx.effect(() => systemPrompt.variable("voice_persona", () => personaText(agentsStore)));
		ctx.effect(() => systemPrompt.variable("voice_output_rules", () => rulesText(agentsStore)));
	} else console.error("dsh-voice: systemPrompt 服务不可用，人设变量未注册");
	ctx.effect(() => ctx.on("agent/request", async (payload, next) => {
		const resolved = await next();
		try {
			const m = modelSelectionOf(activeModel(agentsStore));
			if (m !== void 0 && payload?.agent?.session?.id === SESSION) {
				const { reasoningEffort: _inherited, ...rest } = resolved ?? {};
				console.log("dsh-voice: agent/request 模型覆写", JSON.stringify({
					provider: m.provider,
					model: m.model,
					...m.reasoningEffort !== void 0 ? { reasoningEffort: m.reasoningEffort } : {}
				}));
				return {
					...rest,
					provider: m.provider,
					model: m.model,
					...m.reasoningEffort !== void 0 ? { reasoningEffort: m.reasoningEffort } : {}
				};
			}
		} catch (e) {
			console.error("dsh-voice: agent/request 模型覆写失败（本轮用原选型）:", e?.message || e);
		}
		return resolved;
	}, {
		global: true,
		prepend: true
	}));
	ctx.effect(() => ctx.on("llm/stream", (options, next) => {
		try {
			const m = modelSelectionOf(activeModel(agentsStore));
			if (m !== void 0 && m.reasoningEffort === "off" && options !== void 0 && String(options.sessionId ?? "") === SESSION && !servedStripped.has(options) && Array.isArray(options.messages) && options.messages.some((x) => Array.isArray(x?.content) && x.content.some((b) => b?.type === "reasoning"))) {
				const llm = ctx.get("llm");
				if (llm !== void 0) {
					const retry = {
						...options,
						messages: options.messages.map(stripReplayThinking)
					};
					servedStripped.add(retry);
					console.log("dsh-voice: off 档剥除回放思考后重派（" + retry.messages.length + " 条消息）");
					return llm.stream(retry);
				}
			}
		} catch (e) {
			console.error("dsh-voice: off 档思考剥除失败（按原样发）:", e?.message || e);
		}
		return next();
	}, {
		global: true,
		prepend: true
	}));
	ctx.on("session/event", onSessionEvent);
	ctx.effect(() => ctx.on("agent/assistant-stream", (payload) => {
		try {
			if (payload?.agent?.session?.id !== SESSION) return;
			const f = payload?.frame;
			if (f === void 0 || f.type !== "chunk") return;
			const c = f.chunk || {};
			if (c.type === "text-delta" && typeof c.text === "string" && c.text.length > 0) {
				if (!streamViaFrames) {
					streamViaFrames = true;
					console.log("dsh-voice: 流式通道锁定 agent/assistant-stream（0.2 帧）");
				}
				if (engineTurn === void 0) {
					console.log("voice-bridge frame 丢弃（engineTurn 未设置）:", String(c.text).slice(0, 20));
					return;
				}
				sentAny = true;
				push({
					type: "agent/chunk",
					turn: engineTurn,
					text: c.text
				});
			}
		} catch (e) {
			console.error("dsh-voice: assistant-stream 帧处理失败:", e?.message || e);
		}
	}, { global: true }));
	ensureEngine().catch((e) => console.error("dsh-voice: ensureEngine 失败", e));
	try {
		ctx.setTimeout(() => {
			ensureEngine().catch(() => {});
		}, 1e4);
	} catch (e) {}
	let ensureTimer;
	try {
		ensureTimer = ctx.interval(() => {
			ensureEngine().catch(() => {});
		}, 3e4);
	} catch (e) {}
	loadContextCfg().then((cfg) => {
		contextCfg = cfg;
		armCompaction();
		armSchedules();
	}).catch((e) => console.error("dsh-voice: 上下文配置加载失败", e));
	(async () => {
		const fs = await import("node:fs/promises");
		try {
			await fs.access(CLEAR_PENDING);
			console.log("dsh-voice: 检测到延迟清空登记，3 秒后执行");
			setTimeout(() => {
				clearContext().then((r) => {
					if (r && r.ok) console.log("dsh-voice: 延迟清空完成");
					else console.log("dsh-voice: 延迟清空仍被占用，保留登记下次再试：", r && r.error);
				}).catch((e) => console.error("dsh-voice: 延迟清空失败", e));
			}, 3e3);
		} catch (e) {}
	})();
	const disposeEvent = webServer.register({
		kind: "exact",
		path: PREFIX + "/event",
		async handler(req, res) {
			try {
				jsonRes(res, 200, await onEvent(await readJson(req)));
			} catch (e) {
				jsonRes(res, 400, {
					ok: false,
					error: String(e && e.message || e)
				});
			}
		}
	});
	const disposeStream = webServer.register({
		kind: "exact",
		path: PREFIX + "/stream",
		handler(req, res) {
			if (sseAlive()) {
				jsonRes(res, 409, {
					ok: false,
					error: "bridge-busy"
				});
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			});
			sseRes = res;
			res.on("close", () => {
				if (sseRes === res) sseRes = void 0;
			});
			push({
				type: "bridge/ready",
				session: SESSION
			});
		}
	});
	const stopBeat = ctx.interval(() => {
		if (!sseAlive()) return;
		try {
			sseRes.write(": ping\n\n");
		} catch (e) {
			engineGone();
		}
	}, 15e3);
	if (connection !== void 0) ctx.effect(() => ctx.root.connection.rpc.handle("/dsh-voice", async (endpoint, _payload) => {
		if (endpoint === "status") {
			const st = await engineState();
			if (st && st.offline) ensureEngine().catch(() => {});
			return {
				ok: true,
				value: {
					engine: st,
					bridge: {
						session: SESSION,
						sse: sseAlive(),
						model: effectiveSelection(),
						served: lastServed
					},
					persona: {
						active: activeAgentName(agentsStore),
						warn: agentsWarn
					}
				}
			};
		}
		if (endpoint === "models/list") try {
			return {
				ok: true,
				value: await buildModelCatalog()
			};
		} catch (e) {
			return {
				ok: false,
				error: {
					code: "internal",
					message: "目录构建失败: " + String(e && e.message || e),
					details: { issues: [] }
				}
			};
		}
		if (endpoint === "config/get") return {
			ok: true,
			value: await engineCall("config/get", {})
		};
		if (endpoint === "config/set") return {
			ok: true,
			value: await engineCall("config/set", { updates: _payload && _payload.updates || {} })
		};
		if (endpoint === "engine/stop") return {
			ok: true,
			value: await engineCall("loop/stop", {})
		};
		if (endpoint === "engine/restart") return {
			ok: true,
			value: {
				restarting: true,
				pid: await restartEngine()
			}
		};
		if (endpoint === "engine/preview") return {
			ok: true,
			value: await engineCall("tts/preview", {
				preset: String(_payload && _payload.preset || ""),
				text: String(_payload && _payload.text || ""),
				voice: String(_payload && _payload.voice || "")
			}, 45e3)
		};
		if (endpoint === "music/preview") return {
			ok: true,
			value: await engineCall("music/preview", { seconds: Number(_payload && _payload.seconds || 5) }, 3e4)
		};
		if (endpoint === "wake/get") return {
			ok: true,
			value: await engineCall("wake/get", {}, 3e3)
		};
		if (endpoint === "wake/set") return {
			ok: true,
			value: await engineCall("wake/set", { phrase: String(_payload && _payload.phrase || "") }, 8e3)
		};
		if (endpoint === "log/tail") {
			const fs = await import("node:fs/promises");
			const n = Math.max(50, Math.min(2e3, Number(_payload && _payload.lines || 300)));
			const LOG = VOICE_LOG;
			try {
				const fh = await fs.open(LOG, "r");
				try {
					const size = (await fh.stat()).size;
					const read = Math.min(size, 262144);
					const buf = Buffer.alloc(read);
					await fh.read(buf, 0, read, size - read);
					let arr = buf.toString("utf-8").split("\n");
					if (read < size && arr.length > 1) arr.shift();
					while (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
					return {
						ok: true,
						value: {
							lines: arr.slice(-n),
							size
						}
					};
				} finally {
					await fh.close();
				}
			} catch (e) {
				return {
					ok: true,
					value: {
						lines: [],
						error: String(e && e.message || e)
					}
				};
			}
		}
		if (endpoint === "context/get") return {
			ok: true,
			value: {
				stats: await contextStats(),
				config: contextCfg
			}
		};
		if (endpoint === "context/set") {
			const incoming = _payload && _payload.config;
			const err = validateContextCfg(incoming);
			if (err !== void 0) return {
				ok: false,
				error: {
					code: "bad-request",
					message: err,
					details: { issues: [] }
				}
			};
			contextCfg = incoming;
			await saveContextCfg(contextCfg);
			await armCompaction();
			armSchedules();
			return {
				ok: true,
				value: { saved: true }
			};
		}
		if (endpoint === "context/compact") return {
			ok: true,
			value: await manualCompact()
		};
		if (endpoint === "context/clear") try {
			return {
				ok: true,
				value: await clearContext()
			};
		} catch (e) {
			console.error("dsh-voice: context/clear 异常:", e);
			const stack2 = e && e.stack ? String(e.stack).split("\n")[1] : "";
			return {
				ok: false,
				error: {
					code: "internal",
					message: "clear 异常: " + String(e && e.message || e) + (stack2 ? " @ " + stack2.trim() : ""),
					details: { issues: [] }
				}
			};
		}
		if (endpoint === "agents/list") {
			const store = await ensureStoreLoaded();
			let ttsOptions = [];
			try {
				ttsOptions = (await engineCall("config/get", {}, 2500))?.config?.["tts.preset"]?.options ?? [];
			} catch (e) {}
			return {
				ok: true,
				value: {
					active: store.active,
					common: store.common,
					agents: store.agents,
					ttsOptions,
					warn: agentsWarn,
					presetId: PRESET_ID,
					bound: await presetBoundTo(ctxRef, SESSION)
				}
			};
		}
		if (endpoint === "agents/save") {
			const store = await ensureStoreLoaded();
			const prevTools = activeTools(store);
			const prevModel = activeModel(store);
			const v = validateAgent(_payload && _payload.agent);
			if (v.error !== void 0 || v.agent === void 0) return badRequest(v.error || "agent 无效");
			const a = v.agent;
			if (store.agents.some((x) => x.name === a.name && x.id !== a.id)) return badRequest("已有同名 Agent：「" + a.name + "」");
			const modelErr = await validateModelAgainstCatalog(a.model ?? null);
			if (modelErr !== void 0) return badRequest(modelErr);
			const idx = store.agents.findIndex((x) => x.id === a.id);
			if (idx >= 0) store.agents[idx] = a;
			else store.agents.push(a);
			await saveAgentsStore(store);
			console.log("dsh-voice: Agent 已保存「" + a.name + "」(" + (idx >= 0 ? "更新" : "新建") + ")");
			let voiceApplied = false, voiceError = void 0;
			if (store.active === a.id) try {
				const engine = await engineCall("config/set", { updates: {
					"tts.preset": a.tts.preset,
					"tts.voice": a.tts.voice
				} }, 8e3);
				if (engine && engine.ok === false) voiceError = JSON.stringify(engine.errors || engine);
				else voiceApplied = true;
			} catch (e) {
				voiceError = "引擎离线？" + String(e && e.message || e);
			}
			let toolsApplied = false, recreated = false;
			const nowTools = activeTools(store);
			if (store.active === a.id && JSON.stringify(prevTools) !== JSON.stringify(nowTools)) {
				if ((await syncVoicePreset(presetsSvc)).wrote) {
					const cleared = await clearContext();
					recreated = !!(cleared && cleared.recreated);
				}
				toolsApplied = true;
				console.log("dsh-voice: 激活档案工具变化已应用", JSON.stringify(nowTools), "recreated=", recreated);
			}
			let modelApplied = false;
			if (store.active === a.id && JSON.stringify(prevModel) !== JSON.stringify(activeModel(store))) {
				modelApplied = true;
				console.log("dsh-voice: 激活档案模型变化已登记（agent/request 拦截器下一轮生效）", JSON.stringify(activeModel(store)));
			}
			return {
				ok: true,
				value: {
					saved: true,
					agent: a,
					voiceApplied,
					toolsApplied,
					recreated,
					modelApplied,
					...voiceError ? { voiceError } : {}
				}
			};
		}
		if (endpoint === "agents/delete") {
			const store = await ensureStoreLoaded();
			const id = String(_payload && _payload.id || "");
			const idx = store.agents.findIndex((x) => x.id === id);
			if (idx < 0) return badRequest("Agent 不存在");
			if (store.active === id) return badRequest("不能删除使用中的 Agent，请先切换到其他 Agent");
			const [removed] = store.agents.splice(idx, 1);
			await saveAgentsStore(store);
			console.log("dsh-voice: Agent 已删除「" + removed.name + "」");
			return {
				ok: true,
				value: { deleted: id }
			};
		}
		if (endpoint === "agents/activate") {
			const store = await ensureStoreLoaded();
			const prevTools = activeTools(store);
			const prevModel = activeModel(store);
			const id = String(_payload && _payload.id || "");
			const a = store.agents.find((x) => x.id === id);
			if (a === void 0) return badRequest("Agent 不存在");
			let engine;
			try {
				engine = await engineCall("config/set", { updates: {
					"tts.preset": a.tts.preset,
					"tts.voice": a.tts.voice
				} }, 8e3);
			} catch (e) {
				return badRequest("音色下发失败（引擎离线？）已中止切换：" + String(e && e.message || e));
			}
			if (engine && engine.ok === false) return badRequest("音色切换被引擎拒绝（已中止）：" + JSON.stringify(engine.errors || engine));
			store.active = a.id;
			await saveAgentsStore(store);
			let toolsApplied = false, recreated = false;
			if (JSON.stringify(prevTools) !== JSON.stringify(activeTools(store))) {
				if ((await syncVoicePreset(presetsSvc)).wrote) {
					const cleared = await clearContext();
					recreated = !!(cleared && cleared.recreated);
				}
				toolsApplied = true;
			}
			let modelApplied = false;
			if (JSON.stringify(prevModel) !== JSON.stringify(activeModel(store))) modelApplied = true;
			console.log("dsh-voice: Agent 已切换「" + a.name + "」（音色已热切，人设下一轮对话生效" + (toolsApplied ? "；工具集变化已重建会话" : "") + (modelApplied ? "；模型选型已热切换" : "") + "）");
			return {
				ok: true,
				value: {
					activated: a.id,
					engine,
					toolsApplied,
					recreated,
					modelApplied
				}
			};
		}
		if (endpoint === "common/set") {
			const store = await ensureStoreLoaded();
			const v = validateRules(_payload && _payload.outputRules);
			if (v.error !== void 0 || v.rules === void 0) return badRequest(v.error || "输出规则无效");
			store.common.outputRules = v.rules;
			await saveAgentsStore(store);
			console.log("dsh-voice: 公共输出规则已更新（" + v.rules.length + " 字，下一轮对话生效）");
			return {
				ok: true,
				value: { saved: true }
			};
		}
		if (endpoint === "agents/migrate") try {
			return {
				ok: true,
				value: {
					clear: await clearContext(),
					bound: await presetBoundTo(ctxRef, SESSION)
				}
			};
		} catch (e) {
			console.error("dsh-voice: agents/migrate 异常:", e);
			return badRequest("迁移失败: " + String(e && e.message || e));
		}
		return {
			ok: false,
			error: {
				code: "bad-request",
				message: `unknown endpoint ${endpoint}`,
				details: { issues: [] }
			}
		};
	}, { authority: "loopback" }), "dsh-voice: rpc");
	ctx.effect(() => () => {
		if (typeof stopBeat === "function") stopBeat();
		if (ensureTimer !== void 0 && typeof ensureTimer === "function") ensureTimer();
		for (const d of scheduleDisposers) try {
			d();
		} catch (e) {}
		scheduleDisposers = [];
		if (compactionFiber !== void 0) {
			try {
				compactionFiber.dispose();
			} catch (e) {}
			compactionFiber = void 0;
		}
		disposeStream();
		disposeEvent();
		if (sseRes !== void 0) {
			try {
				sseRes.end();
			} catch (e) {}
			sseRes = void 0;
		}
		const h = handle;
		handle = void 0;
		agent = void 0;
		engineTurn = void 0;
		if (h !== void 0) try {
			h.dispose();
		} catch (e) {}
	});
	console.log("dsh-voice 就绪: bridge=" + PREFIX + " panel=/dsh-voice session=" + SESSION);
}
//#endregion
export { apply, inject, name };
