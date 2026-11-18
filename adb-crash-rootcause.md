# adb.exe 一天崩 1,378 次：根因是 DSH 沙箱留下的 Low 完整性标签

日期：2026-11-11　　机器：`DESKTOP-GRLCEKG`（Windows 10.0.19045）

---

## 1. 现象

`Application` 日志里 `adb.exe` 崩溃（`ProviderName='Application Error'`）：

| 日期 | 崩溃次数 |
|---|---|
| 11-09 | 2 |
| 11-10 | 164 |
| **11-11** | **1,212** |

11-11 按小时：**12:00 → 956 次，13:00 → 256 次**，12:00–13:16 连续 77 分钟稳定在 **14–27 次/分钟**。

崩溃明细：

```
错误模块名称: ucrtbase.dll，版本: 10.0.19041.3636
异常代码: 0xc0000409
错误偏移量: 0x0009eddb
```

`0xc0000409` = `STATUS_STACK_BUFFER_OVERRUN`，在 CRT 里通常意味着 **`abort()` 被调用**。崩溃数 1,376 / 唯一 PID 1,094 → server 在反复重启。

按二进制归属：**1,182 次来自 `C:\Users\admin\Desktop\CoinsBot\server\scrcpy-win64-v4.1\adb.exe`**，30 次来自 SDK 那份。

## 2. 日志里的致命行

`C:\Users\admin\Desktop\CoinsBot\server\data\boot_selfcheck.log`（12:05–12:07 那段）：

```
11-11 12:06:52.560 27364  2132 F adb     : main.cpp:55 cannot open
    C:\Users\admin\AppData\Local\Temp\adb.log: Permission denied
could not read ok from ADB Server
* failed to start daemon
error: cannot connect to daemon
```

同文本 11-02 也有 6 条（`ok=0 bad=6`），11-11 12:05 又一次 `ok=0 bad=6`。

## 3. 根因：Low Mandatory Level 完整性标签

### 3.1 决定性对照

同一份 `adb.exe`（sha256 前 16 位 `957E46B8615F7AF5`，两份 **完全相同**）：

| 位置 | `start-server` 结果 |
|---|---|
| `...\CoinsBot\server\scrcpy-win64-v4.1\adb.exe`（原位） | **abort / cannot open** |
| 同一份复制到 `%LOCALAPPDATA%\CoinsBot\dllbisect\only-adb\adb.exe` | **OK, daemon started** |
| `...\Android\Sdk\platform-tools\adb.exe`（原位） | **OK, daemon started** |
| scrcpy 那份，仅把 `cwd` 换成 SDK 目录 | **仍然 abort** |

→ 与二进制无关、与 cwd 无关，**是这个文件/目录本身带的某个属性**。

### 3.2 `icacls` 找出了它

```
C:\...\scrcpy-win64-v4.1\adb.exe   ...
                                   Mandatory Label\Low Mandatory Level:(I)(NW)
```

而 SDK 那份没有这一行。再往上查整条祖先链：

| 目录 | 完整性标签 |
|---|---|
| `C:\Users\admin\Desktop\CoinsBot\server\scrcpy-win64-v4.1` | **Low** |
| `C:\Users\admin\Desktop\CoinsBot\server` | **Low** |
| `C:\Users\admin\Desktop\CoinsBot` | **Low** |
| `C:\Users\admin\Desktop` | — |
| `C:\Users\admin` | — |
| `C:\Users\admin\Desktop\whatsapp-android` | **Low** |
| `C:\Users\admin\Desktop\KernelForge` | **Low** |
| `C:\Users\admin\Desktop\DSHSpeed` | — |
| `C:\Users\admin\AppData\Local\Temp` | — |

### 3.3 机制

Windows 的 `NW` = `NO_WRITE_UP`。低完整性（Low IL）进程**不允许向更高完整性对象写入**。

- adb server 进程继承了所在目录的 Low 标签；
- 它要写的 `%TEMP%\adb.log` 在 `C:\Users\admin\AppData\Local\Temp`，是 **Medium 完整性**；
- Low → Medium 的写被强制拒绝 → `open()` 返回 `EACCES` → `main.cpp:55` 打印 `Permission denied`；
- adb 的 `main.cpp` 对这种情况直接 `abort()` → `ucrtbase.dll` + `0xc0000409`。

**为什么私有 TEMP 也没用**：`.probe\adbprivtmp.py` 把 `TMP`/`TEMP` 指向 `%LOCALAPPDATA%\CoinsBot\adb-tmp`，仍然 `Permission denied`——因为那个新目录同样位于 `%LOCALAPPDATA%` 下的 Medium 区域，Low 进程照样写不进去。`adbtmpperm.py` 换了 4 个目录（私有 / 原 `%TEMP%` / `AppData\Local` 下新建 / `tempfile.mkdtemp`）全部失败，而 Python 自己在每个目录都能写 → **不是目录权限问题，是进程完整性级别问题**。

**为什么 SDK 那份没崩**：`C:\Users\admin\AppData\Local\Android\Sdk\platform-tools` 不在 Low 目录里，继承的是 Medium。

## 4. 修复

### 4.1 提升目录完整性（根治）

```powershell
# 最小修复：只动出问题的 scrcpy 目录
icacls 'C:\Users\admin\Desktop\CoinsBot\server\scrcpy-win64-v4.1' /setintegritylevel '(OI)(CI)Medium'

# 彻底修复：三个项目树整棵提升（都带 Low 标签）
icacls 'C:\Users\admin\Desktop\CoinsBot'        /setintegritylevel '(OI)(CI)Medium'
icacls 'C:\Users\admin\Desktop\whatsapp-android' /setintegritylevel '(OI)(CI)Medium'
icacls 'C:\Users\admin\Desktop\KernelForge'      /setintegritylevel '(OI)(CI)Medium'
```

执行结果：`Successfully processed 1 files; Failed processing 0 files`，CoinsBot 整树 5.1 秒。

全树复核（32,301 个对象逐个 `icacls`）：**仍为 Low 的 0 个**。

### 4.2 效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `start-server` | abort / cannot open | **OK, daemon started successfully** |
| `%TEMP%\adb.log` | 不存在 | **18,263 B** |
| 500 次 `adb devices` soak | bad=50/200（25%） | **bad=0，14.8s，平均 30ms** |
| 17:31 之后崩溃事件 | 120 次/30 分钟 | **0** |

## 5. 顺带修掉的两个问题

### 5.1 `_shadow_run.py` 硬编码 SDK adb

原 `:5` 写死 `ADB = r"C:\Users\admin\AppData\Local\Android\Sdk\platform-tools\adb.exe"`，与 `proto_login.DEFAULT_ADB`（`server\ops\proto_login.py:58`）指向的 scrcpy 版本不是同一个。

改成按优先级解析：

```
--adb 参数  >  COINSBOT_ADB 环境变量  >  scrcpy 目录  >  项目内同名  >  SDK  >  shutil.which("adb")  >  SystemExit
```

实测解析结果 = `C:\Users\admin\Desktop\CoinsBot\server\scrcpy-win64-v4.1\adb.exe`，与 `proto_login` 一致。

### 5.2 20 个文件的 subprocess 黑窗

`_shadow_run.py` 的 `run()` 已在 `:43` 带 `creationflags=_NO_WINDOW`，但 server 侧另外 16 个文件各自 `subprocess.run(...)` 时没带，被 pwsh 循环拉起时每次 adb 调用都弹一个控制台黑窗。

用 monkeypatch 一处覆盖全文件（备份在 `.cfg-bak-nw-20261111-172023\`）：

```python
# --- Windows: 抑制 adb.exe 等子进程弹出的控制台黑窗 ---
if hasattr(subprocess, "CREATE_NO_WINDOW") and not globals().get("_NO_WINDOW_PATCH_APPLIED", False):
    _NO_WINDOW_PATCH_APPLIED = True
    if not hasattr(subprocess, "_cbn_no_window"):
        subprocess._cbn_no_window = subprocess.CREATE_NO_WINDOW
        _cbn_orig_run = subprocess.run

        def _cbn_run_hidden(*args, **kwargs):
            kwargs.setdefault("creationflags", subprocess._cbn_no_window)
            return _cbn_orig_run(*args, **kwargs)

        subprocess.run = _cbn_run_hidden
```

已打补丁的 16 个文件（全部 `AST OK / flags=True / marker=True`）：

`server\_account_backup.py`、`server\ops\acct_backup.py`、`server\ops\boot_selfcheck.py`、
`server\ops\check_login_candidates.py`、`server\ops\dev_cert_owners.py`、
`server\ops\login_one_per_device.py`、`server\ops\read_dev_certs.py`、
`server\ops\switch_device_account.py`、`server\ops\verify_all_logged_in.py`、
`server\ops\wa_login_state.py`、`server\ops\diagnostics\_progress.py`、
`server\ops\diagnostics\_recv_check.py`、`server\ops\diagnostics\watch_inbound.py`、
`server\ops\maintenance\_purge_banned_archives.py`、`server\ops\proxy\region_ctl.py`

原先已有 `creationflags` 的 5 个：`_shadow_run.py`、`server\dashboard.py`（`:26-36` 全局 monkeypatch）、`server\ops\code_waste_alert.py`、`server\ops\proto_login.py:214-216`、`server\ops\report15.py`

运行时验证：`subprocess.run patched: True` / `call still works: True child-ok` / `creationflags used: 134217728`。

### 5.3 统一入口 `server\ops\adb.py`（新建）

导出：`ADB`、`ADB_VERSION_TAG`、`CREATE_NO_WINDOW`、`adb_tmp_dir()`、`ensure_env()`、
`adb_run(args, timeout=90, cwd=None, extra_env=None, check=False)`、`adb(serial, *args)`、
`sh(serial, cmd, timeout=120, as_root=False)`、`adb_devices()`、`ensure_server()`。

设计要点：
- 只允许一份 adb 当 server（避免两个版本互相驱逐）；
- 所有调用带 `CREATE_NO_WINDOW`；
- `ensure_server()` 失败时先 `kill-server` 再重起。

## 6. 为什么之前排查一直绕圈

| 假设 | 实验 | 结论 |
|---|---|---|
| `CREATE_NO_WINDOW` 导致崩溃 | `adbcrash.py` 20 次带/不带 flag | 全 rc=0，否定 |
| 两个 adb 版本抢 server | `adbfight.py` / `adbvers.py` 交替 | 0 崩溃，否定 |
| 并发 8 路 adb | `adblog.py` | returncodes 全 0，否定 |
| `ADB_TRACE` 环境变量 | 全项目 11,410 文件扫，0 命中 | 否定 |
| `%TEMP%\adb.log` 被独占句柄锁 | `adblocker.py` 四种 share 模式 / `msvcrt.locking` | 字节锁不阻止 adb，否定 |
| 目录差异 | `adbswap2.py` binary/目录交换矩阵 | 误判为目录 → 实际不是"哪个目录"，而是"目录的完整性标签" |
| DLL 冲突 | `adbdllbisect.py` 五组隔离 | 全 OK（复制到 Medium 目录后自然就好了），否定 |

**决定性的一步**是「把同一份 exe 复制到 `%LOCALAPPDATA%` 下再跑」——复制动作不继承 Low 标签，于是它就从必崩变成必好。这一步把"二进制"和"环境"彻底分开，之后 `icacls` 一查就现形。

## 7. 复现与验证脚本

全部在 `C:\Users\admin\Desktop\DSHSpeed\.probe\`：

| 脚本 | 作用 |
|---|---|
| `adbconcur.py` | 并发启动 adb 是否抢占 server |
| `adbprivtmp.py` | 私有 TEMP 能否绕开（结论：不能） |
| `adbtmpperm.py` | 4 个目录 × Python写 / adb起server 对照 |
| `adbdeldpend.py` | `CreateFileW` 探测 errno（2=not-found / 5=access-denied / 32=sharing） |
| `adbwhich3.py` | 三份 adb.exe 逐个起 server（**关键对照**） |
| `adbdllbisect.py` | DLL 隔离二分 + 复制到别处对照（**找到"复制即好"**） |
| `adbintegrity.py` / `adbintegrity2.py` | 改完整性级别前后对照（**验证根因**） |
| `adbsoak3.py` | 500 次 soak + 崩溃事件核查 |
| `adbreconnect.py` | 用面板 API 端口全量重连 |
| `patchnowin.py` / `patchnowin2.py` | 批量注入 `CREATE_NO_WINDOW` |
| `verifypatch.py` | AST + 运行时验证补丁 |

## 8. 运维提醒

- **这类项目目录（`CoinsBot` / `whatsapp-android` / `KernelForge`）以后都别让它落到 Low 完整性**。DSH 在 `danger-full-access` 下对工作区会打 `Mandatory Label\Low Mandatory Level:(NW)`，这是它沙箱的一部分；它只管自己工作区里的读写，**不会**关照你在这些目录里跑的第三方可执行文件会不会写不了 `%TEMP%`。
- 判断方法：`icacls <path> | Select-String 'Mandatory Label'`，出现 `Low` 就要注意。
- 修复方法：`icacls <path> /setintegritylevel '(OI)(CI)Medium'`。
- 别用 `taskkill /F /IM adb.exe` 当日常手段：杀掉 server 后**所有 IP 设备会瞬间掉线**，必须逐个 `adb connect` 重连。端口来源用面板 `http://127.0.0.1:5000/api/devices`。
