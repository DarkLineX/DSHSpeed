# 两个慢会话：逐段归因与提速改法

采样时间 2026-11-12 10:20–10:35 ｜ 数据源 `session.v4.jsonl.zstd` 全量回放（探针在 `.probe/`，口径见文末）

---

## 一句话结论

| 会话 | 你感觉到的 | 实际卡在哪 | 占墙钟 |
|---|---|---|---|
| **8bc5b06d** CoinsBot | 工具超久、整段不动 | **不是我方代码慢，是 agent 自己在空等**：`Start-Sleep` 轮询 + `job_output(wait:true)` 阻塞，两个动作吃掉 73.9% 的工具时间 | **38.2%** |
| **dd0c5c46** SrcAntiDex | 慢但在动 | **每步都在等首 token**（TTFT 5.38h），因为①模型挂在 opendesign（同上下文桶比 design2 慢 64%）②上下文长期 175k 以上 | **46.3%** |

两个会话的病完全不同，别用同一副药。

---

## 一、8bc5b06d（CoinsBot）— 工具超久

活跃 2.16h / 457 步 / 步均 17.0s。**没有任何一步是机器睡眠**，全是真耗。

```
工具执行  1.13h  52.1%   ← 问题在这里
模型往返  1.04h  47.9%
  ├ TTFT      0.42h 19.4%（步均 3.31s，正常）
  ├ reasoning 0.42h 19.3%
  ├ toolArgs  0.12h  5.4%
  └ 正文      0.00h  0.2%   ← 457 步里几乎全无可见输出
```

工具 552 次里，**前两名全是等待**：

| 动作 | 次数 | 合计 | 占工具 | 均值 |
|---|---|---|---|---|
| `pwsh: Start-Sleep ...; 查一次` | 39 | **25.2min** | 37.4% | 38.8s |
| `job_output {wait:true, timeout 180–240s}` | 15 | **24.6min** | 36.5% | 98.6s |
| `pwsh: python 脚本` | 93 | 12.8min | 19.0% | 8.3s |
| 其余（文件检索/adb/http/write/read） | 共 324 | <7min | <6% | — |

### 真凶：`| Select-Object -Last 30` 放在后台命令的管道尾部

```
10:12:20  pwsh(run_in_background:true) → "started background job pwsh-479cda030caf4fea"
         命令: python _fix_dead_node.py 2>&1 | Select-Object -Last 30
```

- `Select-Object -Last 30` 必须等上游 **stdout 关闭**才能吐结果 → 父 pwsh 永不到 EOF → job 永不结束。
- 而里面那个 python 子进程（PID 6980）实测 **14 分钟 0 TCP、读写字节增量为 0、单线程 `Wait(UserRequest)`**，卡在 adb 上；`_fix_dead_node.py:12` 的 `sh()` 只给了 `timeout=60`，`clash_ctl.py:36` 的 `adb()` 给 40s——**都没生效**。
- 于是 agent 只能一遍遍 `job_output(wait:true)`：240s → 180s → 202.9s（你手动 abort）→ 180s，**623 秒纯白等 + 5 次模型往返**。

同类轮询链还有两条：`pwsh-c3798b3a85674acf` 等 3 次 360s、`pwsh-26e214d04c73458b` 等 2 次 180s。三条合计 **1163s**。

> 历史同款：`hangs.md:60` 记的 whatsapp-android turn11 拖 14h56m，就是同一根因。

### 改法（按收益排序）

1. **后台任务输出写文件，不要塞管道尾巴。**
   ```powershell
   # ✗ 永不到 EOF
   python x.py 2>&1 | Select-Object -Last 30
   # ✓ 先落盘，再单独读
   python x.py *> _x.log 2>&1
   # 读的时候：Get-Content _x.log -Tail 30
   ```
2. **别再 `Start-Sleep N` 之后查一次**。39 次轮询 25.2min，等于 39 次「睡醒才发现没变化」。
   - 服务已在跑就直接 `Invoke-RestMethod` 查（单次 1.6s，已实测）；
   - 必须等状态变化就用 `job_output(timeout_ms: 10000~15000)` 短轮询，或写一个 `while` + 条件退出的一次性脚本**在后台自己轮**，只把最终结果读回来。
3. **`job_output` 的 `timeout_ms` 一律给 15–30s**。180/240s 只会在卡死时放大损失；短超时能立刻发现「没在动」。
4. **给 adb 加硬看门狗**（本次卡死的直接原因）。`subprocess.run(timeout=)` 在这条链上没兜住，改 `Popen` + 到点 `taskkill /T /F` 才会真的死。补丁见 `patches/adb_guard.md`。

> 只做 1+2+3，这两项就能从 2.16h 里拿回 **~0.83h（38%）**，而且完全不损失信息量。

---

## 二、dd0c5c46（SrcAntiDex）— 慢但在动

### 先把假象剔掉

面板上 25.97h 不是真跑了 26 小时：

| 空档 | 时长 | 性质 |
|---|---|---|
| step 2/183 | **14.18h** | 机器睡眠（19:44:20 step/start → 次日 09:55:18，`llm/retry` 落 `pi-ai stream idle timeout after 300000ms`） |
| turn/end → inbox/spliced | 9.12h | 跨夜你没续 |
| 其余 turn 间 | 2.48h + 0.46h + 0.32h + 0.28h | 等你输入 |

**真实活跃 11.61h / 2516 步 / 步均 16.6s。**

```
模型往返  9.09h  78.3%   ← 问题在这里
  ├ TTFT        5.38h  46.3%   步均 7.70s   (p50 6.4s / p90 12.8s / p99 34.0s)
  ├ reasoning   2.07h  17.8%   步均 2.96s
  ├ toolArgs    1.37h  11.8%
  └ 正文        0.04h   0.3%
工具执行  2.52h  21.7%
```

工具那 21.7% 里：`python 脚本` 83.7min（55.4%）、`Start-Sleep` 20.9min、`job_output` 18.1min、`adb` 15.5min。**跟 CoinsBot 是同一套 adb/轮询习惯**，只是这个会话工具本身不是瓶颈。

### 两个真正放大器

**① 模型路由选错了（最大单点）**

同一上下文桶、同样 effort，两个 provider 的 TTFT 中位：

| 上下文 | design2 | opendesign |
|---|---|---|
| 80–140k | **4.0s** (n=560) | 6.0s (n=139) |
| 140–220k | **4.2s** (n=56) | 6.9s (n=1142) |
| 220–320k | 6.5s (n=62) | 7.3s (n=362) |

这个会话在 opendesign 上跑了 **1644 步 / TTFT 3.96h**。换回 design2 同桶水平 → **省 1.86h**。

**② 上下文长期压在高位**

p50 **175k** / p90 238k / p99 325k / max 352k，**78.8% 的步 ≥120k**。而 `cordis.patch.yml:885` 给 opendesign 的 `thresholdRatio: 0.4` × 1048000 = **419k 才触发压缩**——实际峰值 352k，一次都没压到。等于压缩机制在这个会话里全程失效。

压到 <140k → **省 2.03h**。与①叠加（provider + 上下文同时达标）→ **省 2.31h**。

**③ effort `max` 白烧**

reasoning 2.07h，步均 2.96s。这个会话有 2516 步、95% 是「读一下 → 跑个 pwsh」，`max` 的边际收益很低。降到 `high` 按 -30% 估 → **省 0.62h**。

### 改法

1. **会话里把 provider 切回 design2**（GUI 选择器即可，新步立刻生效）。这一条抵其它所有。
2. `cordis.patch.yml:885` 的 `thresholdRatio: 0.4` 改成 **0.12**（≈126k 触发），让压缩真的在 140k 前动手；`retainRatio` 0.12 保持不变。
3. effort `max` → `high`。
4. **每步只发 1 个工具（均值 1.01：单工具 2468 步 / 双工具 35 步）**。这是 2516 步 × 16.6s 的结构性来源——每个「读一下」都要付一次完整往返（TTFT + 思考 + 参数流）。把 `read`/`grep`/`read_image` 攒进同一批发（`pwsh` 里一次跑完，或连续多个 tool call 同 turn 发出），步数直接砍掉一两成。
5. `compress` 45 步 = **29.5min（4.2% 墙钟）**，且这 45 步的 TTFT 均 13.0s（比平均高一倍）。压缩本身很贵，别让它频繁触发——用②把水位压住，比压缩更划算。
6. `write` 133 步 toolArgs 均 9.4s（合计 20.8min）：大文件一次 `write` 写全，别拆成多次 `edit`。

---

## 三、两个会话共同的、DSH 侧的修

| 项 | 现状 | 改 |
|---|---|---|
| `job_output` 长超时 | 180/240s，卡死时白等 | 15–30s 短轮询（已在上面第 3 条） |
| `streamIdleTimeoutMs` | 300000（`cordis.patch.yml:192`），跨夜 sleep 时误判超时并留 14h 空洞 | 不必改数值，但睡眠前后别跑长轮询链 |
| 陈旧 pws PTY | 7 个（PID 24200/19964/20164/30996/33328/32656/13524，父 4992，起于 11-11 16:42~19:27，各 92–170MB） | 可清理，不占墙钟但吃内存 |

---

## 四、复现命令

```powershell
cd C:\Users\admin\Desktop\DSHSpeed
node .probe\awake.cjs 8bc5b06d      # 剔除睡眠后的真实归因 ← 最权威
node .probe\awake.cjs dd0c5c46
node .probe\bytool.cjs              # 按工具拆 toolArgs / reasoning / 输出 token
node .probe\provbucket.cjs          # provider × 上下文 的 TTFT 对照
node .probe\levers.cjs              # 各杠杆的量化收益
node .probe\ttft-tail.cjs dd0c5c46  # TTFT 长尾与重试影响
```

口径要点（踩过的坑）：
- `stream` 是**扁平 chunk 数组**，`{type:'chunk', chunk:{type:'block-start'}}` + `{type:'reasoning-chunks'|'tool-call-chunks'|'text-chunks', time0, dt[], texts[]}`。
- `tool/result` 的 id 在 `e.data.message.toolCallId`。
- 步时长必须 `step/start` → `step/end`，不能用 `assistant/message` 时间（会算出负的工具耗时）。
- `awake.cjs` 用「单步跨度 >10min 判为睡眠」剔除空档，这是唯一不把 14h 睡眠算进活跃时间的口径。
