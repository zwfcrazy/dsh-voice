# dsh-voice

丁满语音助手的 DSH 插件：voice-engine 桥 + 语音会话（jarvis-voice）+ 设置面板（tab 版：状态/配置）。

## 功能

- **桥**：`GET/POST /voice-bridge/{stream,event}`——engine(Python) 与 DSH agent 会话的 SSE+POST 中继（流式 chunk→TTS）；`session/event` 订阅挂插件根 ctx（agent 实例换载免疫，2026-09-19）
- **会话**：固定 `jarvis-voice`，live→resume→create 跨重启续聊
- **引擎生命周期托管**：boot 探活自动拉起 daemon（detached，不随 agent 会话死）；面板探到离线也会自愈；UI 一键重启
- **面板**（设置页「语音助手」，6 个 tab）：
  - 状态：引擎/桥接实时监控（2s）+ 停止播报 / 重启引擎 + 当前 Agent
  - 语音：ASR 模型·热词 / TTS 音量 / 断句静默（热生效）/ 等待音乐开关·音量·试听（音色属 Agent 档案，本页不再出现）
  - 唤醒词：换词（中文→拼音 token 自动生成 + tokens.txt 词表校验 + 写文件 + 引擎自重启，旧词备份 .bak；个别音节词表外会被拒并提示）/ 检测阈值·前缀抗剪枝加权
  - 上下文：用量进度条 + 自动压缩（每轮压力/定时/阈值/保留比）+ 自动清空（每日定时）+ 立即压缩/清空按钮
  - 日志：引擎日志尾部实时滚动（2s 刷新、子串过滤、ERROR/WARNING 着色、上翻暂停跟随）
  - Agent（P7b）：公共设置（输出格式，所有 Agent 生效）+ Agent 档案（个性 = 人设提示词 + 音色，预设或自定义音色 id + 试听）；新建/保存/删除/切换；编辑使用中的 Agent 保存即热切音色；首次启用需一次性「重建会话绑定人设」（旧会话归档）；工具/技能属 P7c
- **Agent 机制**：档案存 `config/voice-agents.json`（插件拥有）；人设 preset `~/.dsh/.agent-presets/jarvis-voice/`（插件幂等生成，仅 persona 一行，text 为 `{{voice_persona}}`/`{{voice_output_rules}}` 模板）——插件注册两个全局提示词变量按轮渲染，切换 Agent 只改 JSON，下一轮生效，不动 preset/会话
- **上下文管理**：compaction-basic 以 auto:false 子插件挂载（本部署宿主层禁用了它，voice 会话原无压缩），触发策略自管；清空 = 归档会话目录空白重建（.bak 可找回）
- **配置写入**：host RPC → daemon `config/get|set` 白名单；能热改的即时生效（音量/音色/等待音乐），其余保注释写回 `config/voice.toml` 并提示需重启
- **面板 RPC**：`status / config/* / engine/{stop,restart,preview} / music/preview / wake/{get,set} / log/tail / context/* / agents/{list,save,delete,activate,migrate} / common/set`（log/tail 直读 `logs/voice.log` 尾部 256KB，引擎离线也可读；agents/activate 会向引擎下发 tts.preset+tts.voice 热切；wake/set 校验通过即写 keywords 文件并自重启加载）

## 安装

### 换机安装（github 通道，推荐）

```
dsh plugin --profile web add github:zwfcrazy/dsh-voice
dsh web   # 重启生效
```

首次启动时插件发现 venv 缺失会自动后台 bootstrap（`python/scripts/setup-voice.sh`）：
建 venv → 经代理安装依赖（`python/requirements.txt`，整包 pin）→ 播种资源（预合成话术/
等待音乐/silero-VAD/配置模板）→ 下载 sherpa KWS 模型。全程幂等、不覆盖已有文件，
日志在 `~/.dsh/voice/logs/bootstrap.log`；完成后 30s 周期探活自动拉起引擎，无需再重启。
代理默认 `http://192.168.31.46:7897`，`VOICE_PROXY=<url>|none` 可覆盖（与开发库 `scripts/_net.sh` 同约定）。

前置条件：Linux + PipeWire（parecord/paplay/pactl）、Python 3.11、Node >= 22 / DSH 0.2.0-rc.2。

### 开发库（本机源）

```
dsh plugin --profile web add link:/home/jarvis/dsh/project_dingman/dsh-voice
dsh web   # 重启生效
```

引擎源码唯一源在开发库 `src/voice/`；改引擎后运行 `scripts/package-sync.sh`
同步进包再构建提交（`python/` 下不要手改）。

## 运行时布局（P7d 起）

| 位置 | 内容 |
| --- | --- |
| `<包>/python/` | 引擎源码 + launcher/bootstrap 脚本 + requirements + 首装种子（随包分发，升级即换） |
| `$VOICE_HOME`（默认 `~/.dsh/voice/`，env 可覆盖） | 数据根：`config/`（voice.toml、voice-agents.json）、`models/`（VAD+KWS）、`assets/`（话术/音乐）、`logs/`（voice.log、session-archive）、`.venv/`（升级不丢） |

云端 Key 不入包：`~/.config/voice/secrets.env`（权限 600），配置中仅引用变量名。

## 从旧布局迁移（开发库直跑 → VOICE_HOME）

旧形态数据在开发库内（config/models/assets/logs 随代码）。迁移 = 拷 `config/*.toml|json`、
`models/`、`assets/`、`logs/` 到 `$VOICE_HOME` 对应位置，再跑一次 `python/scripts/setup-voice.sh`
建 venv；唤醒词词条/预合成话术均为"已存在不覆盖"，用户状态无损。

## License

MIT
