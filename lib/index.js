/**
 * dsh-speed-audit 鈥?host half.
 *
 * Time attribution for the harness's own work: every step, every model round
 * trip, and every tool call is folded into phase buckets so you can see where
 * wall-clock actually goes.
 *
 * The interesting question this answers is not "how long did it take" but
 * "how much of it was the model, how much was a tool, and how much was me
 * waiting for the first token". `sessionStats` already reports the totals; this
 * reports the shape.
 *
 * Two data paths, one fold:
 *   - live: subscribe to `session/event` for every session in memory
 *   - replay: read the authoritative JSONL log on demand (`session.v*.jsonl.zstd`)
 *
 * No timers on disk, no log scraping in the hot path. Replay only runs when a
 * client asks for a session that has no live state.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Stable cordis plugin name. */
const name = 'speed-audit';

/** Services required before the route can mount. */
const inject = ['webServer', 'sessions'];

const ROUTE = {
  snapshot: '/api/dsh-speed-audit/snapshot',
  sessions: '/api/dsh-speed-audit/sessions',
  audit: '/api/dsh-speed-audit/audit',
};

/** Live sessions kept in memory before the oldest is evicted. */
const MAX_TRACKED_SESSIONS = 64;

/** Magic bytes of a zstd frame; session logs are multi-frame. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * A session log is a concatenation of independently framed zstd chunks.
 * A single `zstdDecompressSync` returns only the first frame (the session
 * header), so every magic offset has to be spliced out and decoded on its own.
 *
 * @param {string} file - absolute path to `session.v*.jsonl.zstd`.
 * @returns {any[]} decoded JSONL records.
 */
function decodeSessionLog(file) {
  const raw = fs.readFileSync(file);
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const at = raw.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    offsets.push(at);
    cursor = at + 1;
  }
  const parts = offsets.map((start, i) => {
    const frame = raw.subarray(start, offsets[i + 1] ?? raw.length);
    try {
      return zlib.zstdDecompressSync(frame);
    } catch {
      return Buffer.alloc(0);
    }
  });
  return Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Newest `session.v*.jsonl.zstd` under one session directory, or null. */
function newestLog(sessionDir) {
  let best = null;
  let bestVersion = -1;
  let entries;
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(entry);
    if (!m) continue;
    const version = Number(m[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = path.join(sessionDir, entry);
    }
  }
  return best;
}

/** Empty phase accumulator. */
function emptyPhases() {
  return { ttft: 0, reasoning: 0, text: 0, toolArgs: 0, other: 0 };
}

/** Empty fold state for one session. */
function emptyState(id, cwd) {
  return {
    id,
    cwd,
    provider: null,
    model: null,
    reasoningEffort: null,
    turn: null,
    step: null,
    turnOpen: false,
    stepOpen: false,
    lastType: null,
    lastAt: 0,
    stepCount: 0,
    assistantSteps: 0,
    toolCount: 0,
    openTools: new Map(),
    llmWallMs: 0,
    toolWallMs: 0,
    stepWallMs: 0,
    stepGapMs: 0,
    phases: emptyPhases(),
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    zeroStreamSteps: 0,
    visibleSteps: 0,
    toolByName: new Map(),
    toolDurations: [],
    retries: 0,
    retryDelayMs: 0,
    compactionCount: 0,
    compactionMs: 0,
    compactionErrors: 0,
    turns: [],
    turnStartedAt: null,
    firstTextAt: null,
    turnFirstTextMs: null,
    /**
     * When the model last delivered prose. The live strip answers "how long
     * since I saw anything", which `lastAt` cannot: tool events move `lastAt`
     * every few seconds while the answer stays silent for minutes.
     */
    lastTextAt: null,
    lastTool: null,
    /** @type {null | {start:number, ttft:number, gen:number, toolMs:number, pending:Map<string,number>, blockIndexes:Set<number>}} */
    stepFold: null,
  };
}

/** Sum a `dt` array. */
function sumDt(list) {
  let total = 0;
  for (const dt of list ?? []) total += dt;
  return total;
}

/**
 * Split one `assistant/message.stream` into its block-level time buckets.
 *
 * `block-start` chunks carry the absolute time each block opened; the matching
 * `*-chunks` rows carry per-token deltas. `time0` on those rows is a copy of the
 * request start and must not be used as a duration.
 *
 * @param {any[]} stream
 * @param {number} stepStart
 * @param {number} messageAt
 */
function decomposeStream(stream, stepStart, messageAt) {
  const starts = stream.filter((x) => x?.type === 'chunk' && x.chunk?.type === 'block-start');
  const ttft = (starts[0]?.time ?? messageAt) - stepStart;
  const phases = emptyPhases();
  for (const start of starts) {
    const index = start.chunk.index;
    const kind = start.chunk.blockType;
    let total = 0;
    for (const item of stream) {
      if (item?.index !== index) continue;
      total += sumDt(item.dt);
    }
    if (kind === 'reasoning') phases.reasoning += total;
    else if (kind === 'text') phases.text += total;
    else if (kind === 'tool-call') phases.toolArgs += total;
    else phases.other += total;
  }
  return { ttft, phases, blocks: starts.length };
}

/**
 * The single most identifying line of a tool's arguments.
 *
 * A live strip cannot show a whole `pwsh` command, and the tool name alone
 * ("pwsh") says nothing about whether the run is a build or a status ping. The
 * first non-empty line of `command`/`prompt`/`description`, trimmed to 90
 * characters, is the most information per pixel available at this layer.
 *
 * @param {string} rawArguments - the tool call's JSON argument string.
 * @returns {string|null} a one-line hint, or null when there is nothing useful.
 */
function commandHint(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate = [parsed.description, parsed.command, parsed.prompt, parsed.file_path, parsed.pattern]
    .find((v) => typeof v === 'string' && v.trim() !== '');
  if (candidate === undefined) return null;
  const firstLine = candidate.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (firstLine === undefined) return null;
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

/** Record one finished tool call into the per-session histogram. */
function recordTool(st, toolName, durationMs) {  const bucket = st.toolByName.get(toolName) ?? { calls: 0, totalMs: 0, maxMs: 0 };
  bucket.calls += 1;
  bucket.totalMs += durationMs;
  bucket.maxMs = Math.max(bucket.maxMs, durationMs);
  st.toolByName.set(toolName, bucket);
  st.toolDurations.push({ name: toolName, ms: durationMs });
  if (st.toolDurations.length > 4000) st.toolDurations.shift();
}

/**
 * Fold one session event into the state record.
 *
 * The event's own `time` is authoritative. Live events carry it too, so using
 * it everywhere keeps a live fold and a log replay numerically identical 鈥? * mixing `Date.now()` into a replay would interpolate two different clocks.
 *
 * @param {any} st - mutable state.
 * @param {any} event - session event.
 * @param {number} at - arrival time in ms; used only when the event has none.
 */
function applyEvent(st, event, at) {
  const type = event?.type;
  const data = event?.data ?? {};
  const when = typeof event?.time === 'number' ? event.time : at;
  st.lastType = type ?? null;
  st.lastAt = when;

  switch (type) {
    case 'request/header': {
      const cfg = data.header?.config;
      if (cfg) {
        st.provider = cfg.provider ?? st.provider;
        st.model = cfg.model ?? st.model;
        st.reasoningEffort = cfg.reasoningEffort ?? st.reasoningEffort;
      }
      break;
    }
    case 'model/selection': {
      st.provider = data.provider ?? st.provider;
      st.model = data.model ?? st.model;
      st.reasoningEffort = data.reasoningEffort ?? st.reasoningEffort;
      break;
    }
    case 'turn/start': {
      st.turn = data.turn ?? st.turn;
      st.turnOpen = true;
      st.stepOpen = false;
      st.turnStartedAt = when;
      st.turnFirstTextMs = null;
      st.openTools.clear();
      break;
    }
    case 'turn/end': {
      st.turn = data.turn ?? st.turn;
      st.turnOpen = false;
      st.stepOpen = false;
      st.openTools.clear();
      if (st.turnStartedAt !== null) {
        st.turns.push({
          turn: st.turn,
          wallMs: when - st.turnStartedAt,
          firstTextMs: st.turnFirstTextMs,
        });
        if (st.turns.length > 400) st.turns.shift();
      }
      st.turnStartedAt = null;
      st.stepFold = null;
      break;
    }
    case 'step/start': {
      if (st.stepFold && st.stepFold.start) {
        st.stepGapMs += Math.max(0, when - (st.stepFold.endedAt ?? st.stepFold.start));
      }
      st.step = data.step ?? st.step;
      st.stepOpen = true;
      st.stepCount += 1;
      st.stepFold = {
        start: when,
        endedAt: null,
        ttft: 0,
        gen: 0,
        toolMs: 0,
        pending: new Map(),
        gotMessage: false,
      };
      break;
    }
    case 'step/end': {
      st.step = data.step ?? st.step;
      st.stepOpen = false;
      const fold = st.stepFold;
      if (fold) {
        fold.endedAt = when;
        st.stepWallMs += when - fold.start;
      }
      st.stepFold = null;
      break;
    }
    case 'tool/call': {
      const callId = data.callId ?? `anon-${when}`;
      const args = typeof data.arguments === 'string' ? data.arguments : '';
      st.openTools.set(callId, { name: data.name ?? '?', at: when, args: data.arguments });
      st.toolCount += 1;
      // The strip names the newest tool even after it settles, so a viewer who
      // looks up mid-stream sees what the last visible action was.
      st.lastTool = {
        name: data.name ?? '?',
        startedAt: when,
        endedAt: null,
        command: commandHint(args),
      };
      if (st.stepFold) st.stepFold.pending.set(callId, when);
      break;
    }
    case 'tool/result': {
      const callId =
        data?.message?.toolCallId ?? data?.message?.source?.callId ?? data?.toolCallId;
      const open = st.openTools.get(callId);
      if (open) {
        const duration = when - open.at;
        recordTool(st, open.name, duration);
        st.toolWallMs += duration;
        st.openTools.delete(callId);
        if (st.lastTool !== null && st.lastTool.endedAt === null) {
          st.lastTool.endedAt = when;
          st.lastTool.durationMs = duration;
        }
        if (st.stepFold) {
          const startedAt = st.stepFold.pending.get(callId);
          if (startedAt !== undefined) {
            st.stepFold.toolMs += when - startedAt;
            st.stepFold.pending.delete(callId);
          }
        }
      }
      break;
    }
    case 'assistant/message': {
      st.step = data.step ?? st.step;
      st.turn = data.turn ?? st.turn;
      st.assistantSteps += 1;
      const usage = data.usage ?? {};
      st.outputTokens += usage.outputTokens || 0;
      st.inputTokens += usage.inputTokens || 0;
      st.cacheReadTokens += usage.cacheReadTokens || 0;

      const content = data.message?.content ?? [];
      const hasText = content.some((c) => c.type === 'text' && String(c.text ?? '').trim() !== '');
      if (hasText) {
        st.visibleSteps += 1;
        st.lastTextAt = when;
        if (st.turnFirstTextMs === null && st.turnStartedAt !== null) {
          st.turnFirstTextMs = when - st.turnStartedAt;
        }
      }

      const fold = st.stepFold;
      if (fold) {
        const { ttft, phases, blocks } = decomposeStream(
          Array.isArray(data.stream) ? data.stream : [],
          fold.start,
          when,
        );
        fold.ttft = ttft;
        fold.gen = phases.reasoning + phases.text + phases.toolArgs + phases.other;
        fold.gotMessage = true;
        st.llmWallMs += fold.ttft + fold.gen;
        st.phases.ttft += ttft;
        st.phases.reasoning += phases.reasoning;
        st.phases.text += phases.text;
        st.phases.toolArgs += phases.toolArgs;
        st.phases.other += phases.other;
        if (blocks === 0) st.zeroStreamSteps += 1;
      }
      break;
    }
    case 'llm/retry': {
      st.retries += 1;
      st.retryDelayMs += data.delayMs ?? 0;
      break;
    }
    case 'compaction/start': {
      st.compactionCount += 1;
      break;
    }
    case 'compaction/end': {
      if (data.error) st.compactionErrors += 1;
      break;
    }
    default:
      break;
  }
}

/** Derive the phase label the UI shows. */
function phaseOf(st) {
  if (st.openTools.size > 0) return 'tool';
  if (st.stepOpen) return 'model';
  if (st.turnOpen) return 'turn';
  return 'idle';
}

/** Round a histogram for the wire. */
function histogram(st) {
  return [...st.toolByName.entries()]
    .map(([toolName, b]) => ({
      name: toolName,
      calls: b.calls,
      totalMs: Math.round(b.totalMs),
      maxMs: Math.round(b.maxMs),
      avgMs: Math.round(b.totalMs / b.calls),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Bucket tool durations the way the report does. */
function latencyBuckets(durations) {
  const edges = [
    ['<1s', (ms) => ms < 1000],
    ['1-5s', (ms) => ms >= 1000 && ms < 5000],
    ['5-15s', (ms) => ms >= 5000 && ms < 15000],
    ['15-60s', (ms) => ms >= 15000 && ms < 60000],
    ['1-5min', (ms) => ms >= 60000 && ms < 300000],
    ['5-15min', (ms) => ms >= 300000 && ms < 900000],
    ['15min+', (ms) => ms >= 900000],
  ];
  return edges.map(([label, test]) => {
    const hit = durations.filter((d) => test(d));
    return {
      label,
      calls: hit.length,
      totalMs: Math.round(hit.reduce((a, b) => a + b, 0)),
    };
  });
}

/** Serialize one session for the wire. */
function serialize(st, now, opts = {}) {
  const openTools = [...st.openTools.entries()].map(([callId, t]) => ({
    callId,
    name: t.name,
    ageMs: Math.max(0, now - t.at),
    args: typeof t.args === 'string' ? t.args.slice(0, 240) : undefined,
  }));

  const modelMs = st.llmWallMs;
  const toolMs = st.toolWallMs;
  const total = st.stepWallMs || modelMs + toolMs;
  const silentMs = st.lastAt === 0 ? null : Math.max(0, now - st.lastAt);

  const durations = st.toolDurations.map((d) => d.ms);
  const sorted = [...durations].sort((a, b) => a - b);
  const quantile = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

  // Ages let a live indicator say "this step has been running 43s" instead of
  // only "no event for 3s" — the two answer different questions.
  const stepAgeMs = st.stepOpen && st.stepFold?.start ? Math.max(0, now - st.stepFold.start) : null;
  const turnAgeMs = st.turnOpen && st.turnStartedAt !== null ? Math.max(0, now - st.turnStartedAt) : null;
  const textAgeMs = st.lastTextAt === null ? null : Math.max(0, now - st.lastTextAt);
  const lastTool = st.lastTool === null
    ? null
    : {
        name: st.lastTool.name,
        command: st.lastTool.command,
        open: st.lastTool.endedAt === null,
        ageMs: Math.max(0, now - st.lastTool.startedAt),
        durationMs: st.lastTool.durationMs ?? null,
      };

  const payload = {
    id: st.id,
    cwd: st.cwd,
    phase: phaseOf(st),
    turn: st.turn,
    step: st.step,
    turnOpen: st.turnOpen,
    stepOpen: st.stepOpen,
    lastType: st.lastType,
    silentMs,
    stepAgeMs,
    turnAgeMs,
    textAgeMs,
    lastTool,
    openTools,
    provider: st.provider,
    model: st.model,
    reasoningEffort: st.reasoningEffort,
    counts: {
      steps: st.stepCount,
      assistantSteps: st.assistantSteps,
      tools: st.toolCount,
      visibleSteps: st.visibleSteps,
      zeroStreamSteps: st.zeroStreamSteps,
      retries: st.retries,
      compactions: st.compactionCount,
      compactionErrors: st.compactionErrors,
    },
    ms: {
      stepWall: Math.round(st.stepWallMs),
      stepGap: Math.round(st.stepGapMs),
      model: Math.round(modelMs),
      tool: Math.round(toolMs),
      llm: {
        ttft: Math.round(st.phases.ttft),
        reasoning: Math.round(st.phases.reasoning),
        text: Math.round(st.phases.text),
        toolArgs: Math.round(st.phases.toolArgs),
        other: Math.round(st.phases.other),
      },
      retryDelay: Math.round(st.retryDelayMs),
    },
    share: {
      model: total ? modelMs / total : 0,
      tool: total ? toolMs / total : 0,
      host: total ? Math.max(0, total - modelMs - toolMs) / total : 0,
      ttftOfModel: modelMs ? st.phases.ttft / modelMs : 0,
      reasoningOfModel: modelMs ? st.phases.reasoning / modelMs : 0,
      toolArgsOfModel: modelMs ? st.phases.toolArgs / modelMs : 0,
      textOfModel: modelMs ? st.phases.text / modelMs : 0,
    },
    tokens: {
      input: st.inputTokens,
      cacheRead: st.cacheReadTokens,
      output: st.outputTokens,
      outputPerSec: (() => {
        const gen = st.phases.reasoning + st.phases.text + st.phases.toolArgs;
        return gen > 0 ? (st.outputTokens / (gen / 1000)) : 0;
      })(),
    },
    tools: histogram(st),
    toolLatency: {
      p50: quantile(0.5),
      p90: quantile(0.9),
      p99: quantile(0.99),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      buckets: latencyBuckets(durations),
    },
    turns: st.turns.slice(-60),
    verdict: verdictOf(st, silentMs),
  };

  if (opts.detail) {
    payload.recentTools = st.toolDurations.slice(-200);
  }
  if (opts.light) {
    // The composer strip re-reads this once a second and renders six numbers.
    // Histograms and 60-turn tails would be pure overhead on that path.
    payload.tools = [];
    payload.toolLatency = null;
    payload.turns = [];
  }
  return payload;
}

/** Human-readable verdict for the panel badge. */
function verdictOf(st, silentMs) {
  if (st.openTools.size > 0) {
    const longest = Math.max(...[...st.openTools.values()].map((t) => Date.now() - t.at));
    return longest > 120000 ? 'hung-in-tool' : 'running-tool';
  }
  if (!st.turnOpen && !st.stepOpen) return 'idle';
  if (silentMs === null) return 'unknown';
  if (silentMs < 10000) return 'running';
  if (silentMs < 60000) return 'slow';
  return 'suspected-stall';
}

/** JSON reply helper. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Loopback-or-paired fence, same rule the shipped plugin family uses. */
function isAllowed(ctx, req) {
  const addr = req.socket?.remoteAddress;
  const loopback =
    addr === undefined
      ? false
      : addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
  if (loopback) {
    const host = String(req.headers?.host ?? '');
    const hostOk =
      host === '' ||
      /^(localhost|127\.|\[::1\])/.test(host) ||
      host.startsWith('[::ffff:127.');
    if (hostOk) return true;
  }
  try {
    const pairing = ctx.get?.('remoteWebUiPairing', false) ?? ctx.remoteWebUiPairing;
    return pairing?.isPairedDevice?.(req) === true;
  } catch {
    return false;
  }
}

/** Root directory holding every session log, escaped-cwd subdirectories included. */
function sessionsRoot(ctx) {
  try {
    const home = ctx.sessions?.rootDir ?? ctx.homePaths?.home ?? null;
    if (typeof home === 'string') return home;
  } catch {
    /* fall through */
  }
  const env = process.env.DSH_HOME;
  if (env) return path.join(env, 'sessions');
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(userHome, '.dsh', 'sessions');
}

/**
 * Enumerate every session log under the sessions root.
 *
 * The layout is `<escaped-cwd>/<session-id>/session.v<N>.jsonl.zstd`, so each
 * cwd directory has to be walked one level further than it looks.
 *
 * @param {string} root
 * @returns {{dir:string,file:string,bytes:number,modifiedAt:number}[]}
 */
function enumerateLogs(root) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dirPath = path.join(workspacePath, session.name);
      const log = newestLog(dirPath);
      if (!log) continue;
      let stat;
      try {
        stat = fs.statSync(log);
      } catch {
        continue;
      }
      out.push({
        dir: `${workspace.name}/${session.name}`,
        file: log,
        bytes: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

/** Replay one log file into a fresh state record. */
function replayLog(file, id, cwd) {
  const st = emptyState(id, cwd);
  let records;
  try {
    records = decodeSessionLog(file);
  } catch {
    return st;
  }
  for (const record of records) {
    if (record.type === 'session') continue;
    applyEvent(st, record, record.time ?? 0);
  }
  return st;
}

/**
 * Mount the routes and the session-event subscription.
 * @param {any} ctx - host plugin context.
 */
function apply(ctx) {
  /** @type {Map<string, any>} */
  const states = new Map();

  const adopt = (session) => {
    if (!states.has(session.id)) {
      states.set(session.id, emptyState(session.id, session.header?.cwd));
    }
    return states.get(session.id);
  };

  ctx.effect(() => {
    for (const session of ctx.sessions.list()) adopt(session);
    const disposers = [
      ctx.on('session/created', (session) => adopt(session)),
      ctx.on('session/event', (session, event) => {
        const st = adopt(session);
        applyEvent(st, event, Date.now());
        if (states.size > MAX_TRACKED_SESSIONS) {
          const oldest = [...states.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
          if (oldest) states.delete(oldest.id);
        }
      }),
    ];
    return () => {
      for (const d of disposers) d();
    };
  }, 'speed-audit: session tracking');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE.snapshot,
        handler: async (req, res) => {
          if (!isAllowed(ctx, req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' });
            return;
          }
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` });
            return;
          }
          const now = Date.now();
          // The composer strip polls once a second and only ever shows the
          // session it is mounted in, so it asks for that one in light mode.
          // Sending every session's full histogram at that rate would cost more
          // than the whole feature is worth.
          let url;
          try {
            url = new URL(req.url ?? '/', 'http://localhost');
          } catch {
            url = null;
          }
          const onlyId = url?.searchParams.get('id') ?? null;
          const light = url?.searchParams.get('light') === '1';

          // The browser half knows the session as whatever id the client layer
          // uses, which is not guaranteed to be byte-identical to the host's
          // (a bare uuid versus `session-<uuid>`). Match on identity first and
          // fall back to containment so the strip never silently shows nothing.
          const resolveId = (wanted) => {
            if (wanted === null) return null;
            if (states.has(wanted)) return wanted;
            for (const known of states.keys()) {
              if (known === wanted || known.endsWith(wanted) || wanted.endsWith(known)) return known;
            }
            return undefined;
          };
          const matchedId = resolveId(onlyId);

          if (onlyId !== null && matchedId === undefined) {
            writeJson(res, 200, { now, sessions: [] });
            return;
          }

          const picked =
            matchedId === null ? [...states.values()] : [states.get(matchedId)];

          const sessions = picked
            .sort((a, b) => b.lastAt - a.lastAt)
            .map((st) => serialize(st, now, light ? { light: true } : undefined));
          writeJson(res, 200, { now, sessions });
        },
      }),
    'speed-audit: snapshot route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE.sessions,
        handler: async (req, res) => {
          if (!isAllowed(ctx, req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' });
            return;
          }
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` });
            return;
          }
          const root = sessionsRoot(ctx);
          writeJson(res, 200, { root, sessions: enumerateLogs(root) });
        },
      }),
    'speed-audit: sessions route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE.audit,
        handler: async (req, res) => {
          if (!isAllowed(ctx, req)) {
            writeJson(res, 403, { error: 'forbidden: loopback-only' });
            return;
          }
          if (req.method !== 'GET') {
            writeJson(res, 405, { error: `method not allowed: ${req.method}` });
            return;
          }
          const url = new URL(req.url ?? '/', 'http://localhost');
          const file = url.searchParams.get('file');
          if (!file) {
            writeJson(res, 400, { error: 'missing ?file=' });
            return;
          }
          const root = sessionsRoot(ctx);
          const resolved = path.resolve(file);
          if (!resolved.startsWith(path.resolve(root))) {
            writeJson(res, 403, { error: 'file must live under the sessions root' });
            return;
          }
          if (!/session\.v\d+\.jsonl\.zstd$/.test(resolved)) {
            writeJson(res, 400, { error: 'not a session log' });
            return;
          }
          const st = replayLog(resolved, path.basename(path.dirname(resolved)), undefined);
          writeJson(res, 200, {
            now: Date.now(),
            root,
            file: resolved,
            session: serialize(st, Date.now(), { detail: true }),
          });
        },
      }),
    'speed-audit: audit route',
  );
}

export { apply, inject, name, ROUTE };
