$ErrorActionPreference = 'Continue'
$log    = 'C:\Users\admin\Desktop\DSHSpeed\restart-dsh.log'
$res    = 'C:\Users\admin\Desktop\DSHSpeed\restart-dsh.result.txt'
$exe    = 'C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$appDir = 'C:\Users\admin\AppData\Local\Programs\DeepSeek Harness'
$dshDir = 'C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh'
$probe  = 'C:\Users\admin\Desktop\DSHSpeed\.probe\_postrestart_cap.mjs'

function L($m) { ("{0}  {1}" -f (Get-Date).ToString('HH:mm:ss.fff'), $m) | Out-File -FilePath $log -Append -Encoding utf8 }
function Out2($m) { L $m; $m | Out-File -FilePath $res -Append -Encoding utf8 }

"=== restart run $(Get-Date -Format o)  (detached pid=$PID, parent=WmiPrvSE) ===" | Out-File -FilePath $log -Append -Encoding utf8
Remove-Item $res -ErrorAction SilentlyContinue

Out2 ("pre-kill pids: " + ((Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','))

L 'grace period 90s: let the requesting turn finish and persist'
Start-Sleep -Seconds 90

# ---- 1a. graceful first: WM_CLOSE to the electron main so the quit path flushes session logs ----
$main = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -notlike '*--type=*' })
foreach ($m in $main) {
    L ("graceful close request -> main pid " + $m.ProcessId)
    Stop-Process -Id $m.ProcessId -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { break }
}
Out2 ("after graceful close, remaining: " + (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count))

# ---- 1b. force-kill whatever is left (root first, then sweep) ----
for ($round = 1; $round -le 5; $round++) {
    $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { L "round ${round}: nothing left"; break }
    L ("round {0}: {1} pids {2}" -f $round, $procs.Count, (($procs | ForEach-Object { $_.Id }) -join ','))
    $allIds = @($procs | ForEach-Object { $_.Id })
    foreach ($p in $procs) {
        $ppid = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).ParentProcessId
        if ($allIds -notcontains $ppid) {
            L ("  root kill $($p.Id) (parent $ppid)")
            & taskkill /T /F /PID $p.Id *>&1 | ForEach-Object { L ("    " + $_) }
        }
    }
    Start-Sleep -Seconds 2
    foreach ($p in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
        & taskkill /T /F /PID $p.Id *>&1 | ForEach-Object { L ("    sweep " + $_) }
    }
    Start-Sleep -Seconds 2
}

$left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Out2 ("after kill, DSH processes remaining: " + $left.Count + " " + (($left | ForEach-Object { $_.Id }) -join ','))

# ---- 2. leftover bili proxy (child of the dead host) ----
$oldBili = $null
try {
    $c = @(Get-NetTCPConnection -State Listen -LocalPort 18787 -ErrorAction Stop)
    if ($c.Count -gt 0) {
        $oldBili = $c[0].OwningProcess
        L ("killing leftover bili proxy pid $oldBili")
        & taskkill /T /F /PID $oldBili *>&1 | ForEach-Object { L ("  " + $_) }
    }
} catch { L 'no leftover listener on 18787' }
Start-Sleep -Seconds 2

# ---- 3. relaunch electron main exactly as Windows had it ----
try {
    Start-Process -FilePath $exe -WorkingDirectory $appDir -ErrorAction Stop
    Out2 'relaunch: DeepSeek Harness.exe started (no args = electron main)'
} catch {
    Out2 ("relaunch FAILED: " + $_.Exception.Message)
}

# ---- 4. wait for the new host process (port is random: --port 0) ----
$hostProc = $null
$elapsed  = 0
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    $elapsed = ($i + 1) * 2
    $hp = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*dsh-desktop-host*' })
    if ($hp.Count -gt 0) { $hostProc = $hp[0]; break }
}
if (-not $hostProc) {
    Out2 'FAIL: host process did not come back within 180s'
    exit 1
}
Out2 ("host back after ~${elapsed}s: pid " + $hostProc.ProcessId)

$ports = @()
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
               Where-Object { $_.OwningProcess -eq [int]$hostProc.ProcessId })
    if ($ports.Count -gt 0) { break }
}
if ($ports.Count -gt 0) {
    Out2 ("GUI listening: " + (($ports | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ','))
} else {
    Out2 'WARN: no listener found for the new host within 120s'
}

# ---- 5. new bili proxy should be re-spawned by the new host ----
Start-Sleep -Seconds 8
try {
    $nb = @(Get-NetTCPConnection -State Listen -LocalPort 18787 -ErrorAction Stop)
    if ($nb.Count -gt 0) {
        $newBili = $nb[0].OwningProcess
        Out2 ("bili proxy back on 18787: pid $newBili (was $oldBili)")
    } else {
        Out2 'WARN: bili proxy not listening on 18787 yet'
    }
} catch { Out2 'WARN: 18787 not listening' }

# ---- 6. prove the freshly loaded module resolves the 120s cap ----
@'
import { pathToFileURL } from "node:url";
const p = "C:/Users/admin/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js";
const m = await import(pathToFileURL(p).href);
const cfg = new m.Config({});
console.log(JSON.stringify({ waitTimeoutMs: cfg.waitTimeoutMs, maxWaitTimeoutMs: cfg.maxWaitTimeoutMs }));
'@ | Set-Content -Path $probe -Encoding utf8
Push-Location $dshDir
$out = & 'C:\Program Files\nodejs\node.exe' $probe 2>&1
Pop-Location
Out2 ("fresh-process tool-jobs config: " + ($out -join ' | '))

$f = Join-Path $dshDir 'node_modules\@deepseek-ai\dsh-tool-jobs\lib\index.js'
Out2 ("on-disk default(12e4) present: " + ((Select-String -Path $f -SimpleMatch 'default(12e4)' -ErrorAction SilentlyContinue) -ne $null))

(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id, StartTime, @{n='MB';e={[int]($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String) | Out-File -FilePath $res -Append -Encoding utf8
L 'done'
