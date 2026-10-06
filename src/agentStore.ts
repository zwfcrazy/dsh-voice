/* dsh-voice 个性/Agent 配置存储（P7b 2026-09-20，plans/phase-7b-agent-persona.md）。
 *
 * 两个持久化物：
 * - config/voice-agents.json —— agent 档案（人设提示词 + 音色）与公共输出规则，
 *   daemon 不读；插件在面板 RPC 与提示词变量两处消费。
 * - <DSH_HOME>/.agent-presets/jarvis-voice/ —— 人设 preset。persona 行文本是
 *   固定模板 {{voice_persona}}\n\n{{voice_output_rules}}，真实内容按模型请求渲染
 *   时从下面的内存 store 读：切换个性只改 JSON，不碰 preset 也不碰会话。
 *   preset 刻意不含工具行（与现状能力面一致；工具白名单属 P7c）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { VOICE_HOME } from './paths'

export const PRESET_ID = 'jarvis-voice'
// P7d 打包形态：档案随数据根走（VOICE_HOME/config/），不再锚开发库绝对路径。
// 开发库旧位置的档案由迁移逻辑（agents/migrate）或手工拷贝接管。
export const AGENTS_CFG = VOICE_HOME + '/config/voice-agents.json'

export interface VoiceAgentTts {
  preset: string   // daemon TTS_PRESETS 键
  voice: string    // 非空 = 自定义音色 id 覆盖；空 = 用预设默认
}

export interface ToolsCfg {
  webSearch: boolean   // ①全局缝：tool-web 行（web_search / Tavily 后端）
  voiceTools: boolean  // ②丁满私有：dsh-voice/tools 行（voice_volume 等）
}

/* P7c 收尾（2026-09-27）：模型选择器，绑定 Agent 档案（用户约定同工具：
 * 是 agent 配置的一部分）。只配模型名 + 思考强度；null/缺省 = 跟随 DSH
 * 部署默认（agent-default-model 设置）。生效机制不是 preset 行而是桥侧
 * installModelSelection（agent/request 瀑布覆盖 provider/model/effort，
 * 下一轮生效，无需重建会话；选中随请求头落日志，被后续任何实例继承）。 */
export interface AgentModelCfg {
  provider: string
  model: string
  effort?: string      // '' / 缺省 = 不指定（模型/路由默认档）；如 'off'/'high'/'max'
}

export interface VoiceAgent {
  id: string
  name: string
  prompt: string
  tts: VoiceAgentTts
  tools?: ToolsCfg     // P7c（2026-09-26）：工具绑定 Agent 档案（用户约定：
                       // 工具/技能是 agent 配置的一部分，不另立面板）
  model?: AgentModelCfg | null   // P7c 收尾：模型+思考强度；null = 跟随部署默认
  createdAt: number
  updatedAt: number
}

export interface AgentsStore {
  version: number
  active: string
  common: { outputRules: string }
  agents: VoiceAgent[]
}

/* 种子内容（plans §4，2026-09-20 用户定稿；面板可改，改完落盘后以文件为准） */
export const SEED_PROMPT = [
  '你是丁满，一个语音助手，性格机灵热心，像个小伙伴。',
  '说话方式：口语化短句，一次只说重点，不用书面语；默认中文。',
  '职责：日常对话、问答、提醒；做不到的坦率说明。',
].join('\n')

export const SEED_RULES = [
  '你的回复将被直接转成语音朗读，因此：',
  '1. 只输出适合朗读的纯文本；不要 markdown 符号（*、#、-、`）、emoji、代码块、列表编号。',
  '2. 数字和算式按中文口语写：乘号写「乘以」，结果写阿拉伯数字，例如「1234 乘以 1234 等于 1522756」；不要在数字之间加空格或符号分隔。',
  '3. 网址、文件名等无法朗读的内容，除非用户要求，否则不要念出来。',
  '4. 句子短，一句话一个信息点。',
  '5. 不要使用任何无法转换为语音的输出方式，如选项卡片、沙箱权限询问等。',
].join('\n')

const now = () => Date.now()

export function defaultTools(): ToolsCfg {
  return { webSearch: true, voiceTools: true }
}

/** 激活 Agent 的工具集（preset 模板的数据源；缺失兜底全开）。 */
export function activeTools(store: AgentsStore | undefined): ToolsCfg {
  const a = store?.agents.find(x => x.id === store.active)
  return a?.tools ?? defaultTools()
}

/** 激活 Agent 的模型选型（null = 跟随部署默认）。 */
export function activeModel(store: AgentsStore | undefined): AgentModelCfg | null {
  const a = store?.agents.find(x => x.id === store.active)
  const m = a?.model
  return (m && m.provider && m.model) ? m : null
}

/** AgentModelCfg → installModelSelection 的 selection 形状（effort 空=不指定）。 */
export function modelSelectionOf(m: AgentModelCfg | null): { provider: string, model: string, reasoningEffort?: string } | undefined {
  if (m === null) return undefined
  return { provider: m.provider, model: m.model, ...(m.effort ? { reasoningEffort: m.effort } : {}) }
}

function seedStore(): AgentsStore {
  return {
    version: 1,
    active: 'dingman',
    common: { outputRules: SEED_RULES },
    agents: [{
      id: 'dingman',
      name: '丁满',
      prompt: SEED_PROMPT,
      tts: { preset: 'qa-jielidou', voice: '' },
      createdAt: now(),
      updatedAt: now(),
    }],
  }
}

/* ---------- 校验 ---------- */

const voiceOk = (v: unknown): boolean =>
  typeof v === 'string' && (v === '' ||
    (v.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(v)))

const idOk = (v: unknown): boolean =>
  typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_.:\-]+$/.test(v)

const effortOk = (v: unknown): boolean =>
  typeof v === 'string' && v.length >= 1 && v.length <= 16 && /^[a-z]+$/.test(v)

/* 模型选型校验：null/缺省/空对象 → null（跟随默认）；有值则 provider/model
 * 必填（走 id 字符集），effort 可空（空=不指定档位，走模型/路由默认）。 */
function validateModelCfg(input: any): { model?: AgentModelCfg | null, error?: string } {
  if (input === null || input === undefined) return { model: null }
  if (typeof input !== 'object') return { error: '模型配置无效' }
  const provider = String(input.provider ?? '').trim()
  const model = String(input.model ?? '').trim()
  const effort = String(input.effort ?? '').trim()
  if (provider === '' && model === '' && effort === '') return { model: null }
  if (!idOk(provider) || !idOk(model)) return { error: '模型 provider/model 需为 ≤64 位合法 id' }
  if (effort !== '' && !effortOk(effort)) return { error: '思考强度档位无效' }
  return { model: { provider, model, ...(effort ? { effort } : {}) } }
}

export function validateAgent(input: any): { agent?: VoiceAgent, error?: string } {
  if (input === null || typeof input !== 'object') return { error: 'agent 无效' }
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  const preset = String(input.tts?.preset ?? '').trim()
  const voice = String(input.tts?.voice ?? '').trim()
  if (name.length < 1 || name.length > 32) return { error: '名称需 1–32 字' }
  if (prompt.length < 1 || prompt.length > 8000) return { error: '提示词需 1–8000 字' }
  if (!preset) return { error: '音色预设不能为空' }
  if (!voiceOk(voice)) return { error: '自定义音色 id 需为 ≤64 位字母数字_.-' }
  const t = input.tools
  const tools: ToolsCfg = {
    webSearch: t?.webSearch !== false,
    voiceTools: t?.voiceTools !== false,
  }
  const mv = validateModelCfg(input.model)
  if (mv.error !== undefined) return { error: mv.error }
  return {
    agent: {
      id: typeof input.id === 'string' && input.id ? input.id : 'ag-' + now().toString(36),
      name, prompt,
      tts: { preset, voice },
      tools,
      model: mv.model ?? null,
      createdAt: Number(input.createdAt) || now(),
      updatedAt: now(),
    },
  }
}

export function validateRules(rules: unknown): { rules?: string, error?: string } {
  const s = String(rules ?? '').trim()
  if (s.length < 1 || s.length > 4000) return { error: '输出规则需 1–4000 字' }
  return { rules: s }
}

/* ---------- 读写（宽进严出：坏文件降级 seed 并留警告，绝不让变量落空） ---------- */

export async function loadAgentsStore(): Promise<{ store: AgentsStore, warn: string }> {
  const fs = await import('node:fs/promises')
  try {
    const raw = JSON.parse(await fs.readFile(AGENTS_CFG, 'utf-8'))
    const store = normalize(raw)
    if (store.agents.length === 0 || !store.agents.some(a => a.id === store.active)) {
      // 内容无效但文件在：不覆盖原文件（可能有可恢复内容），内存用种子并告警
      return { store: seedStore(), warn: 'voice-agents.json 无有效 Agent，已回落种子配置（原文件保留未覆盖）' }
    }
    return { store, warn: '' }
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      // 首次运行（净机安装常态）：初始化种子档案并落盘——不告警，
      // 下次启动读到的就是真文件（2026-09-20 修复：此前只回退内存不落盘，
      // 每次启动都刷 ENOENT 告警 + 面板红色横幅）
      const seed = seedStore()
      try { await saveAgentsStore(seed) } catch (e2) { /* 落盘失败不挡启动，下次再试 */ }
      return { store: seed, warn: '' }
    }
    // 文件在但读不了/解析失败：告警 + 种子兜底，同样不覆盖原文件
    return { store: seedStore(), warn: 'voice-agents.json 读取失败，用种子配置（原文件保留未覆盖）：' + String((e && e.message) || e) }
  }
}

function normalize(raw: any): AgentsStore {
  const agents: VoiceAgent[] = Array.isArray(raw?.agents)
    ? raw.agents.map((a: any) => validateAgent(a).agent).filter((a: VoiceAgent | undefined): a is VoiceAgent => a !== undefined)
    : []   // validateAgent 已回填 tools（旧档案缺省=全开）
  const active = typeof raw?.active === 'string' && agents.some(a => a.id === raw.active) ? raw.active : agents[0]?.id ?? ''
  const rules = typeof raw?.common?.outputRules === 'string' && raw.common.outputRules.trim() ? raw.common.outputRules : SEED_RULES
  return { version: 1, active, common: { outputRules: rules }, agents }
}

export async function saveAgentsStore(store: AgentsStore): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(path.dirname(AGENTS_CFG), { recursive: true })
  await fs.writeFile(AGENTS_CFG, JSON.stringify(store, null, 2) + '\n', 'utf-8')
}

/* ---------- 提示词变量（index.ts apply 注册，全局层，按轮求值） ---------- */

export function personaText(store: AgentsStore | undefined): string {
  const a = store?.agents.find(x => x.id === store.active)
  return (a?.prompt ?? SEED_PROMPT).trim()
}

export function rulesText(store: AgentsStore | undefined): string {
  const r = store?.common?.outputRules
  return (r && r.trim() ? r : SEED_RULES).trim()
}

export function activeAgentName(store: AgentsStore | undefined): string {
  const a = store?.agents.find(x => x.id === store.active)
  return a?.name ?? '（未配置）'
}


/* ---------- 人设 preset（幂等 ensure：内容不一致才重写，避免 stamp 抖动） ---------- */
/* P7c（2026-09-25）起含工具行，两层工具架构（用户定型）：
 * ①全局缝：web_search 经 dsh-tool-web，后端由 host 侧 searchProvider 选
 *   Tavily（dsh-web-search-tavily provider）——所有会话可用。
 * ②丁满私有：dsh-voice/tools（本插件子路径导出）——仅本 preset 的会话可见，
 *   首个工具 voice_volume（调 daemon 热改播报音量）。
 * 模板随工具配置（ToolsCfg）动态生成：关=行加 disabled；bash 类工具刻意不加
 * （语音无人值守没有审批通道）。 */
export function compositionYml(t: ToolsCfg): string {
  return [
    "# jarvis-voice preset（dsh-voice 插件托管生成；P7b 2026-09-20 人设，P7c 2026-09-25 工具行）。",
    "# 两层工具：①全局缝 web_search（Tavily 后端，人人可用）②丁满私有 dsh-voice/tools（仅语音会话）。",
    "# 开关经面板「工具」页（config/voice-tools.json）→ 本模板动态生成 disabled 行。",
    "# bash 类工具刻意不加：语音无人值守场景没有审批通道（plans/phase-7 P7-4）。",
    "# （注意：preset 结构性修改只影响之后新建的会话，届时需归档重建 jarvis-voice）。",
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    "  config:",
    '    text: "{{voice_persona}}\\n\\n{{voice_output_rules}}"',
    "- id: tool-web",
    "  name: '@deepseek-ai/dsh-tool-web'",
    ...(t.webSearch ? [] : ["  disabled: true"]),
    "  config:",
    "    fetch: false",
    "    searchTimeoutMs: 60000",
    "- id: tool-voice",
    "  name: 'dsh-voice/tools'",
    ...(t.voiceTools ? [] : ["  disabled: true"]),
    "",
  ].join('\n')
}

const PRESET_NAME = '丁满语音助手'
const PRESET_DESC = 'jarvis-voice 会话人设；文本经 voice_persona/voice_output_rules 提示词变量按轮注入，面板 Agent 页可切换。'
const PRESET_META_YML = [
  'name: ' + PRESET_NAME,
  'description: ' + PRESET_DESC,
  '',
].join('\n')

/** 0.2 硬迁移点 1（2026-10-06）：composition 行的 JS 形态 = 0.2
 * PresetDefinition.plugins（Omit<EntryOptions,'id'|'disabled'> & {id?, disabled?}）。
 * 与 compositionYml 逐行同源同语义（persona / tool-web / tool-voice），文件
 * 通道仅为 0.1 回落。config 值里是真实换行（YAML 通道靠 \\n 转义达成）。 */
export function compositionRows(t: ToolsCfg) {
  return [
    // 0.2（2026-10-06 roster 实测）：dsh-persona Config 把 text 改名 prefix
    // （必填；另添 suffix/complete/includeRuntimeContext）。漏改时整个 preset
    // 定义被标 broken（"$.prefix missing required value"），mount 出裸组合——
    // 实测症状：会话能跑但工具全丢（web_search/voice_volume 消失，
    // "unknown tool web_search"）。0.1 的 compositionYml 仍用 text（回落通道专用）。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '{{voice_persona}}\n\n{{voice_output_rules}}' } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', ...(t.webSearch ? {} : { disabled: true }), config: { fetch: false, searchTimeoutMs: 60000 } },
    { id: 'tool-voice', name: 'dsh-voice/tools', ...(t.voiceTools ? {} : { disabled: true }) },
  ] as Record<string, any>[]
}

/* 0.2 双轨（2026-10-06 升级）：agentPresets.register 行内声明优先（eager 激活，
 * 返回 async disposer 由本插件持有，插件卸载经 disposeVoicePreset 释放）；
 * registry 无 register（0.1）→ 回落目录文件 ensure。工具开关变化 → wrote=true，
 * 调用方照旧归档重建会话（工具是会话级 schema，语义与 0.1 文件重写一致）。 */
let presetDispose: (() => Promise<void>) | undefined

/* 审查补（2026-10-06）：boot 期 syncVoicePreset 是 fire-and-forget，若引擎极早
 * 唤醒（boot 后首声唤醒抢在注册完成前），ensureAgent 的 setup mount 会因
 * preset 未注册而失败 → 落入裸 resume 兜底 → 人设/工具静默丢失直至下次重启。
 * waitForPresetSync 让 ensureAgent 在 register 模式下短暂等待首次注册落定。 */
let firstSync: Promise<void> | undefined

export function waitForPresetSync(ms = 2000): Promise<void> {
  if (firstSync === undefined) return Promise.resolve()
  return Promise.race([firstSync, new Promise<void>(r => setTimeout(r, ms))])
}

export async function syncVoicePreset(registry: any): Promise<{ ok: boolean, error?: string, wrote: boolean, mode: 'register' | 'file' }> {
  const run = (async (): Promise<{ ok: boolean, error?: string, wrote: boolean, mode: 'register' | 'file' }> => {
    if (registry !== undefined && typeof registry.register === 'function') {
      try {
        if (presetDispose !== undefined) { try { await presetDispose() } catch { /* 旧定义释放失败不挡重注册 */ } }
        presetDispose = await registry.register({
          id: PRESET_ID,
          name: PRESET_NAME,
          description: PRESET_DESC,
          plugins: compositionRows(activeTools((await loadAgentsStore()).store)),
        })
        return { ok: true, wrote: true, mode: 'register' }
      } catch (e: any) {
        return { ok: false, error: String((e && e.message) || e), wrote: false, mode: 'register' }
      }
    }
    const r = await ensureVoicePresetFiles()
    return { ...r, mode: 'file' }
  })()
  if (firstSync === undefined) firstSync = run.then(() => undefined, () => undefined)
  return run
}

/** 插件卸载时释放已注册定义（fire-and-forget：host 停机进程即逝）。 */
export function disposeVoicePreset(): void {
  if (presetDispose !== undefined) {
    const d = presetDispose
    presetDispose = undefined
    d().catch(() => {})
  }
}

async function ensureVoicePresetFiles(): Promise<{ ok: boolean, error?: string, wrote: boolean }> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const os = await import('node:os')
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dir = path.join(home, '.agent-presets', PRESET_ID)
    await fs.mkdir(dir, { recursive: true })
    const composition = compositionYml(activeTools((await loadAgentsStore()).store))
    let wrote = false
    const comp = path.join(dir, 'agent.cordis.yml')
    if (await fs.readFile(comp, 'utf-8').then(t => t !== composition, () => true)) {
      await fs.writeFile(comp, composition, 'utf-8')
      wrote = true
    }
    const meta = path.join(dir, 'preset.yml')
    if (await fs.readFile(meta, 'utf-8').then(t => t !== PRESET_META_YML, () => true)) {
      await fs.writeFile(meta, PRESET_META_YML, 'utf-8')
      wrote = true
    }
    return { ok: true, wrote }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e), wrote: false }
  }
}

/* ---------- 会话绑定状态（供 agents/list 与迁移横幅） ---------- */

export async function presetBoundTo(ctx: Context, sessionId: string): Promise<boolean> {
  try {
    const persistence: any = (ctx as any).get('sessionPersistence')
    if (persistence === undefined) return false
    const headers = await persistence.list()
    // 0.2（2026-10-06）：list() 返回 SessionPersistenceSnapshot {header, revision, ...}，
    // 字段嵌套在 .header 下（0.1 是平铺的 {id, agentPreset}）——只读平铺会永远
    // undefined，面板横幅误报"尚未绑定"（实际 0.2 resume 会按会话头自动绑 preset，
    // 功能无恙，纯显示问题）。双形状兼容。
    const h = Array.isArray(headers) ? headers.find((x: any) => (x.id ?? x.header?.id) === sessionId) : undefined
    return (h?.agentPreset ?? h?.header?.agentPreset) === PRESET_ID
  } catch (e) {
    return false
  }
}
