# 工具调用为什么慢：是电脑性能还是环境问题

结论先说：**电脑性能完全不是瓶颈，是 DSH 的 `pwsh` 工具每调用一次就冷启动一个 powershell.exe 进程，加上命令本身确实在跑长活。**

数据来源：全库 284 个会话、87,762 次工具调用（已剔除跨 turn / 跨睡眠的伪配对，剩 86,945 次干净配对）。

---

## 一、硬件：没有一项是瓶颈

| 项目 | 实测 | 判断 |
|---|---|---|
| CPU | i7-14700KF，20 核 28 线程，3400 MHz | 够快 |
| 当前负载 | **8%** | 几乎空转 |
| 内存 | 47.8 GB，空闲 **34.5 GB** | 充裕 |
| 磁盘 | Predator SSD GM7 2TB，NVMe | 快盘 |
| 全机进程内存合计 | 8.0 GB | 轻 |
| Windows Defender 实时保护 | **已关闭**（`RealTimeProtectionEnabled: False`） | 不在拖慢文件 IO |

**决定性证据：纯本地 IO 类工具的耗时**

这些工具不启动任何外部进程，纯粹是磁盘 + CPU：

| 工具 | 次数 | 合计 | 中位 | p90 | p99 |
|---|---|---|---|---|---|
| `read` | 11,952 | **0.05 h** | **8 ms** | 13 ms | 36 ms |
| `edit` | 9,428 | 0.42 h | 13 ms | 20 ms | 67 ms |
| `write` | 6,365 | 0.02 h | 11 ms | 17 ms | 67 ms |
| `grep` | 3,667 | 0.17 h | 145 ms | 178 ms | 1035 ms |
| `glob` | 304 | 0.01 h | 270 ms | 467 ms | 12.2 s |
| `read_image` | 836 | 0.008 h | 104 ms | 270 ms | 401 ms |

**合计 33,213 次 / 1.55 小时 / 平均每次 168 ms。**

如果电脑性能不够，`read` 不可能 8 ms 一次。本地 IO 这条链是健康的。

---

## 二、慢在哪：`pwsh` 每次都是全新进程

`pwsh` 工具的实现是 `...\@deepseek-ai\dsh-pwsh-local\lib\index.js:199-214`：

```js
argv(spec) {
  return [
    this.pwshPath,        // ← 没有 PS7 时 fallback 到 powershell.exe 5.1
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `${ENCODING_PREAMBLE}${spec.command}`
  ];
}
```

每次调用 = fork 一个 windowshell.exe、加载 .NET 运行时、跑一条命令、退出。**没有常驻 shell。**

**实测启动成本（node 直接 spawn 同一份 argv，各 15–20 次取中位）**

| 场景 | 中位耗时 |
|---|---|
| `cmd.exe /c exit` | **6 ms** |
| bundled `node -e 0` | **51 ms** |
| PowerShell 5.1，只执行 `$null` | **464 ms** |
| 加上 DSH 的 UTF-8 preamble | **488 ms** |
| 再加 DSH 的 env 注入 | **492 ms** |
| 加一条真实命令（`Get-ChildItem \| Measure-Object`） | **707 ms** |
| node spawn → 进程退出（完整往返） | **666 ms**，其中 480 ms 花在 PowerShell 内部 |
| 查询 .NET 已加载程序集数 | 613 ms |

机器上**没有装 PowerShell 7**（`C:\Program Files\PowerShell\7\pwsh.exe` 不存在，PATH 里也没有），所以 `resolvePwshPath` 一路 fallback 到 `System32\WindowsPowerShell\v1.0\powershell.exe` —— 就是 5.1。

**日志侧实测（全库 48,731 次 pwsh）**

- 极短命令（<120 字符、无 sleep、<10 s）**n=2,696，中位 933 ms** —— 这就是空转一次的价
- 全量 p50 = 1.094 s、p25 = 0.903 s、p10 = 0.815 s
- **0.7–1.3 s 这个窄带里塞了 27,351 次调用（56.1%）** —— 高度集中在启动税
- `<1 s` 的 pwsh 调用 19,850 次，合计 4.46 h，中位 0.879 s；它们几乎不干活

**启动税总额：48,731 次 × 933 ms = 12.64 小时**（占 pwsh 总耗时 163.14 h 的 7.7%，占全部工具时间 215.8 h 的 5.9%）。

### 有现成的解法，但没启用

DSH 自带 `@deepseek-ai/dsh-tool-pwsh-persistent`（`...\dsh-tool-pwsh-persistent\lib\index.js`），它是 PTY 常驻 shell，走 `ctx.terminals`（`dsh-terminal` + `node-pty`），命令之间保留 cwd 和 `$env:` 状态。它注册的工具名同样叫 `pwsh`，能力完全对等。

当前 profile 用的是**非持久版**：`...\dsh-base\cordis.patch.yml:285-287`

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

`dsh-sdk-minimal` 里则用的是持久版（`...\dsh-sdk-minimal\cordis.patch.yml:158-160`）。也就是说这是**配置选择**，不是能力缺失。`dsh-terminal`、`dsh-terminal-bash`、`node-pty` 三个依赖在本机都已存在。

---

## 三、但启动税只是小头，大头是命令真的在跑

pwsh 总耗时 163.14 h，按命令性质拆开（`.probe\pwshcat.mjs`）：

| 类别 | 次数 | 合计 | 占比 | 平均 |
|---|---|---|---|---|
| **python / 外部脚本** | 24,639 | **67.60 h** | 41.4% | 9.9 s |
| **含 Start-Sleep 的命令** | 4,742 | **59.33 h** | 36.4% | 45.0 s |
| 纯 `Start-Sleep`（只睡不干活） | 34 | 0.73 h | 0.4% | 76.9 s |
| inspect（Get-Process / Get-Content / Select-String 等） | 9,983 | 18.88 h | 11.6% | 6.8 s |
| adb | 5,006 | 6.68 h | 4.1% | 4.8 s |
| gradle | 601 | 4.32 h | 2.6% | 25.9 s |
| 其他 | 2,299 | 3.33 h | 2.0% | 5.2 s |
| node / npm / pnpm | 590 | 1.74 h | 1.1% | 10.6 s |
| git | 843 | 0.56 h | 0.3% | 2.4 s |

**`Start-Sleep` 这一类 59.33 h + 纯 sleep 0.73 h ≈ 60 小时是"主动等着"**，不是电脑慢 —— 是模型选了轮询而不是事件驱动。

**inspect 类的长尾**里，9,983 次中有 **160 次 ≥20 s，吃掉了 17.39 h**，全是重查询：

- 813.7 min（13.6 h）`Get-CimInstance Win32_Process` 全量枚举
- 56.1 min gradle `testDebugUnitTest`
- 12.6 min gradle `:app:test...`
- 7.8 min `New-Item` + npm install
- 7.0 min `java -Xmx3g -jar jadx-1.5.6-all.jar`（反编译）
- 6.9 min `npm install`
- 5.0 min NDK toolchain

这些是 WMI / 事件日志 / 编译器真在跑，跟硬件关系不大，跟"这条命令本身重"关系很大。

---

## 四、把 215.8 h 工具时间摊开看

| 项 | 时长 | 占工具时间 | 是不是性能问题 |
|---|---|---|---|
| python / gradle / adb 等外部进程真执行 | ≈ 80 h | 37% | 否，活本身重 |
| `Start-Sleep` 轮询等待 | ≈ 60 h | 28% | **否，策略问题** |
| 重 WMI / EventLog / 编译查询（160 次） | 17.4 h | 8% | 部分，单条命令太重 |
| **pwsh 冷启动税（48,731 次 × 933 ms）** | **12.6 h** | **6%** | **是，环境/配置问题** |
| `job_output` 等后台作业等待 | 31.3 h | 15% | 否 |
| 本地文件 IO（read/write/edit/grep） | 1.55 h | 0.7% | 否，很快 |
| `ask_user_question` 等人回答 | 18.7 h | 8.7% | 否，设计行为 |

（各行有交叉，量级用）

**参照系**：全部会话 turn 墙钟 557 h，其中工具 215.8 h = 38.7%，模型往返 341 h = 61.3%。所以"工具慢"确实是第二大项，但它内部**六成以上是命令自己该跑的活**，真正属于"环境/配置"的只有 12.6 h 的启动税。

---

## 五、所以答案

**不是电脑性能不够。** CPU 8% 负载、48 GB 内存闲 34 GB、NVMe 盘、Defender 已关；`read` 中位 8 ms、33,213 次本地 IO 合计 1.55 h，硬件这条链毫无问题。

**是这三件事叠起来的"环境问题"：**

1. **DSH 每次 `pwsh` 起一个全新的 PowerShell 5.1 进程**（`dsh-pwsh-local` 的 argv 设计），实测 464–666 ms 的固定底噪，日志里极短命令中位 933 ms；48,731 次调用累计 **12.6 h**。机器上没有 PowerShell 7（PS7 冷启动显著快于 5.1）。
2. **模型习惯用 `Start-Sleep` 轮询等结果**，4,776 次共 ~60 h —— 这是最大的一块"看起来在等"，跟硬件无关。
3. **少数写法极重的查询**（全量 WMI 枚举 13.6 h、jadx 反编译、gradle）单条就吃掉小时级时间。

**可动的三处（按收益排序）：**

- 把 `tool-pwsh` 换成 DSH 自带的 `dsh-tool-pwsh-persistent`（PTY 常驻，命令间保留状态），启动税从 ~933 ms/次趋于 ~0，理论省下 12 h 量级；依赖在本机已齐（`dsh-terminal`、`dsh-terminal-bash`、`node-pty`）
- 装 PowerShell 7 并让 `resolvePwshPath` 命中它，即使不改工具实现，冷启动也能明显下降
- 把 `Start-Sleep` 轮询换成 `Start-Job` + `job_output`（DSH 有原生作业机制），这块空间是 60 h 级

---

## 复现脚本

均在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`，用 bundled node 跑：

```
C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --max-old-space-size=12288 <脚本>
```

| 脚本 | 作用 |
|---|---|
| `toolspeed3.mjs` | 按工具统计真实耗时（剔除跨 turn 伪配对）+ pwsh 分桶 + 本地 IO 汇总 |
| `pwshcat.mjs` | pwsh 按命令性质分类（python / sleep / inspect / adb / gradle …） |
| `startuxtax2.mjs` | 极短命令中位 → 启动税总额估算 |
| `spawnmeasure.mjs` | 直接 spawn 测 PowerShell 启动 + preamble + env 的开销 |
| `winband.mjs` | 0.7–1.3 s 窄带里塞了多少调用、命令长什么样 |
| `outliers.mjs` | ≥300 s 伪配对的成因（跨 turn / 跨重启） |
| `detached.mjs` | detached / env 对 spawn 耗时的影响（说明 detached 测量不可信） |

---

## 两个统计陷阱（之前算错过，记下来）

1. **`tool/call` 与 `tool/result` 的配对会被 turn 边界冲断**。若两次之间夹了 `turn/end` / `user/message` / `session/end-seed`，那个"耗时"是假的（最夸张 21 h，实际是跨了一次宿主重启）。必须先剔除再统计，否则 `read` 会被算成 p99 = 5,631 s、合计 975 h。
2. **睡眠窗口要扣掉**。不扣的话 pwsh 最大单次是 77,556 s（21.5 h），全是 2026-11-10 19:44 → 11-11 09:55 那次机器睡眠。
