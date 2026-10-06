/**
 * dsh-voice 路径解析（P7d 打包形态）
 *
 * - PKG_ROOT：包根（本文件构建后位于 lib/，上溯一级）。link: 与 github: 安装
 *   均成立——模块永远从 <pkg>/lib/index.js 加载。
 * - VOICE_HOME：数据根（config/models/assets/logs/.venv），env 可覆盖，
 *   默认 ~/.dsh/voice。与 Python 侧 voice/config.py 的 REPO_ROOT 语义对齐。
 * - 引擎启动/bootstrap 脚本随包分发（python/scripts/），与数据根解耦。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VOICE_HOME = process.env.VOICE_HOME || path.join(os.homedir(), '.dsh', 'voice')

export const ENGINE_SCRIPT = path.join(PKG_ROOT, 'python', 'scripts', 'daemon-start.sh')
export const BOOTSTRAP_SCRIPT = path.join(PKG_ROOT, 'python', 'scripts', 'setup-voice.sh')

export const VOICE_LOG = path.join(VOICE_HOME, 'logs', 'voice.log')
export const BOOTSTRAP_LOG = path.join(VOICE_HOME, 'logs', 'bootstrap.log')
export const CONTEXT_CFG = path.join(VOICE_HOME, 'config', 'voice-context.json')
export const ARCHIVE_ROOT = path.join(VOICE_HOME, 'logs', 'session-archive')

/** venv 就绪判定（bootstrap 完成的标志） */
export function venvReady(): boolean {
  return fs.existsSync(path.join(VOICE_HOME, '.venv', 'bin', 'python'))
}

/** 首次使用/日志写入前保证数据目录骨架存在（幂等） */
export function ensureVoiceHome(): void {
  fs.mkdirSync(path.join(VOICE_HOME, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(VOICE_HOME, 'config'), { recursive: true })
}

/** bootstrap 重试冷却：避免宿主 30s 周期探活把失败的 pip 安排成重试风暴 */
export const BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000

export function bootstrapCooldownOk(): boolean {
  const marker = path.join(VOICE_HOME, '.bootstrap-last-attempt')
  try {
    const st = fs.statSync(marker)
    return Date.now() - st.mtimeMs > BOOTSTRAP_COOLDOWN_MS
  } catch {
    return true
  }
}

export function markBootstrapAttempt(): void {
  try {
    ensureVoiceHome()
    fs.writeFileSync(markerPath(), String(Date.now()) + '\n')
  } catch (e) {
    console.error('dsh-voice: 写 bootstrap 标记失败', e)
  }
}

function markerPath(): string {
  return path.join(VOICE_HOME, '.bootstrap-last-attempt')
}
