#!/usr/bin/env node
// dsh-session-tail.js — 直接读取 DSH 会话文件(session.v4.jsonl.zstd 多帧 zstd)，
// 判断某个会话到底是在跑、在等、还是真的停了。
//
// 用法:
//   node tools/dsh-session-tail.js                 # 交互式列出所有含未完成 turn 的会话
//   node tools/dsh-session-tail.js --session <id>  # 指定会话(可用 id 前缀)
//   node tools/dsh-session-tail.js --dir <path>    # 指定会话目录
//   node tools/dsh-session-tail.js --events 40     # 打印末尾 N 条事件
//   node tools/dsh-session-tail.js --watch         # 每 5s 刷新一次进度
//
// 关键判据: turn/start 之后没有对应 turn/end ⇒ 该 turn 仍在飞。
// 最后一条事件的时间 vs 现在 ⇒ 是否真的卡住。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SESSION_ROOT = process.env.DSH_SESSION_ROOT || path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function argv(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : process.argv[i + 1];
}
const has = (flag) => process.argv.includes(flag);

function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 1; }
  let text = '';
  let badFrames = 0;
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); }
    catch { badFrames++; }
  }
  const events = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { events, badFrames, badLines, bytes: buf.length, mtimeMs: fs.statSync(file).mtimeMs };
}

function listSessions() {
  const out = [];
  if (!fs.existsSync(SESSION_ROOT)) return out;
  for (const proj of fs.readdirSync(SESSION_ROOT)) {
    const pdir = path.join(SESSION_ROOT, proj);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const sid of fs.readdirSync(pdir)) {
      const file = path.join(pdir, sid, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) out.push({ proj, sid, file });
    }
  }
  return out;
}

const ts = (t) => new Date(t).toLocaleTimeString('sv-SE');
const full = (t) => new Date(t).toLocaleString('sv-SE');
const dur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const brief = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

function analyze(ev) {
  const starts = ev.filter((e) => e.type === 'turn/start');
  const ends = ev.filter((e) => e.type === 'turn/end');
  const lastStart = starts[starts.length - 1];
  const lastEnd = ends[ends.length - 1];
  const openTurn = !!(lastStart && (!lastEnd || lastStart.seq > lastEnd.seq));
  const last = ev[ev.length - 1];

  // 本 turn 内的 step / tool 统计
  const turnNo = openTurn ? lastStart.data.turn : null;
  const inTurn = (e) => turnNo != null && e.data && e.data.turn === turnNo;
  const stepStarts = ev.filter((e) => e.type === 'step/start' && inTurn(e));
  const toolCalls = ev.filter((e) => e.type === 'tool/call' && inTurn(e));
  const visText = [];
  for (const e of ev) {
    if (e.type !== 'assistant/message' || !inTurn(e)) continue;
    for (const p of e.data.message?.content || []) {
      if (p.type === 'text' && p.text && p.text.trim()) visText.push({ t: e.time, len: p.text.length, head: brief(p.text, 70) });
    }
  }
  // 工具耗时 / 相邻 step 间隔
  const gaps = [];
  for (let k = 1; k < stepStarts.length; k++) gaps.push({ step: stepStarts[k].data.step, ms: stepStarts[k].time - stepStarts[k - 1].time });
  gaps.sort((a, b) => b.ms - a.ms);

  // 未结算的后台任务
  const reg = new Map();
  for (const e of ev) {
    if (e.type === 'job/registered') reg.set(e.data.jobId, e.time);
    if (e.type === 'job/settled') reg.delete(e.data.jobId);
  }
  const retries = ev.filter((e) => e.type === 'llm/retry');
  const lastErr = ends.length ? ends[ends.length - 1].data.reason : null;

  return { openTurn, turnNo, lastStart, lastEnd, last, stepStarts, toolCalls, visText, gaps, pending: [...reg.keys()], retries, lastErr, turns: starts.length };
}

function report(label, info, ev, tailN) {
  const a = analyze(ev);
  const now = Date.now();
  const idleMs = now - a.last.time;
  console.log('='.repeat(78));
  console.log(label);
  console.log(`  文件     ${info.file}`);
  console.log(`  体积     ${(info.bytes / 1048576).toFixed(2)} MB(压缩)  事件 ${ev.length}  坏帧 ${info.badFrames}  坏行 ${info.badLines}`);
  console.log(`  最后写盘 ${full(info.mtimeMs)}   最后事件 ${ts(a.last.time)}  (${dur(idleMs)} 前)  ${a.last.type} seq=${a.last.seq}`);
  console.log(`  turn     ${a.turns} 个;` + (a.openTurn
    ? ` ⏳ turn ${a.turnNo} 仍未结束(自 ${ts(a.lastStart.time)} 起 ${dur(now - a.lastStart.time)})`
    : ` ✅ 最后一个 turn 已结束 → ${JSON.stringify(a.lastErr).slice(0, 120)}`));
  if (a.openTurn) {
    console.log(`  本 turn  step ${a.stepStarts.length} 个, 工具调用 ${a.toolCalls.length} 次`);
    const names = {};
    for (const e of a.toolCalls) names[e.data.name] = (names[e.data.name] || 0) + 1;
    console.log(`  工具分布 ${JSON.stringify(names)}`);
    const slow = a.gaps.slice(0, 3).map((g) => `step${g.step}:${dur(g.ms)}`).join('  ');
    console.log(`  最长步间隔 ${slow || '-'}`);
    if (a.visText.length) {
      const v = a.visText[a.visText.length - 1];
      console.log(`  最后可见文字 ${ts(v.t)} (${dur(now - v.t)} 前, ${v.len} 字): ${JSON.stringify(v.head)}`);
    } else console.log('  最后可见文字 (本 turn 无可见输出，全是 reasoning + 工具调用)');
    console.log(`  LLM 重试 ${a.retries.filter((e) => e.type === 'llm/retry').length} 次`);
  }
  console.log(`  未结算后台任务 ${a.pending.length}${a.pending.length ? ' -> ' + a.pending.join(',') : ''}`);
  const verdict = !a.openTurn
    ? 'STOPPED  (turn 已收口，等新指令)'
    : idleMs > 300000 ? 'STALLED? (5 分钟无事件，可能真卡住)'
      : idleMs > 60000 ? 'SLOW    (1 分钟无事件，可能在长工具/长推理)'
        : 'RUNNING (事件在持续追加)';
  console.log(`  判定     ${verdict}`);
  if (tailN) {
    console.log(`  --- 末尾 ${tailN} 条事件 ---`);
    for (const e of ev.slice(-tailN)) {
      let extra = '';
      if (e.type === 'tool/call') {
        let arg = {};
        try { arg = JSON.parse(e.data.arguments); } catch { /* keep raw */ }
        extra = e.data.name + ' ' + brief(arg.command || arg.file_path || JSON.stringify(arg));
      } else if (e.type === 'tool/result') {
        extra = brief((e.data.message?.content || []).map((p) => p.text || '').join(' '));
      } else if (e.type === 'turn/end') {
        extra = JSON.stringify(e.data.reason);
      } else if (e.type === 'user/message') {
        extra = brief((e.data.content || []).map((p) => p.text || '').join(' '));
      } else if (e.type === 'step/start') {
        extra = `turn ${e.data.turn} step ${e.data.step}`;
      }
      console.log(`   ${String(e.seq).padStart(6)} ${ts(e.time)} ${e.type.padEnd(18)} ${extra}`);
    }
  }
}

function main() {
  const tailN = Number(argv('--events', 0)) || 0;
  const wantDir = argv('--dir', null);
  const wantSid = argv('--session', null);
  let targets = [];

  if (wantDir) targets = [{ proj: path.basename(wantDir), sid: path.basename(wantDir), file: path.join(wantDir, 'session.v4.jsonl.zstd') }];
  else if (wantSid) {
    targets = listSessions().filter((s) => s.sid === wantSid || s.sid.includes(wantSid) || s.proj.includes(wantSid));
  } else {
    // 默认：只挑出「有未完成 turn」的会话，按最后事件时间倒序显示前 6 个
    targets = listSessions()
      .map((s) => {
        try {
          const { events } = decodeSession(s.file);
          const a = analyze(events);
          return { ...s, openTurn: a.openTurn, lastTime: a.last.time, mtimeMs: events.length ? events[events.length - 1].time : 0 };
        } catch { return null; }
      })
      .filter(Boolean)
      .filter((s) => s.openTurn)
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, 6);
    if (!targets.length) { console.log('没有任何会话存在未完成的 turn。'); return; }
  }

  const run = () => {
    for (const t of targets) {
      try {
        const { events, ...info } = decodeSession(t.file);
        const { events: ev, ...rest } = { events, ...info };
        report(`[${t.proj}] ${t.sid}`, { ...rest, file: t.file }, ev, tailN);
      } catch (e) {
        console.log(`[${t.proj}] ${t.sid} 读取失败: ${e.message}`);
      }
    }
  };

  run();
  if (has('--watch')) {
    const every = Number(argv('--interval', 5)) * 1000;
    setInterval(() => { console.log('\n'.repeat(2)); run(); }, every);
  }
}

main();
