# 会话慢：修复落地状态（2026-11-12 13:00）

## 一句话

三类慢因，两类已修完并实测生效，第三类（`job_output` 阻塞）代码已改到位、**只差重启 DSH 加载新默认值**。

---

## 修复 1：adb 挂死 → 硬看门狗 ✅ 已验证生效

**改了什么**

| 文件 | 改动 |
|---|---|
| `C:\Users\admin\Desktop\CoinsBot\server\ops\proxy\clash_ctl.py` | 新增 `AdbTimeout` + `run_guarded()`（Popen + communicate(timeout) + `taskkill /T /F` 杀整树）；`adb()` / `_sh()` / `ctl()` 全部改走它 |
| `C:\Users\admin\Desktop\CoinsBot\server\ops\proxy\region_ctl.py` | `:304` set_region push、`:329` restart_cmfa 改走 `cc.run_guarded` |
| `C:\Users\admin\Desktop\CoinsBot\_fix_dead_node.py` | `sh()` 改走 `run_guarded` |
| `C:\Users\admin\Desktop\CoinsBot\_heal_exits.py` | write_cfg push 改走 `run_guarded`；**顺带修了 `time.sleep(3)` 却没 `import time` 的真 bug**（修复路径必抛 NameError，被 except 吞掉，"修活"从未跑完） |

**为什么原来会挂死**：`subprocess.run(timeout=)` 只杀直接子进程，adb server 与远端 `su -c` shell 继续持有管道写端 → 父进程等 EOF 永远等不到。实证：PID 6980 活了 14 分钟、0 TCP、IO 增量 0。

**验证**

- 合成挂死 `ping -n 60`，timeout=3 → **3.2s** 抛异常
- 孙进程 `start /b` + 200 次 ping，timeout=4 → **4.2s** 强杀，无残留
- 真实 adb `sleep 300`，timeout=8 → **8.19s** 返回（修复前 14 分钟不返回）
- 真实 adb 正常路径 → 0.64s
- 原挂死写法（管道尾 `| Select-Object -Last 3`）→ **8.3s 到 EOF**（修复前永不到 EOF）
- 活体反证：12:30 观察到 `pwsh → python _heal_exits.py → adb → su -c` 三 PID 在超时后**全部消失**，无永久悬挂

---

## 修复 2：上下文压不住 → bili nudge 参数 ✅ 已验证生效

**改了什么**：`C:\Users\admin\.config\billion-context\billion-context.json`

```json
{"providers":{},"compress":{"maxContextLimit":"15%","emergencyThresholdPercent":"90%","nudgeGrowthTokens":30000,"minPressureBenefitTokens":6000}}
```

**验证（日志前后对比，同会话）**

| | 改前 | 改后 |
|---|---|---|
| 增长单元 | `growth=x/22500 (interval=50000)` | `growth=2572/20000 (ref=53367, interval=30000)` |
| T1 阈值 | `pendingT1=x/50000` | `pendingT1=2648/30000` |

⇒ `nudgeGrowthTokens=30000` 确实进了内核（floor = max(20000, 0.45×30000) = 20000，与日志吻合）。**热加载，无需重启**。

**注意**：小会话仍不会被压 —— 有意设计的两道门：`max compressible < min tier threshold(30000)` 与 `pending < minPressureBenefit(7500)`（日志里 `min benefit 7500` 说明 `minPressureBenefitTokens:6000` 未进内核，走的是 `max(5000, limit×1%)` 默认）。

---

## 修复 3：`job_output` 一次吃掉 10 分钟 → 120s 硬上限 ⏳ 已改代码，待重启加载

**问题实况**（speed-audit 实测，12:57）

| 会话 | job_output 调用 | 累计 | 单次最长 |
|---|---|---|---|
| 8bc5b06d | 63 次 | 4598s（**1.28 小时**） | **448s** |
| dac2264b | 9 次 | 415s | 221s |
| dd0c5c46 | 7 次 | 473s | 180s |

8bc5b06d 的 `verdict=hung-in-tool` 就是它写 `job_output(timeout_ms: 900000, wait: true)` 等一个跑十几分钟的设备体检脚本。

**根因链**

- `@deepseek-ai/dsh-tool-jobs/lib/index.js:437`：`await jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), ...)`
- `waitCap` 默认 `6e5` = **600000ms = 10 分钟**
- `@deepseek-ai/dsh-tool-call-timeout-policy` 对这层**完全无效**：它只看工具自己声明的 `timeoutMs`，而 `job_output` 没声明

**改了什么**：`...\dsh\node_modules\@deepseek-ai\dsh-tool-jobs\lib\index.js`（备份 `index.js.pre-waitcap-bak`）

- `:97` `maxWaitTimeoutMs: ... .default(12e4)`（原 `6e5`）
- `:259` `const waitCap = config.maxWaitTimeoutMs ?? 12e4;`（原 `?? 6e5`）

**验证到哪一步**

- `node --check` 语法通过
- schemastery 实跑 `Config({})` → `{"waitTimeoutMs":30000,"maxWaitTimeoutMs":120000,...}` ✅ 默认值确实生效
- 但**运行中的进程没加载**：两个探针（400s / 201s）都等满，子代理独立复测 **206.6s** 也没在 120s 处截断
- 结论：模块已被 PID 4992（11/11 16:40:49 启动）载入内存，改文件不影响运行实例 → **必须重启 DSH**

**为什么改 profile patch 没用**：`cordis.patch.yml:834` 的 `tool-jobs` 写在 `preset-standard.config.plugins[7]` 里，而 preset 子插件走独立的 `PresetTree`（`agent-preset-registry/lib/index.js:219 mountPreset → :222 new PresetTree → :226 tree.root.update`），profile 顶层 reconcile 命中不到；`plugin_manager` 也显示 `include:tool-jobs` 是 `enabled:false, fiberPhase:null`（顶层那行没跑）。patch 里的 config 保留作声明文档，实际生效靠模块默认值。

---

## 还剩一件事（需要你决定）

重启 DSH 让修复 3 生效。代价：正在跑的 4 个会话（8bc5b06d、dac2264b、14204334、dd0c5c46）当前 turn 会被打断，会话历史不丢、重启后可续。

另外顺带：**dd0c5c46 的 provider 还是 `opendesign`/`max`**（idle t22/s182，`ms.model=19886s`）。按 12:47 的分桶统计，它在 140–220k 上下文区间用 opendesign 的 TTFT 中位是 6.9s，换 design2 是 4.2s —— 单这一项能省约 1.86 小时。这个要在会话里手动切。

---

## 备份文件（要回滚时用）

- `clash_ctl.py.pre-adbguard-bak`
- `index.js.pre-waitcap-bak`
- `cordis.patch.yml.bak-slowsess-20261112`
- `billion-context.json.bak-slowsess-20261112`
