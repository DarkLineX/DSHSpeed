# adb 硬看门狗补丁（CoinsBot）

## 问题

`subprocess.run(timeout=)` 在 CoinsBot 的 adb 调用链上**不生效**：

- `_fix_dead_node.py:12` — `subprocess.run(["adb",...], timeout=60)`
- `clash_ctl.py:36` — `subprocess.run(args, timeout=40)`
- `clash_ctl.py:51` — `subprocess.run(["adb","push",...], timeout=60)`

实测 `PID 6980` 在 14 分钟后仍然存活、0 TCP、读写字节增量为 0、单线程 `Wait(UserRequest)`。
`subprocess.run` 的 timeout 靠 `Popen.communicate(timeout=)` 提升为 `TimeoutExpired` 后再 `kill()`——**它只杀直接子进程**；`adb.exe` 派生的 server 进程、以及在 `su -c` 里挂住的远端 shell 不会被回收，父进程仍在等管道的 EOF。加上 `region_ctl.py:44-54` 注入了 `creationflags=CREATE_NO_WINDOW` 的 monkey patch，句柄继承关系更绕。

## 补丁

在 `server/ops/proxy/clash_ctl.py` 顶部（`CTL = "127.0.0.1:9090"` 之后）加：

```python
import os
import time

def run_guarded(args, timeout=40, capture=True):
    """跑子进程，到点用 taskkill /T /F 连整棵子树一起杀，保证不挂死。

    subprocess.run 的 timeout 只 kill 直接子进程：adb 拉起的 server、su -c 里的远端
    shell 会留下来继续占着管道，父进程永远等不到 EOF。这里改成显式 Popen + 整树杀。
    """
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.Popen(
        args,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        creationflags=flags,
    )
    try:
        out, err = p.communicate(timeout=timeout)
        return (out or b""), (err or b"")
    except subprocess.TimeoutExpired:
        # /T 连子进程树，/F 强制
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       capture_output=True, creationflags=flags)
        try:
            out, err = p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = b"", b""
        raise TimeoutError(
            "adb 超时 %ss 被强杀: %s\n尾字节: %r" %
            (timeout, " ".join(map(str, args))[:160], (err or out or b"")[-200:])
        )
```

然后把三处调用替换掉：

```python
# clash_ctl.py:36  adb()
    try:
        out, err = run_guarded(args, timeout=timeout)
        return (out.decode("utf-8", "replace") if isinstance(out, bytes) else out) + \
               (err.decode("utf-8", "replace") if isinstance(err, bytes) else err)
    except TimeoutError:
        return ""

# clash_ctl.py:51  _sh() 里的 push
    try:
        run_guarded(["adb", "-s", serial, "push", path, remote], timeout=60)
    except TimeoutError:
        os.unlink(path)
        return ""

# clash_ctl.py:71  ctl() 里的 push
    try:
        run_guarded(["adb", "-s", serial, "push", path_local, "/data/local/tmp/_req.bin"], timeout=60)
    except TimeoutError:
        os.unlink(path_local)
        return ""
```

`_fix_dead_node.py:12` 的 `sh()` 同样换成 `run_guarded`：

```python
from ops.proxy.clash_ctl import run_guarded

def sh(serial, cmd, t=60):
    try:
        out, _ = run_guarded(["adb", "-s", serial, "shell", cmd], timeout=t)
        return out.decode("utf-8", "replace").strip()
    except TimeoutError:
        return ""
```

## 验证

```powershell
cd C:\Users\admin\Desktop\CoinsBot
# 先人为造一个挂死：让设备端 sleep 300，主机 timeout 给 10
server\venv\Scripts\python.exe -c "from server.ops.proxy.clash_ctl import adb; print(repr(adb('192.168.2.144:5566','sleep 300',timeout=10)))"
# 期望：10s 内返回 ''，且 Get-Process adb 里没有残留
```

## 配套的调用侧纪律

即使 adb 修好了，**后台任务的输出不要接在管道尾部**：

```powershell
# ✗ 父 pwsh 等 stdout 关闭 → 子进程不死则永不到 EOF
python x.py 2>&1 | Select-Object -Last 30

# ✓ 先落盘
python x.py *> _x.log 2>&1
# ✓ 读的时候再取尾巴
Get-Content _x.log -Tail 30
```
