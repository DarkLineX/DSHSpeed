# dsh-shell-fast

在保留原生冷启动 `pwsh` 的前提下，再加一条**常驻** PowerShell 通道，工具名 `pws`。

## 为什么

DSH 的 `dsh-tool-pwsh` 每次调用都 fork 一个全新的 `powershell.exe`
（`dsh-pwsh-local/lib/index.js:199-214`，`argv = [pwshPath, -NoLogo, -NoProfile, -NonInteractive, -Command, ...]`）。
全库 48,731 次干净配对里，**极短命令的中位耗时是 933ms**，其中约 480ms 是 PowerShell 自己的启动；
`0.7–1.3s` 这个窄带占了 56.1%（27,351 次）。按 48,731 × 933ms 算，**启动税 = 12.64h**。

本插件让同一条命令走一个已经起来的 PTY shell，往返降到毫秒级。

## 实测（本机，2026-11-11）

| | 中位 | n |
|---|---|---|
| `pws`（常驻 PTY） | **185 ms** | 7 |
| `pwsh`（冷启动，PS 7.7.0） | **926 ms** | 813 |

差 **5.0×**。裸 PTY 探针（`.probe/ptytime.mjs`）测到稳态往返 `15–16ms`，
差额来自 DSH 侧的标记包裹、scrollback 读取和工具分发。

## 装了什么

三行，全部是**根级 insert**（不是覆盖——顶层 `- id: X` 不带 `insert` 只会去改一个已存在的条目）：

```yaml
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'          # owner 级 PTY 服务
    - id: terminal-shellfast
      name: '@deepseek-ai/dsh-terminal-bash'      # PTY 后端，pwsh 方言
      config:
        backendType: shellfast                    # 不能叫 shell，会和已有后端撞
        shellDialect: pwsh
        shellPath: 'C:\Users\admin\AppData\Local\Programs\PowerShell\7\pwsh.exe'
        timeoutMs: 300000
    - id: shell-fast
      name: dsh-shell-fast                        # 本插件
      config:
        toolName: pws
        backendType: shellfast
        timeoutMs: 300000
        maxOutputChars: 16000
```

`dsh-base` 本身**不含 PTY 服务**（只在 `dsh-subprocess-local` 上有 subprocess），
所以 `pty` 那行必须自己加。

## 协议

和第一方 `dsh-tool-pwsh-persistent` 完全一致的 marker 包裹：

```
Write-Output '<start>';
try { Invoke-Expression "<escaped body>"; $__ok = $? } catch { $__ok = $false };
...
Write-Output ('<end>' + $__s)
```

为什么必须用 `Invoke-Expression` 包一层：模型给的命令可能多行（`if {}` 块、here-string）、
含 `$()`、含管道链。直接把这些字节写进 PTY 会让 shell 进入续行等待，
而包成一个单行 `Invoke-Expression` 后**整段作为一个 parse unit** 提交。

### 试过但否掉的两条路

1. **`pwsh -Command -` 走 stdin 管道**：状态持久、往返只要 1–7ms，
   但只要命令跨行就**死锁**——`-Command -` 按行读，遇到不完整语句就等下一行，
   而 marker 也在同一个流里，永远等不到。日志见 `.probe/pipeproto3.log`。
2. **直接改 `dsh-bash-local` 的 PATH 去命中 git-bash**：`execute` 里 `["bash","-c",...]` 是字面量写死、
   `Config` 没有 `shellPath`，而且全库 90.3% 的命令用了 PS 专有语法（`bash -n` 只过 39%）。

## 和 `pwsh` 的分工

两者并存，不互相顶掉：

- `pwsh` — 一次性、跑完就忘的命令：`gradle`、`python` 脚本、`adb`、装包。冷启动那 ~0.9s 摊在几十秒的活里无所谓。
- `pws` — 一串短的状态检查：`Get-Process`、`Get-Content -Tail`、`Select-String`、`cd` 后接着查。
  这里 0.9s 就是全部成本，且 `cd`/`$env:` 能跨调用保留。

## 行为

- **owner 隔离**：每个 agent 一个独立 shell，`ctx.terminals` 保证只有注册过的 owner 能碰。
- **串行**：同一 owner 的调用排队执行（`serialized`），不会两个命令插进同一个 PTY。
- **超时**：`timeoutMs` 到点先返回已产生的部分输出，然后 reset shell，下次从工作目录重来。
- **shell 退出**：返回 `[shell exited: code N]` 并 reset，下次自动重建。
- **sandbox**：这条路由**不走** `dsh-pwsh-sandbox`（`dsh-tool-pwsh-persistent` 本身也是零 sandbox 引用）。
  当前 `danger-full-access` 下行为无差；若切到 `read-only`/`workspace-write`，`pws` 不受约束，`pwsh` 受。
- **输出上限**：`maxOutputChars` 默认 16,000，超出截断并附提示。

## 验证

```powershell
# 1. 工具是否注册
#    request/header 的 tools 里应同时有 pws 和 pwsh

# 2. 版本 + 持久化
pws: $PSVersionTable.PSVersion          # 7.7.0
pws: $env:FOO='x'; cd C:\Users\admin\Desktop\CoinsBot
pws: $env:FOO; (Get-Location).Path      # x / CoinsBot
pws: $PID                               # 两次调用 PID 相同

# 3. 边界
pws: if ($true) { echo BLOCK_OK }       # 多行块
pws: $t = @'
LINE1
'@; $t                                  # here-string
pws: echo "v=$(1+1)"                    # 子表达式
pws: python -c "print('PY_OK')"         # 外部程序
```

## 文件

- `lib/index.js` — 全部逻辑（PTY 会话管理、marker 协议、输出截取、超时与重置）
- `cordis.patch.yml` — bundle patch（安装时用）
- 安装位置：`C:\Users\admin\.dsh\profiles\desktop\plugins\dsh-shell-fast`
  + profile `package.json` 的 `dependencies` 加 `"dsh-shell-fast": "file:./plugins/dsh-shell-fast"`
  + profile `cordis.patch.yml` 末尾的 insert 块

## 回滚

```powershell
$prof = 'C:\Users\admin\.dsh\profiles\desktop'
Copy-Item "$prof\cordis.patch.yml.bak-shellfast-202611111510" "$prof\cordis.patch.yml" -Force
Copy-Item "$prof\package.json.bak-shellfast-202611111510" "$prof\package.json" -Force
```

（`pws` 消失、`pwsh` 照旧。插件本体可以留着不删，不接线就不会加载。）

## 路由提示

真正让模型会用 `pws` 的是**工具描述本身**（348 字符，已包含
`Prefer it over pwsh for short repeated status checks`），它每次请求都会随
工具目录一起下发。

另外在 profile 的 `system-prompt.config.personaSuffix` 里也写了一段选择指引
（`Shell choice: ...`）。这段**不是必需的**，而且实测下来：

- YAML 解析正确，`personaSuffix` 读到的就是那段文本
- 但当前会话的 `system/message` 事件仍是旧版本，没有重渲染
  —— `SystemPrompt` 在构造函数里把 `personaSuffix` 固化成 section 文本，
  配置热更新不会重跑构造函数；要等新会话或重启宿主才生效

也就是说：删掉这段也不影响 `pws` 被正确选择。留着是为了新会话有个更强的引导。

## 已知限制

- PTY 后端 `dsh-terminal-bash` 的完成判定依赖提示符回显。pwsh 方言下走
  `PWSH_PROMPT_SETUP` 注入 `dsh> ` 提示符，`promptTextSeen` 能正常置位，
  所以走快路径（`pollIntervalMs` 50ms）。若换成真 bash 方言，尾空格会被
  `ESC[1C` 吃掉、`promptTextSeen` 永远 false，每条命令会退化到等
  `idleSilenceMs + handoffGraceMs` = 3500ms —— 这也是没选 git-bash 的原因之一。
- 交互式输入（`Read-Host` 等）会返回 `stdin_read` 的部分输出，不会挂住；
  要交互得用 `dsh-tool-terminal` 的 `terminal_send`。
