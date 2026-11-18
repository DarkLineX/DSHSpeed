# 能不能替代 pwsh —— 替代方案实测与对比

> 数据源：`C:\Users\admin\.dsh\sessions` 全部 284 个会话（多帧 zstd JSONL），
> 工具调用配对 49,301 次；DSH 源码 `...\resources\app\dsh\node_modules\@deepseek-ai\*`。
> 复现脚本见文末表格，全部在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`。

---

## 0. 一句话结论

**能替代，但"换成 bash"这条路解决不了你现在遇到的报错** —— 实测只有 12.5% 的失败命令真能迁到 bash，80% 用了 PowerShell 专有语法，而 postMessage 到 bash 后连 `cd C:\...` 都会被反斜杠吃掉。

真正该换的不是"用哪个 shell"，而是**"每次冷启动一个新进程"改成"常驻一个进程"**：

| 方案 | 冷启动 | 每命令往返 | 省多少 |
|---|---|---|---|
| 现状：PS 5.1 冷启动 | 442–666 ms | **933 ms** | 基准 |
| 换 git-bash 冷启动 | 46 ms | — | 只解决启动，语法全变 |
| **PTY 常驻 PS 5.1** | 706 ms（一次性） | **32 ms** | **~29 倍** |

---

## 1. 先看清"老是出现调用问题"到底是什么

49,301 次 pwsh 调用里，带 `[stderr]` 的 5,521 次 = 11.20%。但绝大多数是**正常噪音**：

| stderr 类型 | 次数 | 是否真失败 |
|---|---|---|
| 其他（含 `adb daemon started successfully` 这类正常提示） | 2,549 | 否 |
| NativeCommandError（git/python 命令自身返回非零） | 1,965 | 否（是子进程的错，报错内容正确） |
| **PowerShell 解析错误（ParserError）** | **436** | **是** |
| 路径不存在 | 246 | 是 |
| 命令未识别 | 236 | 是 |
| 权限拒绝 | 89 | 是 |

**明确失败 = 696 次 = 1.42%，累计耗时 0.74 小时。** 输出完全为空的只有 87 次。

也就是说：**报错看起来很频繁（11.2%），但真正让命令白跑的只有 1.42%，总共浪费 44 分钟。** 剩下 10% 的"报错"是 adb/git/python 自己打的正常日志，被你当成了故障。

---

## 2. 解析错误 436 次的真实成因（这才是"老是出问题"的主因）

| 成因 | 次数 | 占比 | 是谁的错 |
|---|---|---|---|
| 裸单引号里嵌双引号/反引号（`'... "..." ...'`） | 259 | 59.0% | **模型写法** |
| here-doc `<<EOF`（bash 写法，PS 不支持） | 127 | 28.9% | **模型写法** |
| `$()` 命令替换嵌套过深 | 68 | 15.5% | 模型写法 |
| Python 代码裸写在命令里（`import`/`def`/`cur.` 出现在顶层） | 59 | 13.4% | **模型写法** |
| 方括号下标 `['...']` 被当通配符 | 56 | 12.8% | PS 语法陷阱 |
| `\|\|` 逻辑或 | 13 | 3.0% | PS 5.1 不支持 |
| sed/awk 单行脚本 | 3 | 0.7% | 模型写法 |
| 反斜杠续行 | 1 | 0.2% | 模型写法 |
| 未归类（真的是 PS 写法错） | 73 | 16.6% | 模型写法 |

（可多重命中，故列和 >100%）

**关键：87% 的问题根源是"把 bash 语法写进 PowerShell"，不是 PowerShell 难用。**

---

## 3. 决定性实测：换成 git-bash 能救回多少？

拿 40 条**真实失败过**的 PowerShell 命令（去重后从 457 条里抽样，已导出 `.probe/parser_fail_cmds.json`），直接丢给 `C:\Program Files\Git\bin\bash.exe -n` 做语法检查：

```
bash -n 语法通过:        9 / 40 = 22.5%
其中含 PS 专有语法:     32 / 40 = 80.0%
既通过又不依赖 PS 语法:  5 / 40 = 12.5%   ← 真正可迁移的
```

再拿一条"可迁移"的命令实跑（`cd C:\Users\admin\Desktop\CoinsBot` + python here-doc）：

```
exit=1
/usr/bin/bash: line 1: cd: C:UsersadminDesktopCoinsBot: No such file or directory
```

**bash 把 `\` 当转义符吃掉了。** 换 bash 后，所有 `C:\Users\...` 形式的路径、所有 `$env:X`、所有 `Get-*` 全部失效。

**结论：换 bash 不是"解决报错"，是"把 457 条报错换一批新的"。** 而 DSH 的工具描述、系统提示、模型习惯全是按 PowerShell 写的（`Use native Windows paths (C:\...) and $env:NAME variables; this is PowerShell, not bash.`），换 shell 等于和整套提示对抗。

---

## 4. 三条替代路径，逐条给成本

### 路线 A：PTY 常驻 PowerShell（推荐）

现成包：`@deepseek-ai/dsh-tool-pwsh-persistent`

- **注册的工具名仍然叫 `pwsh`**（`lib/index.js:342` `name: "pwsh"`），参数只有 `command`，对模型完全透明 —— 不需要改任何提示词
- 依赖 `ctx.terminals`（PTY 服务），后端用 `dsh-terminal-bash` 配 `shellDialect: pwsh`
- 实测 PTY 往返：**220 / 31.2 / 32.0 ms**，重命令（`1..20000|Measure-Object`）也只要 32 ms
- 对比冷启动 933 ms → **约 29 倍**
- 全库 48,731 次调用 × 900ms ≈ **12.6 小时**的纯启动税，基本可消除
- **额外收益**：`cd` 会保留（状态持久）。现在 411 次重复的 `cd C:\Users\admin\Desktop\whatsapp-android; $env:PYTHONIOENCODING='utf-8'; ...` 前缀可以直接省掉

**代价（必须知道）**：
1. 该包 **完全不引用 sandbox**（grep `sandbox` = 0 命中）。当前 `danger-full-access` 下无差别；若哪天切到 `read-only` / `workspace-write`，会丢掉目录约束
2. 需要自己往 profile 加 PTY 服务行（`dsh-base` 与 `dsh-web-app` 都不含 `dsh-terminal`，只有 `dsh-sdk-minimal` / `dsh-experimental-terminal-bundle` 有）
3. node-pty 是原生模块 —— 已验证：N-API（`napi_register_module_v1`，无 `node_module_register`），跨 ABI 兼容；bundled node v24.21.0 下 `require('node-pty')` 成功，prebuilds `win32-x64` 齐全

**落地改法**（`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml`，在 `preset-standard.plugins` 里改两行 + 顶层加 PTY 服务）：

```yaml
# 顶层（与其它服务行同级，pty 必须在 tool 之前注册）
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        shellDialect: pwsh
        timeoutMs: 300000
```

```yaml
# preset-standard.plugins 内：把工具换掉（id 与 name 一起换，避免 id 复用触发断言）
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: true          # 原来是 !!js process.platform !== 'win32'
      - id: tool-pwsh-persistent
        name: '@deepseek-ai/dsh-tool-pwsh-persistent'
        config:
          timeoutMs: 300000
```

### 路线 B：装 PowerShell 7

- `dsh-pwsh-local` 的 `candidatePwshPaths` 顺序是：`Program Files\PowerShell\7\pwsh.exe` → PATH 各 `pwsh.exe` → `System32\WindowsPowerShell\v1.0\powershell.exe`
- **本机没装 PS7**（三个候选全 False），所以落到了 5.1
- PS7 冷启动比 5.1 略快，但**仍是每命令一个进程**，启动税降不到 PTY 的 32ms 量级
- 额外收益：PS7 支持 `&&`、`||`、三元运算符，能救回 13 次 `||` 报错（439 次的 3%）
- **本机没有 winget**（`where winget` → exit 1），得手工下 MSI
- **这条可以和 A 叠加**：PTY 后端 `shellDialect: pwsh` 会自动走 `resolvePwshPath()`，装了 PS7 就自动用 PS7

### 路线 C：真换 bash 执行器（不推荐）

- DSH 的 `tool-bash` 和 `tool-pwsh` **共用同一个 `ctx.shell`**（两者 `inject = ["tools","shell",...]`，都调 `ctx.shell.resolve/execute`）
- Windows 上 `bash-sandbox` 与 `tool-bash` 都被 `disabled: !!js process.platform === 'win32'` 关掉，`ctx.shell` 只能由 `pwsh-sandbox` 提供
- **所以"打开 tool-bash"只会让 `bash` 这个工具名去跑 PowerShell**，不会真的跑 bash。要真换必须同时替换执行器
- 即便真换了：PATH 里的 `bash` = `C:\Windows\System32\bash.exe` = **WSL**，首次调用 11,005 ms（要起 VM），且路径是 `/mnt/c/...`
- 走 git-bash 要额外配 `shellPath`，且第 3 节的实测说明收益为负

---

## 5. 顺带修掉的一个真 bug：`-File` 执行策略

`C:\Users\admin\Desktop\CoinsBot\server\restart_dashboard.ps1`（6,116 B / 138 行，`NotSigned`、`no_zone`）用 `-File` 跑必然失败：

```
AuthorizationManager check failed.
    + CategoryInfo : SecurityError: (:) [], ParentContainsErrorRecordException
```

实测：
- 同一路径连跑 **5 次，5 次全失败**（稳定复现，不是偶发）
- 同样的**内容**写到 `.probe\` 目录下跑 → 成功（所以是路径/ACL 相关，不是文件内容问题）
- 31 字节的未签名脚本 `-File` 跑 → 成功（所以不是"未签名"本身）
- **加 `-ExecutionPolicy Bypass` → 3 次全成功**
- **环境变量 `PSExecutionPolicyPreference=Bypass` → 也成功**（`Unrestricted` 无效，必须是 `Bypass`）
- 原策略：`CurrentUser = RemoteSigned`（`Set-ExecutionPolicy` 改成 `Unrestricted` 也不管用，已还原为 `RemoteSigned`）

**这是 Windows PowerShell 的 AuthorizationManager 安全检查缺陷**，与 DSH 无关。规避方式：跑 `.ps1` 时一律带 `-ExecutionPolicy Bypass` 或设 `PSExecutionPolicyPreference=Bypass`。

---

## 6. 真正能减少报错的三件事（按性价比）

1. **PTY 常驻**（路线 A）：省 12.6h 启动税 + `cd`/变量状态保留，报错的"看起来频繁"会明显下降
2. **长命令改写成 `.ps1` 文件再 `-File` 跑**：实测 `-Command` 和 `-File` 对引号错误的通过率**一样**（4/5 都失败），但 `.ps1` 文件里可以自由用 here-string、不用层层转义，模型写错概率大幅下降；配合 `PSExecutionPolicyPreference=Bypass`
3. **把 here-doc 和 bash 语法从工具描述里彻底禁掉**：127 + 259 次报错（占 88%）属于这一类。`dsh-sdk-minimal` 里那份工具描述已经写了 "this is PowerShell, not bash"，可以直接抄过来强化

**要诚实说明的一点**：`dsh-tool-pwsh-persistent` 的默认描述里写了 `State is persistent across command calls`，会诱导模型在会话里累积状态（改 `$env:`、`cd` 到别处），一旦某条命令报错，后续命令的环境可能已经脏了。**这是常驻 shell 的固有代价**，需要在工具描述里明确要求"每条命令自己 `cd` 到目标目录"。

---

## 7. 复现脚本

| 脚本 | 作用 |
|---|---|
| `.probe\pwsherr2.mjs` | 按 `[stderr]` 精确分类 5,521 条报错 |
| `.probe\psvsmigrate.mjs` | PS 专有语法占比 + 明确失败的真实成本 |
| `.probe\pslangneed.mjs` | 49,301 条命令的五层语法需求分层 |
| `.probe\parsecause.mjs` | 439 条解析错误成因归类 |
| `.probe\failcmds.mjs` | 从日志里抽出真实失败命令 → `parser_fail_cmds.json` |
| `.probe\bashmigrate.mjs` | **关键**：40 条失败命令丢给 git-bash 语法检查 + 实跑 |
| `.probe\shellbench.mjs` | PS5.1 / git-bash / cmd / node 冷启动耗时 |
| `.probe\ptytest3.mjs` | node-pty 常驻往返（PS 与 git-bash 对照） |
| `.probe\ptyabi.mjs` / `.probe\napi.mjs` | node-pty 是否 N-API、能否被 bundled node 加载 |
| `.probe\authfix.mjs` | `-File` + AuthorizationManager 的 4 组对照实验 |
| `.probe\authbisect.mjs` | 前缀二分定位触发行（结论：与行无关，与路径有关） |
| `.probe\shellbind.mjs` / `.probe\bashonwin.mjs` | 证明 tool-bash 与 tool-pwsh 共用 `ctx.shell` |
| `.probe\ptywire.mjs` | PTY 服务行接线方式（对照 sdk-minimal） |
| `.probe\resolve2.mjs` | 确认 `@deepseek-ai/*` 从 app 目录解析，profile 里直接写 name 即可 |

**解析坑（必记）**：
- 会话日志是多帧 zstd 拼接，按 magic `28 B5 2F FD` 切帧逐帧 `zlib.zstdDecompressSync`
- `time` 是 epoch ms UTC，+8h 才是本地
- `usage` 在 `data.usage`；`tool/call` = `data.name`/`data.callId`/`data.arguments`（JSON 串）；`tool/result` = `data.message.toolCallId`
- **PowerShell 脚本里写中文会被按 ANSI 读坏语法** → 探针一律用 Node 写
- `& $node $node` 双写会报 `This program cannot be run in DOS mode`
