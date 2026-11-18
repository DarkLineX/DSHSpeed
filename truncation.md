# 输出 token 上限截断：根因与修复

## 一句话

那条横幅**不是"你说得太长被截断"**，而是 **DSH 原生压缩（compaction）失败 → 上下文没被收缩 → 这一轮被判 `max-tokens` 提前结束**。
`billion-context` 一直在拦 DSH 的原生压缩，所以这条路径从来没真正跑过；关掉它，它第一次跑起来，并且第一次就跑死了。

而且代价比横幅本身大得多：**9 次里有 7 次，模型已经把活干完了，最后一步才冒出 `length`，整轮连同前面几十上百步一起被作废 —— 累计 890 步、92.5 万 token、3.35 小时。**

---

## 一、数据：全库只有 9 次

283 个会话、81,662 个 `assistant/message`：

| stopReason | 次数 |
|---|---|
| toolUse | 56,561 |
| (无记录) | 23,117 |
| stop | 1,958 |
| **length** | **9** |

`turn/end` 的 `reason.kind` 分布（前端横幅的显示条件就是 `kind === "max-tokens"`）：

| kind | 次数 |
|---|---|
| completed | 2,500 |
| aborted | 186 |
| error | 130 |
| interrupted | 26 |
| blocked | 9 |
| **max-tokens** | **9** |

**这 9 条里只有 1 条是真的"输出打满"**：2026-10-08 QEMU_KVM_Android，`maxTokens=8192`，输出正好 `8192`。
另外 8 条输出的 token 数是 16、16、366、625、966、1387、2041、4604 —— 全都远低于预算，而且内容块**只有 reasoning、没有正文也没有 tool-call**。

所以：**这不是"输出太多"，是模型还没开始写就被判了 length。**

---

## 二、真正的因果链（源码级）

### 1. 上游返回 `length` → DSH 记成 `max-tokens`

`C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:1504`

```js
case "length": return { kind: "max-tokens" };
```

### 2. 压缩也用同一个 LLM 通道，`max-tokens` 被当成硬失败

`...\@deepseek-ai\dsh-compaction-basic\lib\index.js:358-369`

```js
function finishError(finish) {
  switch (finish.kind) {
    case "error":
    case "aborted": return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    case "max-tokens": {
      const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
      error.code = "MAX_TOKENS";
      return error;
    }
```

### 3. agent-loop 遇到 max-tokens 直接收工，不续写

`...\@deepseek-ai\dsh-agent-loop\lib\index.js:966` / `:770`

```js
if (finish.kind === "max-tokens") return { kind: "max-tokens" };
if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
```

一旦是 max-tokens，后续 step 也覆盖不掉 → turn 结束 → 前端弹横幅。

### 4. 横幅文案（`dsh-client-ui-chat\lib\client.js:6706-6707`）

```
"message.maxTokens":       "已达到输出 token 上限"
"message.maxTokens.hint":  "回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。"
```

渲染条件 `dsh-client-ui-chat\lib\client.js:12701`：

```js
if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "max-tokens") return void 0;
```

**文案是误导的**：它说的是"回答被截断"，实际这一轮根本没产出回答。

---

## 三、为什么以前看不到：billion-context 把原生压缩拦掉了

`compaction/end` 全库 **11,714 次**：

| 结果 | 次数 |
|---|---|
| 成功 | **4** |
| 失败 | **11,710**（99.97%） |

失败原因聚类：

| 次数 | 原因 |
|---|---|
| 8,027 | `dsh-opencode-go/deepseek-v4.1-flash: {"type":"server_error","code":"dsh_compaction_refused"...}` |
| 2,784 | `Command Code 请求失败（HTTP 403）（dsh_compaction_refused）` |
| 863 | `{"code":"dsh_compaction_refused","message":"dsh native compaction..."}` |
| 8 | HTTP 403 家族 |
| 5 | `the request exceeds the model's context window` |
| **2** | **`summarization truncated at the token cap (incomplete checkpoint)`** |
| 其余 | Invalid credential / gpt-6-luna overflow |

拦截方在 billion-context：`C:\Users\admin\.dsh\profiles\desktop\node_modules\billion-context\dist\agent\dsh-native.js`

```js
function compactionDirectRefusal(url) {
  const message = "billion-context refused this request locally: it is a dsh native-compaction
  summarize call (final user message starts with the COMPACTION_INSTRUCTION directive), and ...
  This ONE compaction attempt fails; dsh continues the turn normally. ..."
  // → 422 { error: { code: "bili_gate_dsh_compaction_refused" } }
}
```

还有一行配置检查的日志，说明这是**无条件拒绝**：

```
[acp-config] ... was removed (#3651, superseding #2028) — value(s) ignored:
dsh native compaction is now refused unconditionally by the wire guard on every lane.
```

所以：

- **billion-context 开着** → 原生压缩被 422 拒掉 → 但它自己的 `<bili-snapshot v1>` 快照压缩接管（**0.2 秒，不调 LLM**）→ 上下文照样降下来 → 从不弹横幅。
- **billion-context 关掉** → 原生压缩真正跑起来 → 走 `summarizeWithLlm` → 撞上问题 → 压缩失败 → 弹横幅。

四次成功压缩的真身：

| 时间 | 耗时 | 类型 |
|---|---|---|
| 2026-09-23 15:26 | 26.4s | 原生 LLM 摘要 |
| 2026-09-24 10:48 | 67.5s | 原生 LLM 摘要 |
| 2026-11-03 18:13 | 0.1s | `<bili-snapshot v1>` |
| 2026-11-10 19:06 | 0.2s | `<bili-snapshot v1>` |

---

## 四、2026-11-10 那两次的完整现场

会话 `session-02d2c857-c739-4777-85f3-17ee27215572`（Pixel4Root），路由 `opendesign/deepseek-v4.1-flash`，`maxTokens=128000`，`contextWindow=1048000`：

```
19:00:26  compaction/prune × 33（shadowedTokenCount 合计 131,846）
19:00:26  compaction/start  {compactionId:"99ad71d0-...", turn:7}
19:00:40  compaction/end    error: "summarization truncated at the token cap (incomplete checkpoint)"
19:00:40  step/start
19:00:56  assistant/message  in=669,123  cache=6,144(0.9%)  out=16  stop=length  blocks=reasoning
19:00:56  turn/end           {"kind":"max-tokens"}   ← 弹横幅

19:02:43  用户发「压缩会话 继续」→ turn 8
19:02:51  compaction/end    error: 同上
19:02:57  assistant/message  in=71  cache=675,200(100%)  out=16  stop=length
19:02:57  turn/end           {"kind":"max-tokens"}   ← 又弹

19:06:05  compaction/start  {compactionId:"0bed7333-..."}
19:06:05  compaction/summary "<bili-snapshot v1 conv=\"session-02d2c857-...\">"
19:06:05  compaction/end    成功（0.2s）
19:07:02  assistant/message  in=87,842  out=6,119  stop=toolUse   ← 立刻恢复
```

顺带一个值得单独记的副作用：**prune 会打掉 prompt 缓存。**
那一轮 prune 了 131,846 token，导致下一次请求的缓存命中率从（正常时的）接近 100% 掉到 **0.9%**，669,123 token 全部重新计费、重新 prefetch。
压缩本来是为了省时间，压缩失败的时候反而**先付了一笔 67 万 token 的重算成本**。

那两步的实际输出（`seq 3951` / `seq 3961`）：

```json
{"type":"reasoning","text":"Let me get the current state and make concrete progress. The user wants results tonight"}
```
```json
{"type":"reasoning","text":"Let me compress the session as requested, then continue the work.\n\nActually the user"}
```

第二句**被硬切在 "Actually the user" 中间**，流式 `dt:[0,0,0,0,0,0,0,0]`。
`maxTokens` 是 128,000，实际只出了 16 个 token 就被判 `length`。

**结论：模型刚开始 thinking 的第一句还没写完，上游就返回了 `stopReason:"length"`。**

---

## 五、这 9 次到底浪费了多少

把每个被判 `max-tokens` 的轮子逐步骤拆开（`turnsteps.mjs` / `trunccost.mjs`），会看到一个更难看的事实：**9 次里有 7 次，模型已经把活干完了，最后一步才冒出 `length`，然后整轮被作废。**

| 会话 | 轮 | 轮内成功步 | 成功产出 | 触发截断那一步 | 轮时长 |
|---|---|---|---|---|---|
| KernelForge | turn2 | **613** | 436,360 tok | 966 tok | **4,607s（77 分钟）** |
| KeyBox | turn12 | 121 | 267,662 tok | 1,387 tok | 3,385s |
| whatsapp-python | turn9 | 62 | 70,511 tok | 2,041 tok | 1,876s |
| KeyBox | turn17 | 27 | 87,927 tok | 4,604 tok | 1,045s |
| CoinsBot | turn14 | 25 | 28,826 tok | 625 tok | 353s |
| whatsapp-android | turn14 | 42 | 34,275 tok | 366 tok | 436s |
| Pixel4Root | turn7 / turn8 | 0 | 0 | 16 tok | 30s / 14s |
| QEMU_KVM_Android | turn1 | 0 | 0 | 8,192 tok | 319s |

合计：**890 个已经跑完的成功步、925,561 个 token 的产出、3.35 小时的工作，被最后那一步 16～4,604 个 token 的意外截断一次性作废。**

而这 7 次里最离谱的是 KeyBox turn12：

```
... <msg toolUse out=2710> | ? | <msg length out=1387> | ? | <msg toolUse out=2300> | ?
```

`length` 之后**这一轮还在继续跑**，又跑了一个成功步才结束。也就是说那一轮实际是正常收尾的，但 `turn/end` 依然被记成 `max-tokens`、依然弹横幅。

原因在 `...\@deepseek-ai\dsh-agent-loop\lib\index.js:770`：

```js
if (turnEnds === null || turnEnds.kind !== "max-tokens") turnEnds = stepEnd;
```

**一旦轮内出现过一次 max-tokens，后面的 step 就再也覆盖不掉它** —— 这是个粘滞标记，不是"最终状态"。

所以你看到的"频繁出现"，实际频次是 9 次，但每次的代价都不对等：Pixel4Root 那种是 30 秒空转，KernelForge 那种是 **77 分钟 + 613 步全部作废**。

---

## 六、为什么不是"上下文太大"

按输入规模分桶，截断率与规模**完全无关**：

| 输入区间 | 请求数 | length | 比例 |
|---|---|---|---|
| 0–50k | 4,488 | 1 | 0.022% |
| 50–100k | 25,802 | 1 | 0.004% |
| 100–200k | 35,826 | 4 | 0.011% |
| 200–300k | 9,910 | 1 | 0.010% |
| 300–400k | 2,256 | 0 | 0 |
| 400–500k | 1,105 | 0 | 0 |
| 500–600k | 940 | 0 | 0 |
| 600–700k | 661 | 2 | 0.303% |
| 700–900k | 759 | 0 | 0 |
| 900k+ | 24 | 0 | 0 |

同样 `opendesign` 路由、同样 ≥400k 输入，按日期：

| 日期 | 请求数 | length | 最大输入 |
|---|---|---|---|
| 2026-10-22 | 79 | 0 | 664k |
| 2026-11-04 | 727 | 0 | 754k |
| 2026-11-05 | 497 | 0 | **920k** |
| **2026-11-10** | **2** | **2** | 675k |

2026-11-05 08:37–08:40 连续十几次 900k+ 输入全部 `stop=toolUse`（输出 91～2354）。
按 `reasoningEffort` 也一样：`max` 41,106 次里 5 次（0.012%）、`high` 39,352 次里 4 次（0.010%）。

**675k 输入本身完全不是原因。**

### 换个口径再看：按「未缓存新增 token」分桶

缓存读不算真正的输入压力，去掉它只看 `inputTokens`（真正要新算的部分）：

| 新增 token | 请求数 | length | 比例 |
|---|---|---|---|
| 0–1k | 46,825 | 4 | 0.009% |
| 1–10k | 31,071 | 3 | 0.010% |
| 10–30k | 2,062 | 0 | 0 |
| 30–60k | 738 | 1 | 0.136% |
| 60–100k | 563 | 0 | 0 |
| 100–200k | 394 | 0 | 0 |
| 200–400k | 176 | 0 | 0 |
| 400–600k | 72 | 0 | 0 |
| **600–800k** | **16** | **1** | **6.25%** |

同样口径下 `opendesign` 输入总量 ≥600k 的请求共 **701 次**，只有 **2 次** `length`：

| 日期 | 请求数 | length | 平均新增 |
|---|---|---|---|
| 2026-10-22 | 2 | 0 | 322k |
| 2026-11-04 | 213 | 0 | ~0k（几乎全缓存命中） |
| 2026-11-05 | 484 | 0 | ~1k（几乎全缓存命中） |
| **2026-11-10** | **2** | **2** | **335k** |

`新增 ≥400k` 的 opendesign 请求全历史只有 3 条：

| 时间 | 新增 | 缓存 | 输出 | stop |
|---|---|---|---|---|
| 2026-10-22 12:00 | 641k | 20k | 285 | toolUse ✅ |
| 2026-11-05 14:22 | 459k | 334k | 135 | toolUse ✅ |
| 2026-11-10 19:00 | 669k | 6k | 16 | length ❌ |

所以「新增 token 极大 + 几乎零缓存」是最接近的触发条件，但 641k 新增那次是成功的 —— **它只是把概率推高，不是充分条件**。

### 决定性反证：第二次尝试缓存命中 100%，照样 16 token 就 length

那两步的真实 token 账（`cachebreak.mjs`）：

| 时刻 | 输入(未缓存) | 缓存读 | 命中率 | 输出 | stop |
|---|---|---|---|---|---|
| 19:00:56 | 669,123 | 6,144 | **0.9%** | 16 | length |
| 19:02:57 | 71 | 675,200 | **100.0%** | 16 | length |

第二次请求的输入**完全命中缓存、只需要新算 71 个 token**，上游依然在 reasoning 第 16 个 token 处返回 `length`。

**这一条把"上下文太大""新增 token 太多""缓存被 prune 打断"三个假设全部排除。**
剩下的只有一种：**上游 opendesign 这一侧主动返回了 `length`。**

日志能证到的边界：上游在 reasoning 第 16 个 token 处返回 `stopReason:"length"`。至于上游为什么这么做（thinking 预算？那次 67 万 token 的 summarize 请求把它打进了异常态？并发/限流？），会话日志里没有这个信息，只能看到 DSH 这一侧的反应。

---

## 七、修复

原生压缩的配置项在 profile 里从来没设过 —— `dsh-base` 挂载时是裸的：

`...\@deepseek-ai\dsh-base\cordis.patch.yml:355-356`
```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
```

默认值（`dsh-compaction-basic\lib\index.js:63-67, 82-85`）：

```js
const headroomTokens = config.headroomTokens ?? 65536;
const maxTokens      = config.maxTokens ?? headroomTokens;   // → 65,536
const thresholdRatio = config.thresholdRatio ?? 0.8;
const retainRatio    = config.retainRatio ?? 0.16;
const compactionRetries = config.compactionRetries ?? 1;
```

压缩触发点（`:124-131`）：

```js
const messageBudgetTokens  = contextWindow - reservedCompletionTokens;    // 1,048,000 - 128,000 = 920,000
const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens; // 920,000 - 65,536 = 854,464
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
// = min(1,048,000 × 0.8, 854,464) = min(838,400, 854,464) = 838,400
```

注意 `thresholdRatio` 乘的是 **contextWindow**，不是 pressureBudget —— 所以默认触发线是 **838k**，比想象中更靠后。
也就是说：**它一直拖到 83 万 token 才动手，而那时摘要请求本身已经带着几十万 token 的输入，最容易死在半路。** 而 `C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml` 里 grep `compaction-basic|summarization|headroom` = **0 命中**，从来没有人覆盖过这些默认值。

### 关键：不能直接往 profile 顶层写 `- id: compaction-basic`

第一版就是这么写的，**不生效**。原因在 `...\@deepseek-ai\dsh-web-app\cordis.patch.yml:545`：

```yaml
- id: compaction-basic
  disabled: true
```

按 `dsh-app-boot` 的 `composeEntries` 组合后，顶层那一行是 `{"path":"compaction-basic","disabled":true,"hasConfig":true}` —— 宿主层这份是**关着的**（注释写着 token meter 留在宿主层、压缩后端搬进了 preset）。往一个 `disabled: true` 的行上写 config，只会写到一个不会启动的节点。

真正的装载点是 preset 内部的两层嵌套：

```
preset-standard
  └─ compaction        (cordis:group, isolate: {compaction, toolResultPruner})
       └─ compaction-basic   ← 这里才是活的
       ├─ command-compact
       └─ tool-result-pruner
```

`preset-standard` 定义在 `...\@deepseek-ai\dsh-web-app\presets\standard.patch.yml`，在当前 profile 下装了 22 个 plugin。而本机 283 个会话的 `agentPreset` 分布是 **standard 242 / 无字段 40 / cordis 1** —— 覆盖 standard 就够。

### 正确做法：整份覆盖 `preset-standard` 的 declaration

官方 skill（`...\@deepseek-ai\dsh-agent-preset\skills\editing-cordis-compositions\SKILL.md:54-66`）写得很明确：**按 Loader row id 覆盖，不要 insert**，并且要 `restate id、plugins 和 shipped 文件里的每一个字段** —— 因为 patch 是**整键替换、不深合并**（`dsh-app-boot\lib\index.js:505`：`const { id, insert, name, ...overrides } = patch;` 然后 `target[key] = value`）。

已写入 `C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml` 的是这样一段（142 行，抄自客户端当前生效的 `standard.patch.yml`，只在 `compaction-basic` 上加了 `config:`）：

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # ... 原样 22 项 ...
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              thresholdRatio: 0.45        # 触发点 1048000*0.45 = 471600（默认 0.8 → 838400）
              headroomTokens: 65536
              maxTokens: 32768            # 摘要输出预算
              retainRatio: 0.12           # 压缩后保留 920000*0.12 = 110400
              compactionRetries: 2        # 默认只重试 1 次
              modelPolicies:
                - provider: opendesign
                  model: deepseek-v4.1-flash
                  thresholdRatio: 0.4     # 出事的就是这条路由，压得更早
                - provider: dsh-opencode-go
                  model: deepseek-v4.1-flash
                  thresholdRatio: 0.45
                - provider: workbuddy
                  model: deepseek-v4.1-flash
                  thresholdRatio: 0.45
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
```

最终触发点（实测算式，`dsh-compaction-basic\lib\index.js:124-131`）：

| 路由 | ratio | threshold | retain | 合法 |
|---|---|---|---|---|
| opendesign/deepseek-v4.1-flash | 0.4 | **419,200** | 110,400 | ✓ |
| workbuddy/deepseek-v4.1-flash | 0.45 | 471,600 | 110,400 | ✓ |
| dsh-opencode-go/deepseek-v4.1-flash | 0.45 | 471,600 | 117,895 | ✓ |

要点：

1. **`thresholdRatio` 调低是核心** —— 从 838k 提前到 419k，让压缩在输入还小的时候就发生，摘要请求本身不容易被上游掐断。
2. **`maxTokens` 显式给值** —— 默认 65,536 对摘要没有意义（它实际只用几千 token），显式声明避免歧义。
3. **不要带 `inject`** —— billion-context 的 patch 层给 `preset-standard` 注了 `inject: [biliBasicCompactionPolicy]`，那是 Loader 字段不是 Config 字段；抄进 `config` 会破坏 schema。
4. **`retainRatio` 必须 < `thresholdRatio`** —— 校验在 `:155-157`；用 `retainTokens` 形式反而不会被静态校验拦住，只会在 runtime 抛 `TargetPressureConfigError`，所以别用。
5. **`summarizationProvider`/`summarizationModel` 可选** —— 想把摘要单独指到别的路由就填这两项。注意摘要请求仍会带上整段待压缩对话，provider 的上下文窗口要够。

### 三重校验已过

- `js-yaml` + `entryListSchema`（`JSON_SCHEMA.extend(JsExpr)`）解析：1 个 entry、22 个 plugin、3 处 `!!js` 仍是表达式（`process.platform === 'win32'` / `!== 'win32'` / `!ctx.get('profileContext')`）。
- 真实 `BasicCompactionEngine` 构造：`ACCEPTED`，解析出 `{thresholdRatio:0.45, headroomTokens:65536, retainRatio:0.12, maxTokens:32768, compactionRetries:2, modelPolicies:[...], auto:true}`。
- 离线复现 `composeEntries`（14 个 patch 层）：`preset-standard > compaction > compaction-basic` 的 config 就是上面那套，`inject` 仍为 `["biliBasicCompactionPolicy"]`，`command-compact` 与 `tool-result-pruner` 都在，顶层那行仍是 `disabled:true / config {"auto":false}`（本来就不该动它）。

**注意**：改完需要重启客户端，宿主半才会重载。

**回滚**：改之前的原文件在 `C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml.bak-20261111`（24,384 B）。直接覆盖回去再重启即可。

### 与 billion-context 共存时的行为

billion-context 装着的时候，上面这份配置是**休眠**的 —— 不是配置错了，是它的 gate 会主动把引擎关掉。
`C:\Users\admin\.dsh\profiles\desktop\node_modules\billion-context\dist\agent\dsh-compaction-gate.js` 里：

```js
var BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";
function disableBasicCompaction(rows) {
  return rows.map((row) => {
    if (row.name === DSH_COMPACTION_BASIC_PACKAGE || row.name === DSH_COMMAND_COMPACT_PACKAGE) return { ...row, disabled: true };
    if (row.group && Array.isArray(row.config)) return { ...row, config: disableBasicCompaction(row.config) };
    return row;
  });
}
```

挂在 `internal/config` 上（`{global:true}`），递归整棵插件树 —— 包括 preset 内部。而 `declareDshCompactionActive()` 在 `dsh-native.js` 的 `apply()` 里执行（只要 `planNativeDsh(env).mode !== "off"`）。

所以两种状态是互斥且自洽的：

| billion-context | compaction-basic | 结果 |
|---|---|---|
| 装着（当前） | 被 gate 置 `disabled:true`，我的 config 不跑 | 走 `<bili-snapshot>` 快照，0.2s，不调 LLM，**不会撞 MAX_TOKENS** |
| 卸掉 | 正常启动，读我这份 config | 419k 就压缩，摘要预算 32,768，**比默认 838k 安全得多** |

也就是说：**这份配置是给"不装 billion-context"那条路兜底的**。两条路都不会再出现 11-10 那两次的 16-token 截断。
`/compact`（`@deepseek-ai/dsh-command-compact`）同样被 gate 关掉，装了 bili 时它走 bili 的压缩，不装时走原生摘要 —— 两种情况下都别再指望它当紧急手段。

### 另一个选择：把 billion-context 装回去

它对原生压缩是无条件 422 拒绝，然后用 `<bili-snapshot v1>` 快照代替 —— **0.2 秒、不调 LLM、不占输出预算**，永远不会触发 `MAX_TOKENS`。
代价是压缩质量取决于它的快照策略，而不是 LLM 摘要。

### 临时手段

横幅弹出后：发「压缩会话，然后继续」。`/compact` 命令（`@deepseek-ai/dsh-command-compact`）也是同一个引擎，但**它同样会走 LLM 摘要，同样会撞这个问题** —— 别指望它。

---

## 八、顺带：11-10 当天其他失败

`turn/end` 当日分布：completed 24、error 22、aborted 11、interrupted 3、max-tokens 2。

error 的来源（和截断无关，但都在浪费时间）：

- `agent/request proposed reasoning effort "high" after step preparation fixed "max"; use agent.model.select() before step preparation` —— 6 次，设计问题
- `Tool call "read": Unexpected non-whitespace character after JSON at position 127` —— 参数 JSON 拼接错，4 次
- `pi-ai provider "design2" has no configured model "deepseek-v4.1-flash"` —— 2 次，路由配错
- `Connection error.` (TRANSPORT) —— 2 次
- `Provider finish_reason: content_filter` —— 1 次
- `422 bili_gate_oversize_refusal` —— 1 次
- `404 model_not_found` / `401 Qoder PAT` —— 各 1 次

---

## 附：复现脚本

均在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`：

| 脚本 | 作用 |
|---|---|
| `compact.mjs` | compaction/end 全量成败 + 失败原因聚类 + 按月分桶 |
| `compact-ok.mjs` | 4 次成功压缩的身份（原生 vs bili 快照） |
| `overflow.mjs` | 按输入规模分桶的 stopReason 分布 |
| `fresh.mjs` | 按「未缓存新增 token」分桶的截断率（本段最关键的口径修正） |
| `od-big.mjs` | opendesign 输入 ≥600k 按 effort 分组 + 新增 ≥400k 全历史 |
| `effort.mjs` | 按 reasoningEffort 的 length 率 |
| `bydate.mjs` | opendesign ≥400k 输入按日期聚合 |
| `zone.mjs` | 单会话指定时间窗全事件时间线（本地时区修正版） |
| `locate-length.mjs` | 全库 9 条 length 的本地时间 + token 明细 |
| `window.mjs` | Pixel4Root 18:59–19:09 全事件时间线 |
| `detail.mjs` | 指定 seq 的 request/header + usage + stream 尾部原文 |
| `turnend.mjs` | 当日 turn/end 分布与错误样本 |
| `cacheprobe.mjs` | 大输入的未缓存 token 对比 |
| `turnsteps.mjs` | 每个 max-tokens 轮内部的 step 序列分解（看是谁把轮顶成 max-tokens） |
| `trunccost.mjs` | 量化「被作废但已跑完」的步数 / 产出 token / 轮时长 |
| `layermap.mjs` | 展开 `dsh.profile.bundles` 的全部 patch 层与 entries 数 |
| `composecheck2.mjs` | 离线复现 `composeEntries`，检查 `preset-standard` / `compaction-basic` 组合后的真实行 |
| `genpreset3.mjs` | 纯文本变换生成 `preset-standard` 覆盖（保住 3 处 `!!js`） |
| `verifyoverride.mjs` | 用 `js-yaml` + `entryListSchema` 校验覆盖文件 |
| `cfgcheck2.mjs` | 用真实 `BasicCompactionEngine` 构造校验配置 + 算各路由的 threshold/retain |

日志解析要点：

1. 会话日志是**多帧 zstd 拼接**，必须按 magic `28 B5 2F FD` 切帧逐帧解压，单次 `zstdDecompressSync` 只解第一帧（215 字节，仅 session header）。
2. 日志里的 `time` 是 **epoch 毫秒（UTC）**，而本文件所有时间都是 **Asia/Shanghai（+8）**。直接 `new Date(t).toISOString()` 会得到早 8 小时的时间，别被它带偏。
