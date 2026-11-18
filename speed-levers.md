# DSH 执行时间：优化点分析

数据口径：284 个会话、83,648 个 LLM 窗口、86,622 次工具调用、2,883 个 turn。
总 turn 墙钟 **557.35h**（含跨夜睡眠的那几觉，已在相关章节单独标注）。

---

## 0. 先把 557 小时切成五块

| 分区 | 时长 | 占比 |
|---|---:|---:|
| 工具执行 | **215.21h** | **38.6%** |
| TTFT（等第一个 token） | **186.94h** | **33.5%** |
| 生成（流剩余部分） | 137.94h | 24.7% |
| 宿主 / 未归属 | 17.25h | 3.1% |
| compaction | 0.01h | 0.0% |

两条大柱子：**工具 38.6%**、**等首 token 33.5%**。生成只占 1/4。

再往下拆生成那 137.9h：

| 子项 | 时长 | 占生成 |
|---|---:|---:|
| reasoning 解码 | **83.6h** | 61% |
| tool-args JSON 解码 | **26.5h** | 19% |
| 正文解码 | 4.7h | 3% |

输出 token 里 reasoning 占 **82.4%**（61.8M / 75.1M）。思考是正文的 24.5 倍。

---

## 1. 最大单项：Start-Sleep 轮询 —— 59.9h

**4,770 次 `pwsh` 里带 `Start-Sleep`，实测墙钟 59.9h。占全部工具时间的 27.8%，占全部 turn 墙钟的 10.7%。**

换句话说：pwsh 跑的 162.7h 里，**有 59.9h（37%）什么都没干，就在 sleep**。

分布：

| 单次时长 | 次数 | 合计 |
|---|---:|---:|
| 0–10s | 1,663 | 2.45h |
| 10–30s | 1,383 | 6.86h |
| 30–60s | 702 | 8.30h |
| **60–180s** | 769 | **21.14h** |
| **180–600s** | 232 | **17.30h** |
| 600–1200s | 17 | 2.83h |
| >1200s | 1 | 0.94h |

**≥120s 的 475 次独占 29.6h。** 这些几乎必然是超调——固定睡 600 秒，而活儿 90 秒就干完了。

最长单次：
- `3388s` Start registration keepalive watchdog
- 大量 `600s`：Wait 10 min then full window stats / Wait for smoke3 to finish / Ten-minute monitor round / Monitor production batch progress / 等待批次完成 …

叠加 `job_output wait:true`：952 次、31.3h。**两者合计 91.2h = 全部 turn 墙钟的 16.4%。**

**这 91.2h 里真正该省的是"超调部分"和"多次轮询的模型往返"**：
- 轮询链共 4,050 条、5,735 步，链内模型往返 18.97h。若每条链只留 1 次轮询 → **省 5.61h**
- 30 次同样的 `adb ... Start-Sleep` 循环（CoinsBot `_keybox`）→ 规律性固定等待，可换成单次长 `job_output wait:true`

**改法**：等外部进程结束一律用 `job_output(wait:true, timeout_ms)`；真要定时采样，让后台作业自己在完成时写标记文件，主流程用一次阻塞等待取代 N 次 sleep。

---

## 2. 第二大：TTFT 随上下文规模线性增长

TTFT 中位数按总上下文分桶（同一 provider 内部，排除 provider 差异）：

| provider | <60k | 60–120k | 120–250k | 250–500k | >500k |
|---|---:|---:|---:|---:|---:|
| opendesign | 2.2s | 3.1s | 4.0s | 4.1s | 3.4s |
| dsh-opencode-go | 2.8s | 4.0s | 5.4s | 7.7s | 8.4s |
| commandcode | 4.1s | 5.5s | 8.3s | 8.3s | 8.3s |

而**按"缓存未命中的新增 token"分桶，TTFT 完全平的**（opendesign 3.2/3.5/3.4/2.7/4.1s）。→ 贵的不是新内容，是**已缓存前缀的绝对长度**。

上下文规模：p50 **117,925** tok、p90 255,559、p99 689,716、max 919,932；cache 命中率 p50 99%。
最近 7 天 p50 132,170、p90 367,355，**14.4% 的步输入 >300k**。

**可省上限**：把所有 >120k 的步压到 <120k 的水平，TTFT 省 **9.77h**（40,737 步）。

已经做的：`thresholdRatio` 从 0.8 降到 0.45（opendesign 0.4），压缩触发点因此从 838,400 提前到 **419,200**。这一项已经把 9.77h 里的大头吃掉了。若想再压，把 `thresholdRatio` 再降到 0.3（触发点 314,400）。

**顺带否掉一个直觉**：并发不是瓶颈。同一时刻 1 路并发时 TTFT p50 3.3s，5–8 路并发时 2.2s——多开几个会话不会互相拖慢（这是 provider 侧排队，不是本地）。

---

## 3. reasoning effort：max 在 120–250k 区间代价极大

同样上下文、同一 provider、只差 effort：

| provider | 上下文 | high 墙钟 | max 墙钟 | 差 |
|---|---|---:|---:|---:|
| opendesign | 60–120k | 8.1s | 11.3s | +3.2s |
| **opendesign** | **120–250k** | **8.7s** | **18.8s** | **+10.0s** |
| dsh-opencode-go | 60–120k | 11.2s | 11.9s | +0.6s |
| dsh-opencode-go | 120–250k | 12.6s | 13.2s | +0.6s |

opendesign 在 120–250k 时，`max` 比 `high` **多花一倍多**（18.8s vs 8.7s），换来的输出只从 705 tok 到 875 tok（+24%）。

全量换算：`max` 的 41,898 步若全改 `high` → **省 38.8h**。

这条是否要动取决于你要不要那 +24% 的思考量。**折中做法**：只在 opendesign 上、且上下文已超 120k 时降到 `high`——这一档单独就是 29.2h。

当前 `agent-default-model.reasoningEffort: max`（`cordis.patch.yml` 第 61 行区域）。

---

## 4. 重复读同一个文件：16.6h

- 含 ≥1 次"同会话内重复 read"的步：**7,382 步 / LLM 时间 20.17h**
- 其中**整步唯一动作就是重读已读过的文件**：**6,748 步 / 16.59h**

改（edit/write）之后再 read 同一文件：3,026 次。Top：

| 次数 | 文件 |
|---:|---|
| 299 | `CoinsBot\app\src\main\java\com\extend\coinsbot\whats\register\RegisterTaskThread.kt` |
| 163 | `CoinsBot\server\dashboard.py` |
| 82+74 | `whatsapp-android\src\wa_android\concurrent_runner.py` |
| 56 | `CoinsBot\server\db_api.py` |
| 46 | `KernelForge\scripts\profile_audit.ps1` |

同一 `(name, arguments)` 完全相同的调用重复：1,365 次 / 86,622。

---

## 5. 工具返回体：4.2% 的调用喂进 38% 的文本

| 指标 | 值 |
|---|---:|
| tool/result 条数 | 88,620 |
| 返回文本总量 | **167.0M chars ≈ 52.2M tok** |
| p50 / p90 / p99 / max | 561 / 4,782 / 19,404 / **206,984** chars |
| ≥8,000 chars 的条数 | 3,683（4.2%） |
| 它们占的文本 | **63.6M chars = 38.1%** |

单条 206,984 chars 的返回直接吃掉 ~65k token。这类返回是上下文膨胀的主要来源，也是 TTFT 变慢的间接原因。改法：命令里加 `| Select-Object -First N` / `--tail`，或让后台作业把完整日志写文件、只回摘要。

---

## 6. 工具 catalog：死重量 2,063 tok/请求

100 个工具定义，每次请求全发。按"实际是否被调用"加权：

| 工具 | 定义 chars | ≈tok | 出现在请求 | 调用次数 |
|---|---:|---:|---:|---:|
| `workflow` | 4,430 | 1,384 | **99%** | **0** |
| `subagent_fork` | 1,504 | 470 | **99%** | **0** |
| `purge_apply` / `purge_status` / `purge_revert` | 527 | 165 | 93% | **0** |
| `acp_read_original_image` | 733 | 229 | 21% | **0** |
| `ralph` | 826 | 258 | 1% | **0** |
| 62 个 `redteam_*` 家族 | ~31,000 | ~9,700 | 各 1 次 | **0** |

**加权死重量 6,601 chars ≈ 2,063 tok/请求 = catalog 13,516 tok 的 15.3%**，但只相当于中位 prompt 的 1.8%。

**老实说：这项对 TTFT 几乎无影响**（上面证明了 TTFT 不随新增 token 变），它省的是账单不是时间。redteam 那 35 个工具只在 1 个请求里出现过（当时装了 dsh-purge-community 的演练台），平时根本不发。

---

## 7. 重试与超时

- 带重试的步：359 个（0.43%），TTFT p50 **20.5s**（干净步 4.8s），合计 LLM 8.21h → **超额约 4.4h**
- `pi-ai stream idle timeout` 86 次：其中 4 次跨睡眠（假超时 28.4h），**82 次真卡 5.6h**
- 已把 opendesign 的 `streamIdleTimeoutMs` 从 90,000 改回默认 **300,000**（`cordis.patch.yml:192`）——原来 90 秒门槛砍掉了 66 条还在出字的流，其中 42 条 30 秒内就恢复了

---

## 8. 慢调用的真实构成（≥60s 的 2,416 个调用 = 155.4h = 工具时间的 72.1%）

| 类别 | 次数 | 合计 | 均 |
|---|---:|---:|---:|
| **sleep 轮询** | 1,019 | **42.21h** | 149s |
| python 脚本 | 611 | 38.04h | 224s |
| **job_output 等待** | 462 | **29.05h** | 226s |
| 等人工回答（`ask_user_question`） | 27 | 18.57h | 2476s |
| 其他 | 91 | 17.67h | 699s |
| 测试 | 113 | 3.90h | 124s |
| gradle 构建 | 32 | 3.12h | 351s |
| adb | 53 | 2.19h | 149s |

`ask_user_question` 的 18.57h 是设计行为（等你回话），不是缺陷。
python 脚本 38h、gradle 3.1h 是真在算。
**能动的还是 sleep 那 42.21h + job_output 那 29.05h。**

---

## 9. 按性价比排序

| # | 项目 | 可省 | 占 557h | 风险 |
|---|---|---:|---:|---|
| 1 | 消灭 Start-Sleep 轮询（改事件驱动等待） | **59.9h** | 10.7% | 低 |
| 2 | `max` → `high`（或仅 opendesign >120k 时降） | **38.8h**（或 29.2h） | 7.0% | 牺牲 +24% 思考量 |
| 3 | 上下文再压一档（thresholdRatio 0.45→0.3） | **~9.8h**（上限） | 1.8% | 压缩更频繁，摘要更短 |
| 4 | 消除重复 read（已读文件不重读） | **16.6h** | 3.0% | 低 |
| 5 | 轮询链合并（每条链 1 次等待） | 5.6h | 1.0% | 低 |
| 6 | 修重试（0.43% 的步占 8.2h） | 4.4h | 0.8% | 已改 idle timeout |
| 7 | 工具返回体截断（>8k 的那些） | 间接（降上下文） | — | 低 |
| 8 | catalog 瘦身（workflow / subagent_fork / purge_*） | 省账单，不省时间 | — | 零 |

**第 1 项和第 4 项加起来 76.5h，是全部 turn 墙钟的 13.7%，且不需要牺牲任何质量。**

---

## 附：复现脚本

全部在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`，用 bundled node 跑：

```
C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --max-old-space-size=12288 <脚本>
```

| 脚本 | 产出 |
|---|---|
| `opt16.mjs` | 557h 五分区（区间并集去重，最权威） |
| `opt18.mjs` | Start-Sleep 解剖 + 加权死 catalog |
| `opt21.mjs` | TTFT vs 缓存未命中 / vs 总上下文 / effort 匹配对比 |
| `opt19.mjs` | 并发对 TTFT 的影响（证明无关） |
| `opt9.mjs` | 重复 read、轮询步、工具窗口 |
| `opt12.mjs` | 轮询链长度与可省的模型往返 |
| `opt20.mjs` | 工具返回体尺寸分布、reasoning 语言构成 |
| `opt13.mjs` | 记账类工具开销、参数 payload、≥1h 的 turn |
| `opt10.mjs` | tool-args 解码时间按工具分（compress/write/pwsh/edit） |

解析坑（都踩过）：
1. 日志是**多帧 zstd 拼接**，按 magic `28 B5 2F FD` 切帧逐帧解
2. `time` 是 epoch ms **UTC**，+8h 才是本地
3. `usage` 在 `data.usage`，不是 `data.message.usage`
4. 块的时长只能用 `dt[]` 求和；`time0` 是请求起始时间的拷贝
5. 块类型看 `c.chunk.blockType`（只在 `blockType` 的 `block-start` 里），不能读 `c.type`
6. 时间区间必须**按并集去重**再相加，否则工具窗口和 LLM 窗口会重叠重复计
