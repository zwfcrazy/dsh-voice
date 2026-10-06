/* dsh-voice host 半区：voice-engine 桥（SSE+POST /voice-bridge）+ 面板 RPC。
 * 桥逻辑 = 动态插件 voice-1/pkg-5 定稿版（docs/research/phase-7-dsh集成.md §5）。
 * 面板 RPC（client → ctx.connection.rpc '/dsh-voice'）：
 *   status   → 代理 engine WS(127.0.0.1:8076) 的 get_state + 桥自身状态
 *   config/get / config/set → engine 白名单配置（热改/需重启分级）
 *   context/* → jarvis-voice 会话上下文：用量统计/清空/压缩 + 压缩与清空调度配置
 *   agents/* + common/set → P7b Agent 档案（个性=提示词+音色+工具集+模型选型）CRUD、
 *     切换、公共输出规则；工具集变化（保存激活档案/切换档案）自动重写 preset 并
 *     归档重建会话（P7c 2026-09-26）；模型选型经根级 agent/request 拦截下一轮生效
 *     （P7c v2 2026-10-05 定型，无需重建会话）
 *   models/list → ctx.llm 实时模型目录（GUI 模型选择器同源；下拉数据源）
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  PRESET_ID, loadAgentsStore, saveAgentsStore, syncVoicePreset, waitForPresetSync, disposeVoicePreset, presetBoundTo,
  personaText, rulesText, activeAgentName, validateAgent, validateRules,
  activeTools, activeModel, modelSelectionOf,
  type AgentsStore, type ToolsCfg, type AgentModelCfg,
} from './agentStore'
import {
  VOICE_HOME, ENGINE_SCRIPT, BOOTSTRAP_SCRIPT, VOICE_LOG, BOOTSTRAP_LOG, CONTEXT_CFG, ARCHIVE_ROOT,
  venvReady, ensureVoiceHome, bootstrapCooldownOk, markBootstrapAttempt,
} from './paths'

export const name = 'dsh-voice'
export const inject = ['timer', 'connection', 'webServer', 'agents', 'agentDefaultModel', 'agentPresets']

const SESSION = 'jarvis-voice'
const PREFIX = '/voice-bridge'
const ENGINE_WS = 'ws://127.0.0.1:8076'
const CLEAR_PENDING = ARCHIVE_ROOT + '/CLEAR-PENDING'

let handle: any = undefined
let agent: any = undefined
let sseRes: any = undefined
let engineTurn: any = undefined
let sentAny = false
let agentsSvc: any, defaultModelSvc: any, presetsSvc: any

// P7b Agent 档案（apply 时异步加载；变量/ RPC 兜底读 seed，绝不落空）
let agentsStore: AgentsStore | undefined
let agentsWarn = ''

function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function modelOptions() {
  try {
    const sel = defaultModelSvc !== undefined ? defaultModelSvc.currentSelection() : undefined
    if (sel && sel.provider && sel.model) {
      return { provider: sel.provider, model: sel.model,
        ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
    }
  } catch (e) { console.error('agentDefaultModel 读取失败', e) }
  return undefined
}

/* ---------- P7c v2：模型选择器（档案级 provider/model/effort，热生效） ----------
 * 机制（2026-10-05 深夜定型，两度返工后的最终方案）：根级 `agent/request`
 * 瀑布拦截（installModelSelection 官方同款：改 `await next()` 返回值），
 * `{global:true, prepend:true}` + host 启动期注册 → 瀑布最外层=终审权，
 * 无视实例换载，压过 apiproxy 的 picked/请求头回退（晚注册且不带 prepend，
 * 永远在内层）。按 payload.agent.session.id 过滤，档案有模型→覆盖三件套；
 * 档案空→不动请求（跟随部署默认/会话内选择）。读取实时档案（每次请求
 * 现读 store），保存即生效，无需任何热应用状态。
 * 返工史：首版 agent.ctx 级 installModelSelection 被 apiproxy 选型压住；
 * 二版 llm/stream 拦截从机制上不可能生效（cordis 瀑布 next() 忽略传参），
 * 详见 apply 内注释。 */
function effectiveSelection() {
  const m = modelSelectionOf(activeModel(agentsStore))
  if (m !== undefined) return { source: 'profile' as const, ...m }
  const d = modelOptions()
  return d === undefined
    ? { source: 'default' as const }
    : { source: 'default' as const, provider: d.provider, model: d.model, ...(d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}) }
}

function sseAlive() { return sseRes !== undefined && !sseRes.writableEnded && !sseRes.destroyed }

function push(msg: any): boolean {
  if (!sseAlive()) return false
  try { sseRes.write('data: ' + JSON.stringify(msg) + '\n\n'); return true }
  catch (e) { console.error('SSE write failed', e); engineGone(); return false }
}

function engineGone() {
  if (sseRes !== undefined) { try { sseRes.end() } catch (e) {} sseRes = undefined }
  if (agent !== undefined && engineTurn !== undefined) { try { agent.cancel('user') } catch (e) {} }
  engineTurn = undefined
}

// 2026-09-19 根治：session/event 挂插件自身 ctx（session 级广播，与 agent
// 实例无关）。此前挂 agent.ctx——GUI 打开/查看 session 或每轮 compaction
// 会换载实例，轮中进行中换载时插件瞬间失聪（实测：首 chunk 后再无声息、
// GUI 却有完整回复，两轮复现）。按 session.id 过滤；不再挂 agent 级订阅
// （历史上"根级+agent 级"双订阅曾致叠词）。
function onSessionEvent(session: any, event: any) {
  if (session.id !== SESSION) return
  const d = event.data || {}
  if (event.type === 'request/header') {
    // P7c v2.1：记录最近一轮实际出站配置——agent/request 覆盖发生在 header
    // 冻结之前，会话头即出站真相（面板「最近出站」行，验证模型热切换用，
    // 别再问模型自己——系统提示词写满 DeepSeek，自报永远答 DeepSeek）。
    const c = (d.header && d.header.config) || {}
    if (c.provider && c.model) {
      lastServed = {
        provider: String(c.provider), model: String(c.model),
        ...(c.reasoningEffort ? { reasoningEffort: String(c.reasoningEffort) } : {}),
        at: Date.now(),
      }
    }
    return
  }
  if (event.type === 'assistant/chunk') {
    if (streamViaFrames) return   // 0.2 双轨：帧通道已锁定，legacy 退位（防双推）
    const c = d.chunk || {}
    if (c.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0) {
      if (engineTurn === undefined) {
        // 诊断：chunk 到了但不在语音轮（GUI 侧交互/换载后残留轮）——留痕
        console.log('voice-bridge chunk 丢弃（engineTurn 未设置）:', String(c.text).slice(0, 20))
        return
      }
      sentAny = true
      push({ type: 'agent/chunk', turn: engineTurn, text: c.text })
    }
    return
  }
  if (event.type === 'tool/call') {
    // P7c 工具过渡语：转发工具名（engineTurn 命中=语音轮；GUI 侧交互轮不扰）
    if (engineTurn !== undefined && d && typeof d.name === 'string' && d.name.length > 0) {
      push({ type: 'agent/tool', turn: engineTurn, name: d.name })
    }
    return
  }
  if (event.type === 'turn/end') {
    if (engineTurn === undefined) {
      console.log('voice-bridge turn/end 丢弃（engineTurn 未设置）:', JSON.stringify(d.reason || {}))
      return
    }
    const reason = (d.reason && d.reason.kind) ? d.reason.kind : 'completed'
    const t = engineTurn; engineTurn = undefined
    if (reason !== 'completed' && !sentAny) push({ type: 'agent/error', turn: t, message: 'turn ' + reason })
    else push({ type: 'agent/turn-end', turn: t, reason })
    // 每轮结束后的压力自检（延迟 1.5s 等空闲落定）
    if (contextCfg !== undefined && contextCfg.compaction && contextCfg.compaction.autoPressure) {
      setTimeout(() => { pressureCompact('每轮').catch(() => {}) }, 1500)
    }
  }
}

const agentIds = new WeakMap<object, number>()
let agentSeq = 0
function agentId(a: any): string {
  if (!agentIds.has(a)) agentIds.set(a, ++agentSeq)
  return '#' + agentIds.get(a)
}

/** 面板展示用：最近一轮语音请求的实际出站配置（request/header 即真相）。 */
let lastServed: { provider: string, model: string, reasoningEffort?: string, at: number } | undefined

/** off 档重派防重入标记（llm/stream 否决+重派路径专用）。 */
const servedStripped = new WeakSet<object>()

/** 0.2 硬迁移点 2（2026-10-06）：流式通道选择。0.2 取消 assistant/chunk 持久
 * 事件（日志只落整段 assistant/message + 新 assistant/attempt），live 文本改
 * 走 agent/assistant-stream 帧（agentEvents 融合派发器发布，payload 带 agent，
 * 根级 {global:true} 可听，按 agent.session.id 过滤——与 P7c agent/request 同
 * 机制，0.1 已实证）。首帧到达即锁定 frames，legacy assistant/chunk（0.1
 * session/event 广播）随之退位——双轨只为升级瞬断与回滚兜底，绝不双推。 */
let streamViaFrames = false

/**
 * P7c v2.1（2026-10-05 深夜）：剥掉单条回放消息里的 reasoning 块。
 * content 与 source.replayState.blocks 用同一谓词过滤，保持 replayedAssistant
 * 的计数/类型对齐（失配也不炸——那边降级为纯文本历史，只是丢文本签名）。
 */
function stripReplayThinking(x: any): any {
  if (!Array.isArray(x?.content) || !x.content.some((b: any) => b?.type === 'reasoning')) return x
  const content = x.content.filter((b: any) => b?.type !== 'reasoning')
  const rs = x?.source?.replayState
  const source = Array.isArray(rs?.blocks)
    ? { ...x.source, replayState: { ...rs, blocks: rs.blocks.filter((b: any) => b?.type !== 'reasoning') } }
    : x.source
  return { ...x, content, ...(x.source !== undefined ? { source } : {}) }
}

/** 读 jarvis-voice 持久化 header 记录的 preset（我们从不换绑，header 即真相）。 */
async function sessionHeaderPreset(): Promise<string | undefined> {
  try {
    const persistence: any = (ctxRef as any).get('sessionPersistence')
    if (persistence === undefined) return undefined
    const headers = await persistence.list()
    // 0.2：snapshot 项字段嵌套在 .header 下（0.1 平铺），双形状兼容（见 presetBoundTo 注）
    const h = Array.isArray(headers) ? headers.find((x: any) => (x.id ?? x.header?.id) === SESSION) : undefined
    return h?.agentPreset ?? h?.header?.agentPreset
  } catch (e) {
    return undefined
  }
}

async function ensureAgent() {
  if (agentsSvc === undefined) throw new Error('agents 服务不可用')
  const opts = modelOptions()
  // 每次重取活实例（followup 目标必须是当前实例；事件订阅已上移到插件 ctx，
  // 与实例换载解耦）。模型选择经根级 agent/request 拦截（apply 注册），与实例无关。
  const live = agentsSvc.get(SESSION)
  if (live !== undefined && live !== agent) {
    console.log('voice-bridge agent 实例已换载:', agentId(live))
    agent = live
    return agent
  }
  if (live !== undefined) return live
  if (agent !== undefined) return agent
  // P7b 修复（2026-09-20）：resume 也必须挂载 header 记录的 preset。
  // agents.resume 自身不做 preset 对齐（那是 apiproxy/GUI 路径 setup 里自己做的），
  // 不挂载则每次 dsh web 重启后首轮 resume 出裸组合实例——deployment 编码智能体
  // 人设顶替、voice_persona/输出规则全部静默丢失（实测：迁移后重启即复现）。
  // 模型选择不在此路径（根级 agent/request 拦截，见 apply）。
  let mountPreset = false
  if (presetsSvc !== undefined) {
    // 审查补（2026-10-06）：register 模式下短暂等待 boot 期首次 preset 注册落定，
    // 关闭"极早唤醒抢在注册前"的竞态窗口（否则落入下方裸 resume，人设/工具
    // 静默丢失直至下次重启）。
    if (typeof presetsSvc.register === 'function') await waitForPresetSync(2000)
    const headerPreset = await sessionHeaderPreset()
    if (headerPreset === PRESET_ID) {
      mountPreset = true
      console.log('voice-bridge resume 将挂载人设 preset:', PRESET_ID)
    }
  }
  try {
    handle = await agentsSvc.resume({
      resumeSessionId: SESSION, agentOptions: opts,
      ...(mountPreset && presetsSvc !== undefined ? {
        setup: async (agentCtx: any) => { await presetsSvc.mount(agentCtx, PRESET_ID) },
      } : {}),
    })
  } catch (e) {
    // 2026-10-06 升级实测教训：preset 定义 broken 时 mount 抛错 → resume 事务
    // 回滚（连会话目录一并清掉）→ create 又撞索引里仍存在的 jarvis-voice →
    // 两路皆灭（引擎播兜底话术、目录消失）。第三层兜底：裸 resume（不挂
    // preset，降级保语音可用——工具丢失但对话活着）。
    // ⚠️ 恢复路径（审查修正，原注释有误）：裸 resume 出的活实例会被上方
    // `agentsSvc.get` 命中并直接复用——preset 恢复要等 host 重启（重新走
    // 带挂载 resume）或面板「重建会话绑定人设」（归档重建）。0.2 下若
    // header 记有 preset，GUI 侧重开 session 也会重绑。
    console.log('voice-bridge resume 带挂载失败，降级裸 resume 保语音:', (e as any)?.message || e)
    try {
      handle = await agentsSvc.resume({ resumeSessionId: SESSION, agentOptions: opts })
    } catch (e2) {
      // P7b：新建即绑定人设 preset（镜像 apiproxy composeAgent：meta.agentPreset
      // 记入 header 供 GUI resume 重建；setup 在未发布窗口内完成挂载，失败整轮回滚）。
      // 预迁移旧会话（header 无 preset）走无 setup resume 维持现状，由面板
      // 「重建会话绑定人设」完成迁移。
      handle = await agentsSvc.create({
        sessionId: SESSION,
        meta: { cwd: VOICE_HOME, agentPreset: PRESET_ID },
        agentOptions: opts,
        ...(presetsSvc !== undefined ? {
          setup: async (agentCtx: any) => { await presetsSvc.mount(agentCtx, PRESET_ID) },
        } : {}),
      })
    }
  }
  agent = handle.agent
  console.log('voice-bridge 会话就绪:', SESSION)
  return agent
}

async function ensureStoreLoaded(): Promise<AgentsStore> {
  if (agentsStore === undefined) {
    const r = await loadAgentsStore()
    agentsStore = r.store
    agentsWarn = r.warn
  }
  return agentsStore
}

const badRequest = (msg: string) =>
  ({ ok: false as const, error: { code: 'bad-request' as const, message: msg, details: { issues: [] } } })

async function onEvent(msg: any) {
  const t = msg && msg.type
  if (t === 'agent/request') {
    const a = await ensureAgent()
    engineTurn = msg.turn; sentAny = false
    console.log('voice-bridge agent/request turn=' + msg.turn + ' agent=' + agentId(a) + ' sse=' + sseAlive())
    a.followup({ id: uuid4(), role: 'user', content: [{ type: 'text', text: String(msg.text || '') }], source: { kind: 'user' } })
    return { ok: true }
  }
  if (t === 'agent/cancel') {
    if (agent !== undefined) { try { agent.cancel('user') } catch (e) {} }
    if (msg.turn !== undefined && msg.turn === engineTurn) engineTurn = undefined
    return { ok: true }
  }
  if (t === 'bridge/ping') return { ok: true, alive: true, session: SESSION }
  return { ok: false, error: 'unknown-type:' + String(t) }
}

async function readJson(req: any): Promise<any> {
  const dec = new TextDecoder()
  let s = ''
  for await (const chunk of req) s += dec.decode(chunk, { stream: true })
  s += dec.decode()
  return s ? JSON.parse(s) : {}
}

function jsonRes(res: any, code: number, obj: any) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

// ---------- 面板：engine RPC 短连代理 ----------
// Hub 协议：连接建立即推 {"type":"state",...} 快照；RPC 应答 {"id","result"|"error"}。
// 短连即连即断，必须按 id 过滤（首条消息是 state 推送，不是应答）。
let rpcSeq = 0
async function engineCall(method: string, params: any, timeoutMs = 3000): Promise<any> {
  const id = 'panel-' + (++rpcSeq)
  const ws = new WebSocket(ENGINE_WS)
  return await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close() } catch (e) {} reject(new Error('engine ws timeout')) }, timeoutMs)
    ws.onmessage = (ev: any) => {
      let m: any
      try { m = JSON.parse(String(ev.data)) } catch (e) { return }
      if (m && m.id === id) {
        clearTimeout(timer)
        try { ws.close() } catch (e) {}
        if (m.error !== undefined) reject(new Error(String(m.error)))
        else resolve(m.result)
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('engine ws error（引擎离线？）')) }
    ws.onopen = () => { try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e: any) { reject(e) } }
  })
}

async function engineState(): Promise<any> {
  try { return await engineCall('get_state', {}, 2500) }
  catch (e: any) { return { offline: true, error: String((e && e.message) || e) } }
}

// ---------- 引擎生命周期托管 ----------
// DSH 进程在沙箱外：由 host detached spawn 的 daemon 不受 agent 会话/任务生命周期影响，
// 且每次 dsh web 启动自愈（引擎没起 → 拉起）。
const ENGINE_PORT = 8076

async function engineAlive(): Promise<boolean> {
  const net = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    let done = false
    const fin = (v: boolean) => { if (!done) { done = true; try { s.destroy() } catch (e) {} resolve(v) } }
    const s = net.connect(ENGINE_PORT, '127.0.0.1')
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
    setTimeout(() => fin(false), 800)
  })
}

async function spawnEngine(extraScript?: string): Promise<number> {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  ensureVoiceHome()
  const fd = fs.openSync(VOICE_LOG, 'a')
  // P7d 打包形态：启动脚本随包分发（<pkg>/python/scripts/），数据根经 VOICE_HOME
  // env 传递给 launcher 与引擎（Python 侧 config.py 同名变量锚定全部数据路径）。
  const args = extraScript !== undefined
    ? ['-c', extraScript]
    : [ENGINE_SCRIPT]
  const child = spawn('bash', args, {
    cwd: VOICE_HOME,
    env: { ...process.env, VOICE_HOME },
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  return child.pid ?? -1
}

async function bootstrapEngine(): Promise<number> {
  // 首次安装（或 venv 损坏）：后台跑 setup-voice.sh（venv+依赖+模型，走代理）。
  // 不阻塞宿主启动——30s 周期探活会在 venv 就绪后自动拉起引擎；
  // 冷却标记防重试风暴（失败安装 10 分钟内不再重试）。
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  ensureVoiceHome()
  const fd = fs.openSync(BOOTSTRAP_LOG, 'a')
  const child = spawn('bash', [BOOTSTRAP_SCRIPT], {
    cwd: VOICE_HOME,
    env: { ...process.env, VOICE_HOME },
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  console.log('dsh-voice: venv 缺失，后台 bootstrap 已启动 (pid=' + (child.pid ?? -1) + '，日志见 logs/bootstrap.log)')
  return child.pid ?? -1
}

async function ensureEngine(): Promise<void> {
  if (await engineAlive()) return
  if (!venvReady()) {
    if (!bootstrapCooldownOk()) return
    markBootstrapAttempt()
    await bootstrapEngine()
    return
  }
  const pid = await spawnEngine()
  console.log('dsh-voice: 引擎未运行，已拉起 (pid=' + pid + ')')
}

async function restartEngine(): Promise<number> {
  // 注意 voice[.]daemon 方括号写法：避免 pkill -f 匹配到自身命令行
  return await spawnEngine('pkill -f "voice[.]daemon" || true; sleep 1.2; exec bash ' + JSON.stringify(ENGINE_SCRIPT))
}

// ---------- jarvis-voice 上下文管理（压缩/清空 + 调度） ----------
// 本部署 web-app 宿主层禁用了 compaction-basic（压缩后端属 preset 层），而
// jarvis-voice 无 preset → 无人压缩。本插件以 auto:false 子插件挂载引擎，
// 触发策略（每轮压力/定时/手动）全部自管，配置存 config/voice-context.json。

const DEFAULT_CONTEXT_CFG = {
  compaction: {
    autoPressure: true,        // 每轮结束按阈值自动压缩
    thresholdRatio: 0.7,       // 用量占比超过即压缩
    retainRatio: 0.25,         // 压缩后保留近段比例
    schedule: { mode: 'off', time: '03:30', intervalHours: 12 }, // off|daily|interval
  },
  clear: { schedule: { mode: 'off', time: '04:00' } }, // off|daily
}

let ctxRef: any = undefined
let contextCfg: any = undefined
let compactionFiber: any = undefined
let compactionEngineInstance: any = undefined
let compactionError = ''
let compactionArmRetries = 0
let scheduleDisposers: (() => void)[] = []

async function loadContextCfg(): Promise<any> {
  const fs = await import('node:fs/promises')
  let cfg: any = {}
  try { cfg = JSON.parse(await fs.readFile(CONTEXT_CFG, 'utf-8')) } catch (e) {}
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONTEXT_CFG))
  const c = cfg.compaction || {}
  merged.compaction = { ...merged.compaction, ...c }
  merged.compaction.schedule = { ...DEFAULT_CONTEXT_CFG.compaction.schedule, ...(c.schedule || {}) }
  const cl = cfg.clear || {}
  merged.clear = { ...merged.clear, ...cl }
  merged.clear.schedule = { ...DEFAULT_CONTEXT_CFG.clear.schedule, ...(cl.schedule || {}) }
  return merged
}

async function saveContextCfg(cfg: any): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.writeFile(CONTEXT_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
}

function validateContextCfg(cfg: any): string | undefined {
  const c = cfg && cfg.compaction
  if (!c || typeof c.autoPressure !== 'boolean') return 'compaction.autoPressure 无效'
  if (!(typeof c.thresholdRatio === 'number' && c.thresholdRatio >= 0.3 && c.thresholdRatio <= 0.95)) return '压缩阈值需在 0.3–0.95'
  if (!(typeof c.retainRatio === 'number' && c.retainRatio >= 0.05 && c.retainRatio < c.thresholdRatio)) return '保留比例需 ≥0.05 且小于压缩阈值'
  const s = c.schedule
  if (!s || !['off', 'daily', 'interval'].includes(s.mode)) return '定时压缩 mode 无效'
  if (s.mode === 'daily' && !/^\d{2}:\d{2}$/.test(s.time || '')) return '定时压缩时间需为 HH:MM'
  if (s.mode === 'interval' && !(typeof s.intervalHours === 'number' && s.intervalHours >= 1 && s.intervalHours <= 168)) return '压缩间隔需 1–168 小时'
  const cs = cfg.clear && cfg.clear.schedule
  if (!cs || !['off', 'daily'].includes(cs.mode)) return '自动清空 mode 无效'
  if (cs.mode === 'daily' && !/^\d{2}:\d{2}$/.test(cs.time || '')) return '自动清空时间需为 HH:MM'
  return undefined
}

async function importCompactionBasic(): Promise<any> {
  // 1) 常规解析（peer 安装在 dsh-voice/node_modules 时直接命中）
  try { return await import('@deepseek-ai/dsh-compaction-basic') } catch (e) {}
  // 2) DSH 部署与 profile 的 node_modules 兜底（包不发布到 registry，随部署分发）
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const os = await import('node:os')
  const bases = [
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/',
    os.homedir() + '/.dsh/profiles/node_modules/',
  ]
  for (const base of bases) {
    try {
      const req = createRequire(base + 'index.js')
      const spec = req.resolve('@deepseek-ai/dsh-compaction-basic')
      return await import(pathToFileURL(spec).href)
    } catch (e) {}
  }
  throw new Error('找不到 @deepseek-ai/dsh-compaction-basic（部署或 profile node_modules 均未命中）')
}

function compactionAvailable(): boolean {
  return compactionEngineInstance !== undefined
}

async function armCompaction(retry = true): Promise<void> {
  if (compactionFiber !== undefined) { try { await compactionFiber.dispose() } catch (e) {} compactionFiber = undefined }
  compactionEngineInstance = undefined
  compactionError = ''
  try {
    const mod: any = await importCompactionBasic()
    const Engine = mod.default ?? mod.BasicCompactionEngine
    const cfg = {
      auto: false,
      thresholdRatio: contextCfg.compaction.thresholdRatio,
      retainRatio: contextCfg.compaction.retainRatio,
    }
    // 壳插件：inject 让 fiber 等齐 llm/tokenMeter/sessions（服务就位才跑 apply，
    // new 出的引擎在子 ctx 上有全部服务访问器）；apply 里捕获实例引用——
    // 子 fiber 提供的服务对祖先 ctx.get 不可见（isolate 链只向下），不能走 ctx.get。
    const host = {
      name: 'dsh-voice-compaction',
      inject: ['llm', 'tokenMeter', 'sessions'],
      apply(c: any) {
        compactionEngineInstance = new Engine(c, cfg)
      },
    }
    compactionFiber = ctxRef.plugin(host)
    if (compactionEngineInstance !== undefined) {
      compactionArmRetries = 0
      console.log('dsh-voice: compaction 引擎已挂载 (threshold=' + cfg.thresholdRatio + ')')
    } else {
      // fiber 仍在等 inject 服务：apply 未跑，延迟重查自愈
      compactionError = '等待 llm/tokenMeter/sessions 就绪'
      if (retry && compactionArmRetries < 6) {
        compactionArmRetries += 1
        setTimeout(() => { if (compactionEngineInstance === undefined) armCompaction() }, 5000)
      }
    }
  } catch (e: any) {
    compactionError = String((e && e.message) || e)
    console.error('dsh-voice: compaction 引擎挂载失败：', compactionError)
  }
}

function compactionEngine(): any {
  return compactionEngineInstance
}

function nextDailyDelay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function armSchedules(): void {
  for (const d of scheduleDisposers) { try { d() } catch (e) {} }
  scheduleDisposers = []
  const addTimer = (fn: () => void, delay: number, rearm?: () => number) => {
    try {
      const disposer = (ctxRef as any).setTimeout(() => {
        fn()
        if (rearm !== undefined) addTimer(fn, rearm(), rearm)
      }, delay)
      scheduleDisposers.push(typeof disposer === 'function' ? disposer : () => {})
    } catch (e) {}
  }
  const cs = contextCfg.compaction.schedule
  if (cs.mode === 'daily') addTimer(() => { pressureCompact('定时').catch(() => {}) }, nextDailyDelay(cs.time), () => nextDailyDelay(cs.time))
  if (cs.mode === 'interval') addTimer(() => { pressureCompact('定时').catch(() => {}) }, cs.intervalHours * 3600000, () => cs.intervalHours * 3600000)
  const cls = contextCfg.clear.schedule
  if (cls.mode === 'daily') addTimer(() => { clearContext().catch(() => {}) }, nextDailyDelay(cls.time), () => nextDailyDelay(cls.time))
}

async function contextStats(): Promise<any> {
  const meter = (ctxRef as any).get('tokenMeter')
  if (meter === undefined) return { available: false, reason: 'tokenMeter 不可用' }
  if (agent === undefined) {
    try { await ensureAgent() } catch (e) { return { available: false, reason: 'agent 未建立' } }
    if (agent === undefined) return { available: false, reason: 'agent 未建立' }
  }
  const m = meter.measure(agent.session)
  let window: any = undefined
  try {
    const sel = effectiveSelection()
    if (sel.provider !== undefined) {
      const llm = (ctxRef as any).get('llm')
      if (llm !== undefined) {
        const info = await llm.resolveModelInfo(sel.provider, sel.model)
        window = info && info.context && info.context.contextWindow
      }
    }
  } catch (e) {}
  return {
    available: true,
    totalTokens: m.totalTokens,
    surfaceTokens: m.surfaceTokens,
    nodes: Array.isArray(m.nodes) ? m.nodes.length : undefined,
    contextWindow: window,
    percent: window ? Math.round((m.totalTokens / window) * 1000) / 10 : undefined,
    compactionAvailable: compactionAvailable(),
    compactionError: compactionAvailable() ? '' : (compactionError || '未知原因'),
  }
}

/* ---------- 模型目录（P7c 收尾）：面板下拉数据源 = ctx.llm 实时目录 ----------
 * 与 apiproxy buildModelCatalog 同源同构（GUI 模型选择器看到什么，我们就列什么）。
 * 只投影叶子字段（id/name/efforts），绝不让服务对象跨 RPC。 */
async function buildModelCatalog(): Promise<any> {
  const llm = (ctxRef as any).get('llm')
  if (llm === undefined) return { available: false, reason: 'llm 服务不可用' }
  const groups: any[] = []
  const failures: any[] = []
  for (const p of llm.listProviders()) {
    try {
      const models: any[] = []
      for (const m of await llm.listModels(p.id)) {
        const info = await llm.resolveModelInfo(p.id, m.id)
        const reasoning = info && info.reasoning !== undefined ? {
          efforts: (info.reasoning.efforts || []).map((e: any) => ({ id: String(e.id), name: String(e.name) })),
          ...(info.reasoning.defaultEffort !== undefined ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}),
        } : undefined
        models.push({ id: String(m.id), name: String(m.name ?? m.id), ...(reasoning ? { reasoning } : {}) })
      }
      if (models.length > 0) groups.push({ id: String(p.id), name: String(p.name ?? p.id), models })
    } catch (e: any) {
      failures.push({ id: String(p.id), name: String(p.name ?? p.id), message: String((e && e.message) || e) })
    }
  }
  return { available: true, groups, failures, defaultSelection: modelOptions() ?? null }
}

/** 保存前活校验：provider/model 必须在目录中可解析；effort（若指定）须在该模型
 * 的档位表内。返回 undefined=通过，否则中文错误。 */
async function validateModelAgainstCatalog(m: AgentModelCfg | null): Promise<string | undefined> {
  if (m === null) return undefined
  const llm = (ctxRef as any).get('llm')
  if (llm === undefined) return undefined   // 目录服务不在 → 只做形状校验（已过）
  let info: any
  try { info = await llm.resolveModelInfo(m.provider, m.model) }
  catch (e: any) { return `模型不可用：${m.provider}/${m.model}（${String((e && e.message) || e)}）` }
  if (m.effort && info && info.reasoning) {
    const ids = (info.reasoning.efforts || []).map((e: any) => String(e.id))
    if (!ids.includes(m.effort)) return `模型 ${m.model} 不支持思考强度「${m.effort}」（可选：${ids.join('、')}）`
  }
  return undefined
}

async function pressureCompact(reason: string): Promise<any> {
  const engine = compactionEngine()
  if (engine === undefined) return { ok: false, error: 'compaction 引擎不可用' }
  const a = await ensureAgent()
  try {
    const r = await engine.compactIfNeeded(a, 'pressure')
    console.log('dsh-voice: 压缩(' + reason + ') ' + (r ? '收敛 ~' + r.shadowedTokenCount + ' tokens' : '未过阈值，跳过'))
    return { ok: true, compacted: r !== null && r !== undefined, shadowed: r ? r.shadowedTokenCount : 0 }
  } catch (e: any) {
    console.error('dsh-voice: 压缩(' + reason + ') 失败:', (e && e.message) || e)
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function manualCompact(): Promise<any> {
  const engine = compactionEngine()
  if (engine === undefined) return { ok: false, error: 'compaction 引擎不可用' }
  const a = await ensureAgent()
  const meter = (ctxRef as any).get('tokenMeter')
  const before = meter !== undefined ? meter.measure(a.session).totalTokens : undefined
  let runs = 0, last: any = undefined
  try {
    for (let i = 0; i < 3; i++) {
      const r = await engine.compactNow(a)
      if (r === null || r === undefined) break
      runs += 1; last = r
    }
  } catch (e: any) {
    const msg = String((e && e.message) || e)
    if (msg.includes('busy')) return { ok: false, error: 'Agent 正在对话中，空闲后再试' }
    return { ok: false, error: msg }
  }
  const after = meter !== undefined ? meter.measure(a.session).totalTokens : undefined
  return { ok: true, runs, before, after, shadowed: last ? last.shadowedTokenCount : 0 }
}

async function setClearPending(v: boolean): Promise<void> {
  const fs = await import('node:fs/promises')
  try {
    if (v) {
      await fs.mkdir(ARCHIVE_ROOT, { recursive: true })
      await fs.writeFile(CLEAR_PENDING, String(Date.now()), 'utf-8')
    } else {
      await fs.rm(CLEAR_PENDING, { force: true })
    }
  } catch (e: any) {
    console.error('dsh-voice: clear-pending 标记读写失败', (e && e.message) || e)
  }
}

async function clearContext(): Promise<any> {
  // 1) 释放我们自己的 handle（写穿队列随之排空）
  try { if (agent !== undefined) agent.cancel('user') } catch (e) {}
  const h = handle; handle = undefined; agent = undefined; engineTurn = undefined
  if (h !== undefined) { try { await h.dispose() } catch (e) {} }
  await new Promise((r) => { setTimeout(r, 400) })
  // 2) 占用检查：仍存活的同 id 会话（典型：GUI 打开着的对话页持有活 agent）会在
  //    归档后向已删除路径写（ENOENT → "本轮运行失败"）。占用 → 登记延迟清空，
  //    下次 dsh web 启动时（GUI 尚未打开会话）自动执行。
  const live = agentsSvc !== undefined ? agentsSvc.get(SESSION) : undefined
  if (live !== undefined) {
    await setClearPending(true)
    return { ok: false, occupied: true, deferred: true,
      error: 'jarvis-voice 正被 GUI 会话页占用。已登记：下次 dsh web 启动时自动清空；或现在关闭该会话页后再点一次立即清空。' }
  }
  // 3) 归档到 sessions 根**之外**（重大教训 2026-09-14：workspace 启动扫描
  //    sessions 根下每个目录并校验日志 header 身份，目录名 ≠ header id 即
  //    corrupt → 整个 DSH 起不来；第一版在根内改名 .bak 实测炸过启动）
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  const archiveRoot = ARCHIVE_ROOT
  const archived: string[] = []
  try {
    await fs.mkdir(archiveRoot, { recursive: true })
    const stamp = Date.now()
    for (const entry of await fs.readdir(root)) {
      const base = path.join(root, entry)
      let st
      try { st = await fs.stat(base) } catch (e) { continue }
      if (!st.isDirectory()) continue
      for (const name of await fs.readdir(base)) {
        // 当前会话目录 + 历史 .bak 残留（第一版产物，留在原地会再次炸启动）都迁走
        const isTarget = name === SESSION || name.startsWith(SESSION + '.bak-')
        if (!isTarget) continue
        const src = path.join(base, name)
        try {
          const sst = await fs.stat(src)
          if (!sst.isDirectory()) continue
          const dest = path.join(archiveRoot, name + '-' + stamp)
          await fs.rename(src, dest)
          archived.push(path.basename(dest))
        } catch (e) {}
      }
    }
  } catch (e) {}
  // 4) 立即重建空白会话（不留缺文件窗口；失败不致命——下次唤醒自愈）
  let recreated = false
  try {
    await ensureAgent()   // 归档后 resume 必失败 → 落到 create；bindAgent 带幂等守卫
    recreated = agent !== undefined
  } catch (e: any) {
    console.error('dsh-voice: 清空后重建会话失败（下次唤醒自愈）:', (e && e.message) || e)
  }
  console.log('dsh-voice: 上下文已清空（归档 ' + archived.length + ' 份，重建 ' + (recreated ? '成功' : '待自愈') + '）')
  await setClearPending(false)
  return { ok: true, archived, recreated }
}

export function apply(ctx: Context): void {
  ctxRef = ctx
  const webServer: any = ctx.get('webServer')
  agentsSvc = ctx.get('agents')
  defaultModelSvc = ctx.get('agentDefaultModel')
  presetsSvc = ctx.get('agentPresets')
  const connection: any = ctx.get('connection')
  if (webServer === undefined || agentsSvc === undefined) {
    console.error('dsh-voice: webServer/agents 服务不可用'); return
  }

  // ---- P7b 人设：preset 注册 + 档案加载 + 提示词变量（全局层注册，
  // 渲染期求值 → 切换 Agent 只改 JSON，下一轮即生效）----
  // 0.2 硬迁移点 1（2026-10-06）：目录式 .agent-presets/ 在 0.2 废除（24 包
  // 全量 grep 为空），改 agentPresets.register({id, plugins}) 行内声明（eager
  // 激活，返回 async disposer 由本插件持有）；registry 无 register（0.1）→
  // 回落写文件。双轨使同一 lib 在 0.1/0.2 都能起——升级瞬断与回滚都无需换码。
  // inject 已加 'agentPresets'：0.2 下注册必须先于 jarvis-voice 会话 resume/
  // create 的 mount，靠服务就绪顺序保证。
  syncVoicePreset(presetsSvc).then((r: any) => {
    if (!r.ok) console.error('dsh-voice: 人设 preset 注册失败：', r.error)
    else console.log('dsh-voice: 人设 preset 已' + (r.mode === 'register'
      ? '注册（agentPresets.register，0.2 通道）'
      : '写入 <DSH_HOME>/.agent-presets/' + PRESET_ID + '/（0.1 文件回落）'))
  })
  ctx.effect(() => () => disposeVoicePreset())
  loadAgentsStore().then((r: { store: AgentsStore, warn: string }) => {
    agentsStore = r.store
    agentsWarn = r.warn
    if (r.warn) console.warn('dsh-voice:', r.warn)
    else if (!agentsStore?.agents.some(a => a.id === agentsStore!.active)) console.warn('dsh-voice: 激活 Agent 缺失（用兜底文本）')
    else console.log('dsh-voice: Agent 档案就绪：' + agentsStore!.agents.length + ' 个，激活「' + activeAgentName(agentsStore) + '」')
  })
  const systemPrompt: any = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.variable('voice_persona', () => personaText(agentsStore)))
    ctx.effect(() => systemPrompt.variable('voice_output_rules', () => rulesText(agentsStore)))
  } else {
    console.error('dsh-voice: systemPrompt 服务不可用，人设变量未注册')
  }

  // P7c v2（2026-10-05）：模型选择器生效点——根级 agent/request 瀑布拦截。
  // 官方选型缝（dsh-agent installModelSelection 同款）：改 `await next()` 的
  // 返回值，而不是给 next() 传参。首版 llm/stream 方案报废的两条机制教训：
  //   1) cordis 瀑布的 next() 忽略传入参数——每层听众拿到的都是原始 args
  //      （实测：上层 next(改写对象)，下层收到的仍是原值），llm/stream 层
  //      从机制上就改不了 provider/model；
  //   2) llm/stream 的返回值必须同步就是异步可迭代流——async 处理器返回
  //      Promise 会把整条请求链炸成 "stream is not async iterable"（信标
  //      探针事故实录：turn/end error×2 + host 崩溃重启）。
  // agent/request 在装配与 request/header 落日志之前生效 → 会话头即出站
  // 真相（日志可直接验证）；async 在此安全（调用方 await 瀑布结果）。注册
  // 于 host 启动期（早于一切 apiproxy 每实例安装）且 prepend → 瀑布最外层
  // =终审权，压过 GUI picked/请求头回退（installModelSelection 不带 prepend
  // 且晚注册，永远在内层）。payload.agent 由 agentEvents 注入（fused
  // payload），按 session.id 过滤只管语音会话。每次请求现读档案，保存即
  // 生效；档案空→放行（跟随部署默认/会话内选择）。
  ctx.effect(() => (ctx as any).on('agent/request', async (payload: any, next: any) => {
    const resolved = await next()
    try {
      const m = modelSelectionOf(activeModel(agentsStore))
      if (m !== undefined && payload?.agent?.session?.id === SESSION) {
        const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
        console.log('dsh-voice: agent/request 模型覆写', JSON.stringify(
          { provider: m.provider, model: m.model, ...(m.reasoningEffort !== undefined ? { reasoningEffort: m.reasoningEffort } : {}) }))
        return {
          ...rest,
          provider: m.provider,
          model: m.model,
          ...(m.reasoningEffort !== undefined ? { reasoningEffort: m.reasoningEffort } : {}),
        }
      }
    } catch (e) { console.error('dsh-voice: agent/request 模型覆写失败（本轮用原选型）:', (e as any)?.message || e) }
    return resolved
  }, { global: true, prepend: true }))

  // P7c v2.1（2026-10-05 深夜）：off 档回放思考剥除——通用语义 + zai 端点怪癖记录。
  // 端点行为（直连探针实测，GLM-5.3 @ open.bigmodel.cn coding 端点）：
  //   thinking:{type:"disabled"} 本身有效（无历史思考时零 reasoning 输出）；
  //   但请求历史里回放着 reasoning_content（早前 high 档轮次留下的思考块，
  //   replayState 保真回放）时，端点无视 disabled 照样思考。
  // dsh→pi-ai 全链路正确（离线全链路复现实测 off 到 wire 就是 disabled），
  // 问题纯在端点侧。**2026-10-05 用户定型：GLM 不提供 off 档**（settings
  // reasoningEfforts 已删 off，目录/面板/校验随之如实收紧，选 off 会被
  // UNSUPPORTED_REASONING_EFFORT 明确拒绝）——本监听器对 GLM 已无触发
  // 路径，保留作为通用语义（任何 provider 档案选 off ⇒ 不回放思考）与
  // 其他模型（如 deepseek 系 off）的防御。
  // 机制注意：llm/stream 的 next() 忽略传参（瀑布把原始 args 直传每层，
  // P7c v2 教训），改不了 options——只能「否决 + 重派」：不调 next()，用
  // 剥除后的 options 重新 llm.stream()（WeakSet 标记防重入）。重派走完整
  // 瀑布（checkpoint/invariant 照常触发，sessionId 在）；返回值必须同步是
  // 异步可迭代流（信标事故：async 处理器返回 Promise 会炸整条请求链）。
  ctx.effect(() => (ctx as any).on('llm/stream', (options: any, next: any) => {
    try {
      const m = modelSelectionOf(activeModel(agentsStore))
      if (m !== undefined && m.reasoningEffort === 'off' && options !== undefined
        && String(options.sessionId ?? '') === SESSION && !servedStripped.has(options)
        && Array.isArray(options.messages)
        && options.messages.some((x: any) => Array.isArray(x?.content) && x.content.some((b: any) => b?.type === 'reasoning'))) {
        const llm: any = (ctx as any).get('llm')
        if (llm !== undefined) {
          const retry: any = { ...options, messages: options.messages.map(stripReplayThinking) }
          servedStripped.add(retry)
          console.log('dsh-voice: off 档剥除回放思考后重派（' + retry.messages.length + ' 条消息）')
          return llm.stream(retry)
        }
      }
    } catch (e) { console.error('dsh-voice: off 档思考剥除失败（按原样发）:', (e as any)?.message || e) }
    return next()
  }, { global: true, prepend: true }))

  // session/event 只挂根级（插件 ctx，session 级广播，换载免疫）。
  // agent 级订阅已移除——2026-09-14 的叠词回归源于"根级+agent 级"双订阅
  // 各推一遍；只保留根级即无双推。2026-09-19 实测：agent 实例会在轮中
  // 被 GUI 打开/compaction 换载，实例级订阅瞬间失聪（首 chunk 后断流）。
  ctx.on('session/event', onSessionEvent as any)

  // 0.2 流式主链路（硬迁移点 2）：agent/assistant-stream 帧根级订阅。帧是
  // 进程内 live 发布（不落日志；start/chunk/end 三态，带 attemptId/revision/
  // turn/step，见 dsh-agent runtime-types AssistantStreamFrame），text-delta
  // 与 0.1 assistant/chunk 的 chunk 同形（dsh-llm StreamChunk 0.2 仍含
  // text-delta+text）。重试会整段重推（attemptId 变化，与 0.1 chunk 行为
  // 一致，TTS 端无需新去重语义）。emit 走 fire-and-forget 回调，本处理器
  // 保持同步快速（push 进 SSE 缓冲）。
  ctx.effect(() => (ctx as any).on('agent/assistant-stream', (payload: any) => {
    try {
      if (payload?.agent?.session?.id !== SESSION) return
      const f = payload?.frame
      if (f === undefined || f.type !== 'chunk') return
      const c = f.chunk || {}
      if (c.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0) {
        if (!streamViaFrames) {
          streamViaFrames = true
          console.log('dsh-voice: 流式通道锁定 agent/assistant-stream（0.2 帧）')
        }
        if (engineTurn === undefined) {
          console.log('voice-bridge frame 丢弃（engineTurn 未设置）:', String(c.text).slice(0, 20))
          return
        }
        sentAny = true
        push({ type: 'agent/chunk', turn: engineTurn, text: c.text })
      }
    } catch (e) { console.error('dsh-voice: assistant-stream 帧处理失败:', (e as any)?.message || e) }
  }, { global: true }))

  // 引擎自愈：boot 时探活拉起；10s 兜底 + 30s 周期（覆盖"dsh web 重启瞬间旧
  // daemon 未死透→探活通过→随后旧 job 灭掉引擎"的边角时序）
  ensureEngine().catch((e: any) => console.error('dsh-voice: ensureEngine 失败', e))
  try { ;(ctx as any).setTimeout(() => { ensureEngine().catch(() => {}) }, 10000) } catch (e) {}
  let ensureTimer: any
  try {
    ensureTimer = (ctx as any).interval(() => { ensureEngine().catch(() => {}) }, 30000)
  } catch (e) {}

  // 上下文管理：加载配置 → 挂 compaction 引擎 → 布置调度
  loadContextCfg().then((cfg: any) => {
    contextCfg = cfg
    armCompaction()
    armSchedules()
  }).catch((e: any) => console.error('dsh-voice: 上下文配置加载失败', e))

  // 延迟清空：上次被 GUI 占用而登记的清空，趁启动早期（会话页未打开）执行
  ;(async () => {
    const fs = await import('node:fs/promises')
    try {
      await fs.access(CLEAR_PENDING)
      console.log('dsh-voice: 检测到延迟清空登记，3 秒后执行')
      setTimeout(() => {
        clearContext().then((r: any) => {
          if (r && r.ok) console.log('dsh-voice: 延迟清空完成')
          else console.log('dsh-voice: 延迟清空仍被占用，保留登记下次再试：', r && r.error)
        }).catch((e: any) => console.error('dsh-voice: 延迟清空失败', e))
      }, 3000)
    } catch (e) { /* 无登记 */ }
  })()

  const disposeEvent = webServer.register({
    kind: 'exact', path: PREFIX + '/event',
    async handler(req: any, res: any) {
      try { jsonRes(res, 200, await onEvent(await readJson(req))) }
      catch (e: any) { jsonRes(res, 400, { ok: false, error: String((e && e.message) || e) }) }
    },
  })
  const disposeStream = webServer.register({
    kind: 'exact', path: PREFIX + '/stream',
    handler(req: any, res: any) {
      if (sseAlive()) { jsonRes(res, 409, { ok: false, error: 'bridge-busy' }); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      sseRes = res
      res.on('close', () => { if (sseRes === res) sseRes = undefined })
      push({ type: 'bridge/ready', session: SESSION })
    },
  })
  const stopBeat = (ctx as any).interval(() => {
    if (!sseAlive()) return
    try { sseRes.write(': ping\n\n') } catch (e) { engineGone() }
  }, 15000)

  // ---- 面板 RPC ----
  if (connection !== undefined) {
    // 0.2（2026-10-06 彩排实测）：connection.rpc face 内部经 createShadow 捕获的
    // owner 是 shadow ctx，其 fiber 链缺 webServer → "cannot get property webServer
    // without inject"。判别：本插件 fiber 上 ctx.webServer 直接可达。绕道
    // ctx.root.connection（root 纤维链可解析），通道注册归 root fiber（本插件
    // 常驻，卸载不撤可接受）。0.1 无此检查，双版本同码。
    ctx.effect(() => (ctx as any).root.connection.rpc.handle('/dsh-voice', async (endpoint: string, _payload: any) => {
      if (endpoint === 'status') {
        const st = await engineState()
        if (st && st.offline) {
          // 自愈：面板开着时探到引擎离线 → 拉起（fire-and-forget，下轮轮询即恢复）
          ensureEngine().catch(() => {})
        }
        return { ok: true as const, value: {
          engine: st,
          bridge: { session: SESSION, sse: sseAlive(), model: effectiveSelection(), served: lastServed },
          persona: { active: activeAgentName(agentsStore), warn: agentsWarn },
        } }
      }
      if (endpoint === 'models/list') {
        // P7c 收尾：模型目录（GUI 同款数据源）——Agent 编辑器模型/思考强度下拉用
        try { return { ok: true as const, value: await buildModelCatalog() } }
        catch (e: any) {
          return { ok: false as const, error: { code: 'internal' as const, message: '目录构建失败: ' + String((e && e.message) || e), details: { issues: [] } } }
        }
      }
      if (endpoint === 'config/get') {
        const cfg = await engineCall('config/get', {})
        return { ok: true as const, value: cfg }
      }
      if (endpoint === 'config/set') {
        const updates = (_payload && _payload.updates) || {}
        const r = await engineCall('config/set', { updates })
        return { ok: true as const, value: r }
      }
      if (endpoint === 'engine/stop') {
        const r = await engineCall('loop/stop', {})
        return { ok: true as const, value: r }
      }
      if (endpoint === 'engine/restart') {
        const pid = await restartEngine()
        return { ok: true as const, value: { restarting: true, pid } }
      }
      if (endpoint === 'engine/preview') {
        // 2026-09-15：preset 试听——真合成一句（realtime 线含会话建立，~2-6s）
        // P7b：voice 非空 = 自定义音色覆盖试听
        const r = await engineCall('tts/preview', {
          preset: String((_payload && _payload.preset) || ''),
          text: String((_payload && _payload.text) || ''),
          voice: String((_payload && _payload.voice) || ''),
        }, 45000)
        return { ok: true as const, value: r }
      }
      if (endpoint === 'music/preview') {
        // 2026-09-20：等待音乐试听（引擎播 N 秒后自停；音箱发声）
        const r = await engineCall('music/preview', {
          seconds: Number((_payload && _payload.seconds) || 5),
        }, 30000)
        return { ok: true as const, value: r }
      }
      if (endpoint === 'wake/get') {
        const r = await engineCall('wake/get', {}, 3000)
        return { ok: true as const, value: r }
      }
      if (endpoint === 'wake/set') {
        // P7c 前置：换唤醒词（拼音生成+词表校验+落盘，引擎自重启加载）
        const r = await engineCall('wake/set', {
          phrase: String((_payload && _payload.phrase) || ''),
        }, 8000)
        return { ok: true as const, value: r }
      }
      if (endpoint === 'log/tail') {
        // 2026-09-20：面板日志 tab——直读引擎日志文件尾部（引擎离线也能读）。
        // 只取最后 256KB 再切行，避免大文件全量进内存。
        const fs = await import('node:fs/promises')
        const n = Math.max(50, Math.min(2000, Number((_payload && _payload.lines) || 300)))
        const LOG = VOICE_LOG
        try {
          const fh = await fs.open(LOG, 'r')
          try {
            const size = (await fh.stat()).size
            const read = Math.min(size, 256 * 1024)
            const buf = Buffer.alloc(read)
            await fh.read(buf, 0, read, size - read)
            let arr = buf.toString('utf-8').split('\n')
            if (read < size && arr.length > 1) arr.shift()   // 首行多半被截半，丢弃
            while (arr.length > 0 && arr[arr.length - 1] === '') arr.pop()
            return { ok: true as const, value: { lines: arr.slice(-n), size } }
          } finally { await fh.close() }
        } catch (e: any) {
          return { ok: true as const, value: { lines: [], error: String((e && e.message) || e) } }
        }
      }
      if (endpoint === 'context/get') {
        return { ok: true as const, value: { stats: await contextStats(), config: contextCfg } }
      }
      if (endpoint === 'context/set') {
        const incoming = _payload && _payload.config
        const err = validateContextCfg(incoming)
        if (err !== undefined) return { ok: false as const, error: { code: 'bad-request' as const, message: err, details: { issues: [] } } }
        contextCfg = incoming
        await saveContextCfg(contextCfg)
        await armCompaction()
        armSchedules()
        return { ok: true as const, value: { saved: true } }
      }
      if (endpoint === 'context/compact') {
        return { ok: true as const, value: await manualCompact() }
      }
      if (endpoint === 'context/clear') {
        try {
          return { ok: true as const, value: await clearContext() }
        } catch (e: any) {
          console.error('dsh-voice: context/clear 异常:', e)
          const stack2 = (e && e.stack) ? String(e.stack).split('\n')[1] : ''
          return { ok: false as const, error: { code: 'internal' as const, message: 'clear 异常: ' + String((e && e.message) || e) + (stack2 ? ' @ ' + stack2.trim() : ''), details: { issues: [] } } }
        }
      }
      // ---- P7b：Agent 档案 ----
      if (endpoint === 'agents/list') {
        const store = await ensureStoreLoaded()
        let ttsOptions: any[] = []
        try {
          const cfg = await engineCall('config/get', {}, 2500)
          ttsOptions = cfg?.config?.['tts.preset']?.options ?? []
        } catch (e) {}
        return { ok: true as const, value: {
          active: store.active,
          common: store.common,
          agents: store.agents,
          ttsOptions, warn: agentsWarn, presetId: PRESET_ID,
          bound: await presetBoundTo(ctxRef, SESSION),
        } }
      }
      if (endpoint === 'agents/save') {
        const store = await ensureStoreLoaded()
        const prevTools: ToolsCfg = activeTools(store)   // P7c：工具绑定档案——激活档案工具变化需重写 preset
        const prevModel = activeModel(store)             // P7c 收尾：模型变化热应用（无需重建会话）
        const v = validateAgent(_payload && _payload.agent)
        if (v.error !== undefined || v.agent === undefined) return badRequest(v.error || 'agent 无效')
        const a = v.agent
        if (store.agents.some(x => x.name === a.name && x.id !== a.id)) return badRequest('已有同名 Agent：「' + a.name + '」')
        // 模型活校验（目录解析 + 档位表）：失败即拒，档案不落盘
        const modelErr = await validateModelAgainstCatalog(a.model ?? null)
        if (modelErr !== undefined) return badRequest(modelErr)
        const idx = store.agents.findIndex(x => x.id === a.id)
        if (idx >= 0) store.agents[idx] = a
        else store.agents.push(a)
        await saveAgentsStore(store)
        console.log('dsh-voice: Agent 已保存「' + a.name + '」(' + (idx >= 0 ? '更新' : '新建') + ')')
        // 编辑的是使用中的 Agent → 音色热切下发（保存即生效；失败不回滚档案，
        // 由下次切换/引擎重启收敛，错误带回面板提示）
        let voiceApplied = false, voiceError: string | undefined = undefined
        if (store.active === a.id) {
          try {
            const engine = await engineCall('config/set', { updates: { 'tts.preset': a.tts.preset, 'tts.voice': a.tts.voice } }, 8000)
            if (engine && engine.ok === false) voiceError = JSON.stringify(engine.errors || engine)
            else voiceApplied = true
          } catch (e: any) {
            voiceError = '引擎离线？' + String((e && e.message) || e)
          }
        }
        // P7c（2026-09-26）：工具绑定 Agent——编辑的是激活档案且工具集变化 →
        // 重写 preset 并归档重建会话（工具是会话级 schema，无法热切）
        let toolsApplied = false, recreated = false
        const nowTools = activeTools(store)
        if (store.active === a.id && JSON.stringify(prevTools) !== JSON.stringify(nowTools)) {
          const preset = await syncVoicePreset(presetsSvc)
          if (preset.wrote) {
            const cleared = await clearContext()
            recreated = !!(cleared && cleared.recreated)
          }
          toolsApplied = true
          console.log('dsh-voice: 激活档案工具变化已应用', JSON.stringify(nowTools), 'recreated=', recreated)
        }
        // P7c v2（2026-10-05）：模型选型变化 → 根级 agent/request 拦截器每次
        // 请求现读档案，保存即生效（下一轮请求自动用新选型，无状态可热应用）
        let modelApplied = false
        if (store.active === a.id && JSON.stringify(prevModel) !== JSON.stringify(activeModel(store))) {
          modelApplied = true
          console.log('dsh-voice: 激活档案模型变化已登记（agent/request 拦截器下一轮生效）', JSON.stringify(activeModel(store)))
        }
        return { ok: true as const, value: { saved: true, agent: a, voiceApplied, toolsApplied, recreated, modelApplied, ...(voiceError ? { voiceError } : {}) } }
      }
      if (endpoint === 'agents/delete') {
        const store = await ensureStoreLoaded()
        const id = String((_payload && _payload.id) || '')
        const idx = store.agents.findIndex(x => x.id === id)
        if (idx < 0) return badRequest('Agent 不存在')
        if (store.active === id) return badRequest('不能删除使用中的 Agent，请先切换到其他 Agent')
        const [removed] = store.agents.splice(idx, 1)
        await saveAgentsStore(store)
        console.log('dsh-voice: Agent 已删除「' + removed.name + '」')
        return { ok: true as const, value: { deleted: id } }
      }
      if (endpoint === 'agents/activate') {
        const store = await ensureStoreLoaded()
        const prevTools: ToolsCfg = activeTools(store)   // P7c：切换档案若工具集不同需重建会话
        const prevModel = activeModel(store)             // P7c 收尾：模型选型随档案热切换
        const id = String((_payload && _payload.id) || '')
        const a = store.agents.find(x => x.id === id)
        if (a === undefined) return badRequest('Agent 不存在')
        // 音色热切 + 持久化先行（失败即中止，active 不落盘，避免人设/音色错位）：
        // tts.preset 展开三键落盘；voice 空串由 daemon 归一化回预设默认。
        // 人设文本经提示词变量按轮读取，此处无需（也无法）预激。
        let engine: any
        try {
          engine = await engineCall('config/set', { updates: { 'tts.preset': a.tts.preset, 'tts.voice': a.tts.voice } }, 8000)
        } catch (e: any) {
          return badRequest('音色下发失败（引擎离线？）已中止切换：' + String((e && e.message) || e))
        }
        if (engine && engine.ok === false) return badRequest('音色切换被引擎拒绝（已中止）：' + JSON.stringify(engine.errors || engine))
        store.active = a.id
        await saveAgentsStore(store)
        // P7c：新旧档案工具集不同 → 重写 preset + 归档重建（同保存路径）
        let toolsApplied = false, recreated = false
        if (JSON.stringify(prevTools) !== JSON.stringify(activeTools(store))) {
          const preset = await syncVoicePreset(presetsSvc)
          if (preset.wrote) {
            const cleared = await clearContext()
            recreated = !!(cleared && cleared.recreated)
          }
          toolsApplied = true
        }
        // P7c v2：模型随档案切换 → 下一轮由 agent/request 拦截器生效（无热应用状态）
        let modelApplied = false
        if (JSON.stringify(prevModel) !== JSON.stringify(activeModel(store))) {
          modelApplied = true
        }
        console.log('dsh-voice: Agent 已切换「' + a.name + '」（音色已热切，人设下一轮对话生效'
          + (toolsApplied ? '；工具集变化已重建会话' : '')
          + (modelApplied ? '；模型选型已热切换' : '') + '）')
        return { ok: true as const, value: { activated: a.id, engine, toolsApplied, recreated, modelApplied } }
      }
      if (endpoint === 'common/set') {
        const store = await ensureStoreLoaded()
        const v = validateRules(_payload && _payload.outputRules)
        if (v.error !== undefined || v.rules === undefined) return badRequest(v.error || '输出规则无效')
        store.common.outputRules = v.rules
        await saveAgentsStore(store)
        console.log('dsh-voice: 公共输出规则已更新（' + v.rules.length + ' 字，下一轮对话生效）')
        return { ok: true as const, value: { saved: true } }
      }
      if (endpoint === 'agents/migrate') {
        // 一次性迁移：归档旧会话 → ensureAgent 走 create 路径绑定人设 preset
        try {
          const clear = await clearContext()
          return { ok: true as const, value: { clear, bound: await presetBoundTo(ctxRef, SESSION) } }
        } catch (e: any) {
          console.error('dsh-voice: agents/migrate 异常:', e)
          return badRequest('迁移失败: ' + String((e && e.message) || e))
        }
      }
      return { ok: false as const, error: { code: 'bad-request' as const, message: `unknown endpoint ${endpoint}`, details: { issues: [] } } }
    }, { authority: 'loopback' }), 'dsh-voice: rpc')
  }

  ctx.effect(() => () => {
    if (typeof stopBeat === 'function') stopBeat()
    if (ensureTimer !== undefined && typeof ensureTimer === 'function') ensureTimer()
    for (const d of scheduleDisposers) { try { d() } catch (e) {} }
    scheduleDisposers = []
    if (compactionFiber !== undefined) { try { compactionFiber.dispose() } catch (e) {} compactionFiber = undefined }
    disposeStream(); disposeEvent()
    if (sseRes !== undefined) { try { sseRes.end() } catch (e) {} sseRes = undefined }
    const h = handle; handle = undefined; agent = undefined; engineTurn = undefined
    if (h !== undefined) { try { h.dispose() } catch (e) {} }
  })
  console.log('dsh-voice 就绪: bridge=' + PREFIX + ' panel=/dsh-voice session=' + SESSION)
}
