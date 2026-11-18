# 固定问题导致的调用失败 — 耗时审计

样本：259 个可解析会话 · 81,607 步 · 266.5 小时模型时间 · 85,665 次工具调用。

结论先行：**这些失败真实存在，但累计只有 3.3 小时（占模型时间 1.2%）。它不是「墨迹」的原因，是一个独立的、可以顺手修掉的 bug。**

---

## 一、你举的那条例子，日志里确实有

```
Tool call "read": Unexpected non-whitespace character after JSON at position 128 (line 1 column 129)
Received arguments: {"file_path": "...concurrent_runner.py", "limit": 55, "offset": 1960}{"file_path": "...concurrent_runner.py", "limit": 40, "offset": 2633}
```

报错位置 128 落在 `}{` 上——**两个 JSON 对象被粘成了一个字符串**，这是流式工具参数拼接时丢了分隔，不是模型写错。

全库实测命中：

| 特征 | 事件次数 | 涉及会话 |
|---|---|---|
| `Unexpected non-whitespace character after JSON` | 52 | 10 |
| `Received arguments:` | 50 | 10 |
| `Tool call "…": …` 失败包装 | 30 | 7 |
| `本轮运行失败` | 15 | 1 |
| `invalid arguments: missing …` | 10 | 5 |

按工具：`pwsh ×7`、`read ×4`、`job_kill ×1`（能定位到具体步的 12 步，其余出现在无法归属的上下文里）。

**为什么你「感觉频繁」但占比很低**：它集中在同几个会话里（10 个会话吃掉 52 次），
某个会话里短时间内连续复现，主观感受就被放大了。

---

## 二、更值得关注的是「静默丢弃」

日志里 `tool/result` 的 `isError` **几乎永远是 false**，连
`fatal: not a git repository` 这种都标成 false（85 万级样本里只有 1.4% 标 true）。
所以失败不能靠这个字段看，只能靠「调用有没有拿到结果」。

有 **984 个 `tool/call` 从来没等到对应的 `tool/result`**（占 85,665 次的 1.15%）。
按 turn 结束原因拆开：

| 归属 | 数量 | 性质 |
|---|---|---|
| `aborted` / `interrupted` 的 turn 内 | 114 | 你主动中断，正常 |
| 未闭合的 turn（会话尾部） | 0 | 正常截断 |
| **正常完成的 turn 内** | **869** | **真异常** |

869 次真异常分工具：`pwsh ×361`、`edit ×196`、`read ×151`、`grep ×87`、`job_output ×24`、`write ×23`。

看具体样本，**参数本身完全合法**：

```json
[read]  {"file_path": "...ReceiveMessageAction.kt"}
[grep]  {"pattern": "自动回复|autoReply|auto_reply", "path": "...CoinsBot"}
[pwsh]  {"command": "git log --oneline -25", "workdir": "...CoinsBot"}
```

也就是说：**模型生成了合法的工具调用，工具也受理了，但结果没回来。** 这是执行/分发环节丢的，不是模型的问题。

---

## 三、代价换算

| 项 | 浪费 | 占比 |
|---|---|---|
| 869 次真异常丢弃 | **3.27 h** 模型时间 | 1.2% |
| 12 步解析失败（能定位的） | 0.10 h | 0.04% |
| **合计** | **≈ 3.3 h** | **1.2%** |

每次失败的代价约 **13.9 秒** —— 正好等于一次完整模型往返（TTFT 6.9s + 生成 4.9s）。
因为失败发生在工具层，模型那一轮白跑，下一步必须重来一遍。

**和真正的大头对比：**

| 项目 | 耗时 | 倍数 |
|---|---|---|
| 模型往返总计 | 266.5 h | 81× |
| 工具执行总计 | 209.8 h | 64× |
| 失败重做 | 3.3 h | 1× |

---

## 四、已排除的失败来源（避免白忙）

这些查过了，都不是问题：

- **工具级 `isError` 字段** —— 1.4%，实际不可用，要用「调用-结果配对」判失败。
- **`llm/retry` 重试** —— 全量 0.33 h，491 次，噪音级。
- **`compaction` 压缩失败** —— 8,027 次报 `dsh_compaction_refused`（billion-context 在拦），
  但累计只有 1.97 h。**次数吓人，时间不吓人。**
- **PowerShell 内联 Python 引号被吞** —— 检索 `引号会被吞` / `内联 Python`：**0 命中**。
  这条要么已经从提示词里规避掉了（改用脚本文件），要么从未落进会话日志。

---

## 五、值得修的两处

### ① 流式工具参数拼接丢分隔（真正的 bug）

同一轮里模型连续发多个工具调用时，参数 JSON 之间的边界偶尔丢失，产生 `}{` 粘连。
现状是整步作废（12 步 / 0.1 h，量不大），但**它会让一整轮推理白费**，而且报错信息对用户不友好。

修复方向：在工具参数流式累加的收尾处，按 `index` 校验每个 block 的 JSON 完整性；
若发现粘连，尝试按顶层 `}{` 边界切分后分别解析，失败再降级为单次重试，而不是直接抛给用户。

### ② 869 次结果丢失（更值得查）

`pwsh` 占 361 次、`edit` 占 196 次——都是**有副作用**的操作。
结果没回来意味着：命令可能已经执行了，但模型不知道结果，只能重做。

这比解析失败更危险：
- `edit` 重做可能产生重复编辑；
- `pwsh` 重做可能重复执行已生效的命令（数据里出现过 `adb install`、`gradlew assembleRelease`）。

**建议**：给「工具已执行但结果丢失」加一条明确的会话事件（现在完全没有痕迹，
只能靠 `callId` 没有配对结果反推），让模型知道「这个操作可能已经发生了」而不是盲目重试。

---

## 六、口径

- 失败判定不看 `isError`（不可信），用两条客观证据：
  1. `tool/call.callId` 是否出现在任何 `tool/result.message.toolCallId` 里；
  2. `assistant/attempt.stream[].chunk.reason.failure.message` 里的失败文本。
- 每次失败的代价 = 该 step 的 `assistant/message` 时间（TTFT + 各块 `dt` 之和）。
- 会话日志是**多帧 zstd 拼接**，必须按 magic `28 B5 2F FD` 切帧后逐帧解压。
- `chunk.time0` 是请求起始时间的拷贝，**不能当耗时**。

脚本：`.probe\dropped.mjs`（丢弃调用 + 特征串）·
`.probe\waste.mjs` / `waste2.mjs`（代价换算）·
`.probe\attribution.mjs`（归属拆分）·
`.probe\fail2.mjs`（早期内容启发式，已被上面替代）
