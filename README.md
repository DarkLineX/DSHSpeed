# dsh-speed-audit

时间审计：把 DSH 每个回合的墙钟时间拆成「模型往返 / 工具执行 / 宿主间隙」，再把模型往返拆成「首 token 等待 / 思考流 / 工具参数流 / 正文流」。

回答的问题不是「花了多久」，而是「花在哪一段」。

## 为什么需要它

`@deepseek-ai/dsh-session-stats` 已经给出 `llmMs` / `toolMs` / `ttftMs` / `decodeMs`，但口径是「总共花了多少」。真实的体感问题是另一回事：

- 一步里模型往返花了 11.7 秒，其中 **6.87 秒在等首 token**，一个 token 都还没出来——这就是「墨迹」的来源。
- 89.7% 的步一次只调一个工具，每停一次就付一次完整的模型往返。
- 生成的内容里 93.6% 是不可见的思考，你看到的正文只占 6.4%。

这些都得逐阶段归因才看得见。

## 它统计什么

| 字段 | 含义 |
|---|---|
| `ms.stepWall` | 回合净工作墙钟（Σ `step/start` → `step/end`） |
| `ms.model` | 模型往返（Σ 首 token 等待 + 各流式块 `dt` 之和） |
| `ms.tool` | 工具执行（`tool/call` → `tool/result` 配对） |
| `ms.stepGap` | 步与步之间的调度缝 |
| `ms.llm.ttft` | 首 token 等待 |
| `ms.llm.reasoning` | 思考流式生成 |
| `ms.llm.toolArgs` | 工具参数 JSON 流式生成 |
| `ms.llm.text` | 正文流式生成 |
| `share.*` | 上面各项的占比，直接喂给面板的条形图 |
| `counts.visibleSteps` | 有正文输出的步数（你能看见东西的步） |
| `counts.zeroStreamSteps` | 整个生命周期零流式块的步（纯等待） |
| `tools[]` | 按工具名聚合：次数、总时长、均值、峰值 |
| `toolLatency` | 工具耗时 p50 / p90 / p99 / max 与分桶 |
| `turns[]` | 每个回合的墙钟与「第一句正文出现得多晚」 |
| `stepAgeMs` | 当前这一步已经跑了多久（未开 step 时为 null） |
| `turnAgeMs` | 当前回合一共有多久 |
| `textAgeMs` | 距上一次有正文落盘多久 |
| `lastTool` | 最近一次工具调用：`{name, command, open, ageMs, durationMs}` |

## 接口

三条路由，都只允许回环地址或已配对的设备。

```http
GET /api/dsh-speed-audit/snapshot
```

内存中每个活跃会话的实时折叠。面板每 1.5 秒拉一次。

两个查询参数：

- `?id=<session-id>` — 只返回这一个会话（先精确匹配，再按包含关系宽松匹配，因为浏览器侧的会话 id 不保证与宿主侧逐字节一致）。未知 id 返回空的 `sessions`。
- `?light=1` — 省掉 `tools` / `toolLatency` / `turns` 三个大字段，只留状态条需要的标量。输入框下方的运行条每秒拉一次，用这条路径。

```http
GET /api/dsh-speed-audit/sessions
```

列出磁盘上所有会话日志（`<sessions-root>/<escaped-cwd>/<session-id>/session.v<N>.jsonl.zstd`）。

```http
GET /api/dsh-speed-audit/audit?file=<绝对路径>
```

回放一份历史日志，返回与 `snapshot` 同形状的对象（多带 `recentTools`）。`file` 必须落在 sessions root 之内，且文件名匹配 `session.v\d+.jsonl.zstd`。

## 两个数据通路，一套折叠

- **live**：订阅 `session/event`，为内存中的每个会话累积状态。
- **replay**：按需读取权威 JSONL 日志。

两条路都走同一个 `applyEvent()` 折叠，所以同一份日志无论实时看还是事后回放，数字必须一致。

### 两个必须知道的实现细节

**1. 会话日志是多帧 zstd 拼接。**
一次 `zstdDecompressSync` 只解出第一帧（约 215 字节，只有 session header）。
必须按 magic `28 B5 2F FD` 扫描所有偏移切帧，再逐帧解压后拼接，才是完整 JSONL。

**2. 时间戳必须统一取事件自带的 `time`。**
`chunk.time0` 是请求起始时间的拷贝，**不能**当成耗时用。
实时折叠若混入 `Date.now()`，回放时会与历史事件时间相互插值，算出负数和天文数字。
所以 `applyEvent` 一律读 `event.time`，只有事件缺这个字段时才回退到到达时间。

## 组装

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: dsh-speed-audit
```

本插件只需要 `webServer` 与 `sessions` 两个服务，不依赖 token-meter 或投影注册表。

## 安装

以本地目录形式装在 `~/.dsh/profiles/<profile>/plugins/dsh-speed-audit`，
在 profile 的 `package.json` 的 `dependencies` 里写 `"dsh-speed-audit": "file:./plugins/dsh-speed-audit"`，
并加进 `dsh.profile.bundles`，然后跑 `pnpm install`。

**只在 `cordis.patch.yml` 里写 `insert` 行是不够的**——包必须在 `node_modules` 下可解析，
否则加载器会静默跳过它。

改完 `lib/*.js` 后需要重启客户端让宿主半重载；浏览器半随页面刷新重载。

**`plugins/` 与 `node_modules/` 是两份独立的实体文件，不是软链。** 宿主加载的是 `node_modules`
那一份，所以每次改完都要双写，否则只有源码变了、跑的还是旧的：

```powershell
$a = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-speed-audit"
$b = "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-speed-audit"
Copy-Item "$b\lib\index.js"  "$a\lib\index.js"  -Force
Copy-Item "$b\lib\client.js" "$a\lib\client.js" -Force
```

## 输入框下方的运行条

`conversation.composer.dock` 槽位上多挂了一个 `id: speed-audit-live` 的条目（与自带的 `activity` /
`usage` 并列，不替换它们）。它只在会话有打开的回合时出现，内容形如：

```
● 工具执行中  python tools\run_suites.py --check-docs  · 步 1m48s · 无正文 1m48s · 本回合 3m12s
```

三档颜色：绿（在推进）、黄（距上次正文超过 60 秒，或 `verdict` 为 slow）、红（工具超过 2 分钟没回，
或距上次正文超过 3 分钟）。悬停能看到完整数字，包括未完成工具和它的耗时。

**为什么它自己算时间而不只读宿主的字段。** 宿主的快照里有 `stepAgeMs` / `turnAgeMs` / `textAgeMs`，
但那份代码要重启客户端才加载。浏览器半是热重载的，所以它自己按 turn/step 身份变化和
`counts.visibleSteps` 增长来打时间戳；宿主哪天发了这些字段就直接采信。这样条带对两种宿主都成立。

## 已知边界

- 内存中最多跟踪 64 个活跃会话，超出后淘汰最久未活动的。
- 回放是同步的，282 个会话全量跑完约 16 秒（平均 58ms/会话）。单个大日志的 `audit` 请求会阻塞事件循环，不要在前端并发打。
- 有 24 个会话日志回放不出任何 step（历史格式差异或日志截断），这些会被 `audit` 正常返回但 `counts.steps` 为 0。
- 崩溃打断的步在日志尾部落不到 `step/end`，实时折叠会把它算成未闭合——这是真实状态，不是 bug。
