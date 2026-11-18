# 昨晚为什么卡了十几个小时

调查对象：`m01571`「昨天晚上执行的几个任务卡了十几个小时 查下怎么回事」
数据来源：283 个会话日志（`C:\Users\admin\.dsh\sessions`，468 MB）+ Windows 系统日志
时区：全部为本地时间（Asia/Shanghai）。日志里的 `time` 是 epoch ms，需 +8h 才是本地。

---

## 一句话

**不是 DSH 卡死，是 Windows 自己睡了。** 11-10 19:44:26 机器进入 S3 待机，11-11 09:55:20 才被唤醒——**14 小时 10 分 54 秒**。当时有三个会话正有 turn/作业在飞，全部被冻在那一秒，唤醒后才靠超时+重试续上。

第二独立的损失：11-10 18:10:18 装插件触发的宿主重载，把 4 个在飞 turn 判 `disposed` 杀掉，合计 **2h56m** 的活白跑，输出 token 已经产出 87 万。

---

## 二、铁证：睡眠窗口

`Get-WinEvent -LogName System` + `Microsoft-Windows-Power-Troubleshooter`（Id 1）+ `Kernel-Power`（Id 42）。
日志保留窗口 2026-06-15 → 2026-11-11，全窗口只有 **39 次** ≥1 分钟的睡眠。

| 窗口 | 入睡 | 唤醒 | 时长 | 唤醒源 |
|---|---|---|---|---|
| A | 2026-11-10 16:38:44 | 16:49:45 | 11m01s | Intel USB 3.20 可扩展主机控制器 |
| **B** | **2026-11-10 19:44:26** | **2026-11-11 09:55:20** | **14h10m54s** | 同上 |

日志原文（UTC）：`睡眠时间: 2026-11-10T11:44:26.449Z` / `唤醒时间: 2026-11-11T01:55:20.020Z`

**为什么会在任务跑着的时候睡**：Windows 的"空闲"只看键鼠输入，不看 CPU/磁盘/网络。DSH 干活时用户人不在，30 分钟没按键就判定空闲 → 睡。
原设置 `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`：交流 = `0x00000708` = **1800 秒**；直流 = `0x00000384` = 900 秒。方案 = 平衡。机器是台式机（无电池，ChassisTypes=3），所以只看交流值。
系统支持的睡眠状态：S3、休眠、快速启动；S0 低电量待机不支持。

**这不是一次意外，是每晚都在发生**：39 次睡眠里绝大多数是 14.2–14.5 小时的整夜。7-20 → 8-21 几乎每天一条：14.42h、14.41h、14.38h、14.37h、14.36h、14.36h、14.32h、14.32h、14.28h…… 10-07→10-08 那条 13.44h，11-10→11-11 这条 14.18h。**只要晚上有任务在跑，第二天早上就一定是这个症状。**

### 已修

```
powercfg /change standby-timeout-ac 0
```

复核：`STANDBYIDLE 交流 = 0x00000000`（永不睡眠）、`HIBERNATEIDLE 交流 = 0x00000000`、`VIDEOIDLE 交流` 仍 `0x00000258`（10 分钟关屏，不影响执行）。
**立即生效，不需要重启。** 顺带确认：没有任何 `WakeToRun` 的计划任务（全是 Disabled），所以刚才那一觉是人为/自动睡眠而非唤醒定时器造成。

### DSH 侧没有自救能力

- `C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\resources\` 下（`app\dsh`、`runtime`、`app.asar.unpacked`）grep `powerSaveBlocker|SetThreadExecutionState|ES_CONTINUOUS|ES_SYSTEM_REQUIRED|prevent-app-suspension|keepAwake|preventSleep` = **0 命中**。
- 对 213 MB 的 `app.asar` 备份全文扫描同样 7 个关键字 = **0 命中**。
- Electron 主进程只用到 `powerMonitor` 的两个事件：`resume`（醒来后检查更新）和 `shutdown`（非 win32 时置 `sessionEnding`）。**没有任何防睡眠调用。**

所以 DSH 在 sleep 面前就是被冻住的普通进程——这不是它的 bug，但它也确实没做任何防护。

---

## 三、睡眠瞬间，三个会话在干什么

| 会话 | 睡前一秒 | 醒后 | 冻了多久 |
|---|---|---|---|
| **Pixel4Root** `session-02d2c857` | 19:41:37 `step/start`（turn9 step47） | 09:55:18 `ATTEMPT-FAILED`（流里已有 reasoning chunks）→ `RETRY opendesign 936ms` → 10:01:33 `MSG in=131,330 out=39,444` | **14h13m** |
| **SrcAntiDex** `session-dd0c5c46` | 19:44:20 `step/start`（turn2 step183） | 09:55:18 `ATTEMPT-FAILED` → `RETRY design2 469ms` → 09:55:34 `MSG` → `turn/end aborted/user`（用户按了停止） | **14h10m** |
| **whatsapp-android** `session-372a8aa6` | 19:42:24 `JOB+ pwsh-4909d21174ad4f0b`（`python tools/run_suites.py --check-docs --check-masks`） | 09:55:18 `tool/result` = `[still running after 600000ms; moved to background job pwsh-4909d21174ad4f0b]` → 09:55:26 `job_output wait:true timeout_ms:600000` → 09:55:58 `JOB-`。turn11 从 18:59:34 拖到 09:56:16 = **14h56m**，`aborted/user` | **14h18m** |
| DSHSpeed 本会话 | 19:31:30 `turn/end completed`，无在飞 | 09:57:17 用户发「确认写入」才起新 turn | 未受影响 |

窗口 A（16:38→16:49，11 分钟）同样命中 3 个会话：CoinsBot 的 `pwsh-f7a1290916524b9a` 作业被冻、SrcAntiDex turn16 step244 醒后报 `pi-ai stream idle timeout after 90000ms`、Pixel4Root turn2 step105 醒后连报两次 `ATTEMPT-FAILED` 再 RETRY。

### 时间归因（窗口 11-10 16:00 → 11-11 10:10，只看 ≥20 分钟的 turn）

16 个长 turn，时钟跨度合计 **52.83h**，其中**睡眠解释 42.55h = 80.5%**，真正醒着跑的是 **10.28h**。

| 项目 | turn | 跨度 | 睡着 | 醒着 | 步 | 工具 | 结束 |
|---|---|---|---|---|---|---|---|
| Pixel4Root | 9 | 15.72h | 14.18h | 1.54h | 127 | 126 | 未闭合 |
| whatsapp-android | 11 | 14.95h | 14.18h | 0.76h | 148 | 186 | aborted |
| SrcAntiDex | 2 | 14.93h | 14.18h | 0.75h | 183 | 182 | aborted |
| SrcAntiDex | 18 | 1.17h | 0 | 1.17h | 194 | 194 | aborted |
| Pixel4Root | 1 | 0.98h | 0 | 0.98h | 160 | 177 | aborted |

---

## 四、第二块损失：18:10:18 装插件杀掉 4 个在飞 turn

全库 `turn/end` 且 `reason.reason.kind === "disposed"` 的事件共 **11 次、5 波**：

| 时间 | 会话 | turn | 已跑 | 步 | 已产出 token |
|---|---|---|---|---|---|
| **2026-11-10 18:10:18** | Pixel4Root `02d2c857` | 5 | 15m26s | 18 | 98,935 |
| **2026-11-10 18:10:18** | whatsapp-android `416dcf68` | 1 | 32m15s | 95 | 147,129 |
| **2026-11-10 18:10:18** | SrcAntiDex `8bd28a6a` | 18 | **1h10m** | 194 | 258,537 |
| **2026-11-10 18:10:18** | Pixel4Root `f18271d0` | 1 | 58m44s | 160 | 366,623 |
| 2026-10-15 13:44:39 | 三会话 | — | 合计 35m45s | 126 | — |
| 2026-11-05 18:53:58 | CoinsBot `a5840d86` | 5 | 43s | — | — |
| 2026-11-06 10:16 / 10:36 | CoinsBot `eb65eaf3` | 5, 6 | 5m19s + 2m53s | — | — |
| 2026-11-10 18:59:00 | DSHSpeed `cb237c47` | 3 | 9m29s | 17 | — |

**11-10 18:10 那波合计 2h56m、87 万输出 token 被丢弃。**

### 为什么是"装插件"的锅

`.plugin-manager\logs\operation-*\pnpm.log` 的 mtime 与每一波 disposed 对得上：

| 波次 | 最近的 pnpm 操作 | 差值 |
|---|---|---|
| 10-15 13:44:39 | `operation-nKUOfW` 13:45:05 | 同分钟 |
| 11-05 18:53:58 | `operation-rVXQQj` 18:51:57 | 2 分钟前 |
| **11-10 18:10:18** | **`operation-7TqLuF` 18:09:15** | **58 秒前** |
| 11-10 18:59:00 | `operation-92EjWR` 18:58:52 | 8 秒前 |

`.plugin-manager` 下 11-10 全天有 8 次操作（17:04:03、18:09:20、18:47:49、18:48:01、18:48:10、18:48:13、18:58:52、19:05:49）。

**机制**：`plugin_manager` 装/卸插件 → 跑 `pnpm install` → 宿主重载 → agent scope teardown → 每个在飞 turn 收到 `machine.cancel({ kind: "disposed" }, { keepInbox: !ready })`（`...\@deepseek-ai\dsh-agent-loop\lib\index.js:1496`）→ `abortedCancelCause` 映射成 `{kind:"aborted", reason:{kind:"disposed"}}`（`:503`）。这是**设计行为**，但代价是"装个插件就把别人的活干掉"。

更糟的是 **goal 自动续跑看到 disposed 就直接解除武装**：`...\@deepseek-ai\dsh-goal-round-driver\lib\index.js:279` `if (event.data.reason.reason.kind === "disposed") { disarm(state); return; }` —— 所以这些 turn **不会自己恢复**，必须人手动"继续"。

### 全库宿主重启 83 次

用 `session/end-seed` 事件聚簇（5 分钟窗口）：133 个 end-seed → **83 次重启**（2026-09-22 → 11-10）。密集段：09-30 一天 6 次、10-08 3 次、10-19 6 次、10-21→22 6 次、**11-04 一天 8 次（全是 WhatsAppX）**、11-06 5 次、11-10 4 次。

**机器本身没重启过**：`EventLog` 6005/6006 在 20 天内只有 2026-11-02 13:09:45 STOPPED / 13:10:18 BOOT-START 一对，`LastBootUpTime` = 2026-11-02 13:10:10。Application 日志 17:30–19:30 只有 `adb.exe` 在 `ucrtbase.dll` 里反复崩（`0xc0000409`，BEX），**没有 DeepSeek Harness / electron / node.exe 的任何崩溃记录**。→ 83 次全是客户端进程重启，不是断电/蓝屏。

### 顺带发现：commandcode provider 装了个不兼容的版本

`operation-7TqLuF\pnpm.log` 原文：

```
dsh: warning: Plugin @mars-sea/dsh-commandcode-provider@0.15.1 is incompatible
with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.2.0-rc.2 || 0.2.1-rc.2"}.
Running it may cause crashes or data loss. Update the plugin or install a plugin
version compatible with this dsh runtime. To accept this risk explicitly, grant
the exact-version exemption for @mars-sea/dsh-commandcode-provider@0.15.1 on
dsh 0.2.2-rc.1 with `dsh plugin allow-version` or the plugin manager, then retry
the installation or restart dsh. Exact-version exemption: not active.
```

`0.15.1` 声明的引擎范围不含 `0.2.2-rc.1`，且未豁免 → profile 启动会 deny 它，但 profile patch 里仍在配 `llm-commandcode`（`:133-139`）。

---

## 五、"不是睡眠"的长 gap 也是分得清的

### 长 CALL→RESULT（≥20 分钟，共 10 个）

其中 **5 个是 `ask_user_question` 在等人回答**（设计行为，不是卡死）：
- CoinsBot `30d39907`：27m04s / 54m00s（问节点缺口、旧池要不要用）
- CoinsBot `86b9c224`：**12h27m** / 2h54m（问注册怎么恢复、注册在烧号要不要停）
- CoinsBot `a99479ea`：56m28s / **13h33m**（watchdog launcher、枚举 powershell 进程）、1h06m（edit `Pixel4BuildPool.kt`）
- whatsapp-android `766cb20d`：28m57s（问定时提醒怎么处理）

另 2 个是真构建耗时：CoinsBot `3cbf4d0d` 44m59s（`gradlew assembleDebug`）、KernelForge `36436eba` 56m04s（`gradle testDebugUnitTest`）。

### 全库 in-turn gap 分类（≥5 秒，睡眠已从各档扣除）

`total gap 518.6h，OS 睡眠 43.1h，醒着 gap 475.5h`

| 类别 | 次数 | 醒着耗时 | 占比 |
|---|---|---|---|
| `step/start -> assistant/message`（等模型出整段结果） | 59,301 | **231.5h** | 48.7% |
| `tool/call -> tool/result`（工具真执行） | 3,787 | **83.8h** | 17.6% |
| `job/registered -> job/settled`（后台作业生命周期） | 6,026 | **61.2h** | 12.9% |
| `user/message -> assistant/message`（首个 TTFT） | 4,288 | 20.3h | 4.3% |
| `approval/asked -> approval/decided`（等人工审批） | 40 | 17.4h | 3.7% |
| `tool/call -> job/settled`（工具转后台） | 427 | 10.2h | 2.1% |
| `request/header -> assistant/message` | 1,664 | 9.0h | 1.9% |
| `job/registered -> tool/result` | 133 | 7.8h | 1.6% |
| `assistant/attempt`（重试/新尝试） | 430 | 7.5h | 1.6% |

→ **一半以上的"卡着"其实是模型在思考（`step/start → assistant/message`）**，这一段在 89.5% 的步里一个正文 token 都不吐。

### 全库 in-turn gap ≥60 秒的睡眠归因

`总计 229.5h，其中 OS 睡眠 43.1h = 18.8%；2873 个 turn 里只有 7 个被睡眠命中过`

最长的 13 个 ≥20 分钟 gap：睡眠解释 3 个，其余 10 个全是等人（审批 / ask_user_question）或真构建。

---

## 六、真·上游卡死那族：流空闲超时

`assistant/attempt` 失败全库 **680 次**，attempt 本身烧掉 **41h24m**；而 `llm/retry` 声明的重试延迟合计只有 **20m23s**。
→ **失败的真实代价是"卡在流里等超时"，不是重试延迟。** 扣掉跨睡眠的 28h43m，真·上游不吐字约 **12h41m**。

Top 失败家族（次数 / 累计 attempt 时长）：

| # | 家族 | 次 | 时长 |
|---|---|---|---|
| 1 | `TIMEOUT \| pi-ai stream idle timeout after <n>ms` | **79** | **33h35m** |
| 2 | `TRANSPORT \| Connection error.` | 76 | 44m20s |
| 3 | `SERVER \| database_unavailable…resolve Billing Scope` | 66 | 5m27s |
| 4 | `SERVER \| failed to evaluate membership entitlement` | 42 | 5m23s |
| 5 | `SERVER \| workspace_billing_scope_unavailable` | 22 | 14m41s |
| 6 | Cloudflare 5xx `error-<n>` | 20 | 14m17s |
| 7 | `TIMEOUT \| Request timed out.` | 20 | 9m09s |
| 8 | `TIMEOUT \| Command Code API…did not respond within <n>ms` | 19 | 2h00m |
| 9 | `RATE_LIMIT \| Command Code 账号 usage window 耗尽` | 18 | 10m31s |
| 11 | `MALFORMED_RESPONSE \| Tool call "pwsh": Unexpected non-whitespace character after JSON` | 14 | 4m11s |
| 12 | `Tool call "read": Unexpected non-whitespace character after JSON` | 8 | 47s |
| 13 | `OUTPUT_TOKEN_LIMIT \| Command Code …finish_reason=length` | 7 | 4m30s |

### 流空闲超时的两个子集

`pi-ai stream idle timeout` 共 **86 次 / 34h25m**：

- **4 次跨睡眠，实睡 28h43m** → 假超时（就是上面那两觉造成的）。这 4 次的 `streamIdleTimeoutMs` 无所谓设多大都会超，因为进程整个不跑。
- **82 次真·上游不吐字，烧 5h38m（均 4m08s）**。

按超时设置值分：

| 设置值 | 次数 | 涉及路由 |
|---|---|---|
| **90000 ms（90 秒）** | **66** | 全是 `opendesign/deepseek-v4.1-flash`（SomeClass 35、CoinsBot 12、WhatsAppX 12、whatsapp-android 5、Pixel4Root 1、SrcAntiDex 1） |
| 300000 ms（默认 5 分钟） | 13 | opendesign 8、xiaomi 3、design2 2 |
| 无记录 | 7 | dsh-opencode-go |

**超时后还要等多久才恢复**（64 次在同一个 step 内恢复）：
`p50 11.3s、p90 161.2s、最大 375.2s；累计额外等待 0.85h`
90 秒那 66 次里，**42 次在 30 秒内就恢复了**（说明上游只是卡了一下），**12 次要再等 ≥60 秒**。

### 关键配置：opendesign 把 90 秒门槛设得比默认低 3.3 倍

`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml:191`

```yaml
        streamIdleTimeoutMs: 90000      # ← 默认是 300000
        retryPolicy:
          mode: normal
          maxRetries: 4
          backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 }
```

DSH 默认：`...\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:944` `const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;`，`:1130` `source.streamIdleTimeoutMs ?? 3e5`。
看门狗：`:1997-1998` `idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT")`；`:2051` 抛 `pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`。

`bigmodel`、`design2` 都没设 → 走 300000。`dsh-sdk-minimal` 的 shipped patch 把它设成 `172800000`（2 天）→ 说明这个字段能设很大。

**结论**：90 秒对 reasoning 模型偏紧。reasoning 阶段经常几十秒不吐可见输出，被砍一次要付 800ms–8s backoff + 重发整段 prompt，而省下的是"本来可能 1–2 分钟才出字"的等待。

---

## 七、能改的四件事（按性价比排）

### 1. 已经做了：禁止睡眠

`powercfg /change standby-timeout-ac 0` —— 已完成，立即生效。这是 14 小时那两次的唯一解。

### 2. 装/卸插件前先确认没有在飞任务

这是 2h56m 的来源。要么等 turn 都结束再装，要么接受重载会杀掉所有 in-flight。**没有配置能关掉这个行为**（`disposed` 是 agent scope teardown 的硬语义）。

### 3. 把 opendesign 的 `streamIdleTimeoutMs` 从 90000 提到 300000

改 `C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml:191` 一行。代价：真卡死时要多等 3.5 分钟才触发重试。收益：不再误砍"其实还在想"的请求（66 次里 42 次 30 秒内就恢复了，说明多半是误砍）。

### 4. commandcode provider 升级或豁免

`@mars-sea/dsh-commandcode-provider@0.15.1` 对 `dsh 0.2.2-rc.1` 不兼容。它同时是 web 搜索后端（`web.searchProvider=commandcode`），所以不能简单删掉——要么升级到声明支持 0.2.2 的版本，要么 `dsh plugin allow-version` 显式豁免。留着一个被 deny 的 provider 只会在启动日志里不断报错。

---

## 八、还有一个待办：compaction 配置还没加载

`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml` 的 mtime 是 **2026-11-11 10:23:13**（我今天上午写入的 `preset-standard` 覆盖），而当前 Electron 主进程 StartTime = **2026-11-10 18:59:11**。
→ 那份 compaction 配置（`thresholdRatio 0.45` / opendesign `0.4` / `maxTokens 32768`）**尚未被加载**，必须重启客户端才生效。生效前，`summarization truncated` 那族截断仍会按旧默认（`thresholdRatio 0.8` → 838,400）走。

---

## 附：复现脚本

全部在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`，用 bundled node 跑：

```powershell
$node = 'C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --max-old-space-size=12288 <script>
```

| 脚本 | 作用 |
|---|---|
| `exportsleeps.ps1` | 从系统日志导出 39 个睡眠区间 → `sleeps.json` |
| `sleepattr.mjs` | 全库 in-turn gap ≥60s 的睡眠归因 + 最长 gap 清单 |
| `hang5.mjs` | 两个睡眠窗口内各会话在干什么 + 醒后前 14 条事件 |
| `hang6.mjs` | 窗口内 ≥20m turn 的跨度/睡着/醒着/步数/工具数/结束原因 |
| `kill.mjs` | `disposed` 杀 turn 清单 + 与 pnpm 操作 mtime 关联 |
| `restarts.mjs` | `session/end-seed` 聚簇成 83 次宿主重启 |
| `gapclass.mjs` | 按事件类型对（prev → next）分类全部 in-turn gap |
| `idle2.mjs` | 86 次流空闲超时按设置值/路由分 |
| `idle3.mjs` | 超时后到下一次 assistant/message 的等待分布 |
| `failfam.mjs` | 680 次 attempt 失败按归一化消息聚簇 |
| `disposed.mjs` | 扫 985 个 js 找 `"disposed"` 出处 |
| `asarscan.mjs` / `asarctx.mjs` | 全文扫 213MB `app.asar` 备份找保活代码 |
| `sleeptotal.ps1` | 39 次睡眠的时长汇总 |

## 附：日志解析两个必踩的坑

1. **会话日志是多帧 zstd 拼接**。单次 `zstdDecompressSync` 只解第一帧（215 B，只有 session header）。必须按 magic `28 B5 2F FD` 扫描所有偏移切帧，再逐帧解压拼接。
2. **`time` 是 epoch ms UTC**。`new Date(t + 8*3600e3).toISOString()` 才是本地时间，直接 `new Date(t)` 早 8 小时——会把 19:44 的睡眠看成 11:44。
