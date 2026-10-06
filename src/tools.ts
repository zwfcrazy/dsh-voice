/* dsh-voice tools：jarvis-voice preset 私有工具（P7c 两层工具架构的第二层）。
 *
 * 两层架构（2026-09-25 用户定型）：
 *   1) 全局缝工具——如 web_search（provider 换后端，所有会话含丁满可用）；
 *   2) 丁满私有工具——经本模块（preset 行 name:'dsh-voice/tools'）挂载，仅语音
 *      会话的 tool schema 可见，其他会话不可见、不可用。属丁满的一部分，
 *      不单独建包。
 *
 * 运行时依赖装载：dsh-voice 自带 node_modules 不含 @deepseek-ai/dsh-tools
 * （部署本地包，不发布 npm），沿用 dsh-web-search-tavily 验证过的
 * resolve+import(URL) 锚点模式（dsh-voice importCompactionBasic 先例；
 * 注意不能用 require() 直呼——require(ESM) 在 dsh web 进程不可用）。
 *
 * 通道：每次调用独立短连 daemon WS（ws://127.0.0.1:8076，回环建连 ~ms 级；
 * 音量调整低频，不与主桥/面板共享连接，规避跨入口模块单例问题）。
 * 副作用边界：工具只做 RPC 热改（config/set 落盘+生效），无本地副作用需清理。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-voice-tools'
export const inject: string[] = ['tools', 'systemPrompt']

const ENGINE_WS = 'ws://127.0.0.1:8076'

/** resolve+import(URL) 装载 defineTool（锚点与 dsh-voice importCompactionBasic 一致）。 */
async function loadDefineTool(): Promise<any> {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const os = await import('node:os')
  const anchors = [
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/index.js',
    os.homedir() + '/.dsh/profiles/node_modules/index.js',
    os.homedir() + '/.dsh/profiles/web/index.js',
  ]
  const req0 = createRequire(import.meta.url)
  let path: string | undefined
  try { path = req0.resolve('@deepseek-ai/dsh-tools') } catch { /* 包旁无安装 */ }
  for (const a of anchors) {
    if (path !== undefined) break
    try { path = createRequire(a).resolve('@deepseek-ai/dsh-tools') } catch { /* 下一锚点 */ }
  }
  if (path === undefined) throw new Error('找不到 @deepseek-ai/dsh-tools（包旁/部署/profile 均未命中）')
  const mod: any = await import(pathToFileURL(path).href)
  return mod.defineTool
}

/** daemon 短连 RPC：跳过状态广播，只收匹配 id 的回复。 */
function daemonRpc(method: string, params: any, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try { ws = new WebSocket(ENGINE_WS) } catch (e) { reject(e); return }
    let settled = false
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close() } catch { /* 已关 */ } fn() }
    const timer = setTimeout(() => finish(() => reject(new Error('daemon RPC 超时(' + method + ')'))), timeoutMs)
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method, params })) } catch (e) { finish(() => reject(e as Error)) } }
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data))
        if (m && m.id === 1) finish(() => resolve(m))
        /* 其余消息（state 广播等）跳过 */
      } catch { /* 非 JSON 广播，跳过 */ }
    }
    ws.onerror = () => finish(() => reject(new Error('daemon WS 连接失败（语音引擎不在线？）')))
    ws.onclose = () => finish(() => reject(new Error('daemon WS 连接中断')))
  })
}

export async function apply(ctx: Context): Promise<void> {
  const defineTool = await loadDefineTool()

  ctx.systemPrompt.section({
    name: 'tool:voice_volume',
    order: 111,
    text: 'Use the voice_volume tool when the user asks to change or check this assistant\'s speaking volume (e.g. 大声一点/小声一点/音量调到百分之六十/现在音量多少). Omit percent to query the current volume; for relative requests (大一点/小一点), query first, then set the computed absolute percent.',
  })

  ctx.tools.register(defineTool({
    name: 'voice_volume',
    description: '调节或查询语音助手自己的播报音量（丁满说话的响度，不影响其他设备声音）。用户提出音量相关请求时调用。',
    parameters: {
      percent: {
        type: 'number',
        description: '目标音量百分比（5–150，100 为正常）。省略则只查询当前音量。相对调整请先查询再换算成绝对百分比。',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args: any, value: any) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args: any) {
      const pct = args?.percent
      if (pct === undefined || pct === null) {
        const r = await daemonRpc('config/get', {})
        const v = r?.result?.config?.['tts.volume']?.value
        if (typeof v !== 'number') return '查询失败：语音引擎未返回音量（' + JSON.stringify(r).slice(0, 120) + '）'
        return '当前播报音量：' + Math.round(v * 100) + '%'
      }
      const p = Math.max(5, Math.min(150, Math.round(Number(pct))))
      if (!Number.isFinite(p)) return '音量数值无效'
      const r = await daemonRpc('config/set', { updates: { 'tts.volume': p / 100 } })
      const ok = (r?.result?.ok) ?? (r as any)?.ok
      if (ok !== true) {
        const errs = r?.result?.errors ?? r
        return '音量调整失败：' + JSON.stringify(errs).slice(0, 200)
      }
      return '播报音量已调到 ' + p + '%（立即生效，已记住）'
    },
  }))
}
