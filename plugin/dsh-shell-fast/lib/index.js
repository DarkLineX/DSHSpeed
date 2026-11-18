import { randomUUID } from 'node:crypto';

/**
 * A second, persistent shell tool that coexists with the stock cold-start `pwsh`.
 *
 * Registering this plugin mounts:
 *   - the owner-scoped PTY service (`@deepseek-ai/dsh-terminal`)
 *   - one PTY backend (`@deepseek-ai/dsh-terminal-bash` in pwsh dialect)
 *   - the model-facing tool below, whose name is configurable so it never
 *     collides with the built-in `pwsh`.
 *
 * The command protocol is the same marker-wrapped `Invoke-Expression` wrapper
 * the first-party persistent tool uses, so multi-line blocks, here-strings and
 * `$()` all ride one physical input line.
 */

const ROUTE_DESCRIPTION =
  'Run a command in a persistent PowerShell 7 shell. The shell keeps its current directory and environment across calls, '
  + 'so a follow-up call costs milliseconds instead of a fresh process start. This is PowerShell, not bash: use PowerShell '
  + 'syntax (Get-ChildItem, $env:NAME, @{ }, $(), if blocks). Prefer it over `pwsh` for short repeated status checks.';

const TRUNCATED_MESSAGE =
  '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with Select-String in order to find the line numbers of what you are looking for.</NOTE>';
const LOST_PREFIX_MESSAGE =
  '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n';
const SHELL_RESET_MESSAGE =
  'The persistent shell was reset; the next call starts from the workspace with a fresh current directory and environment.';
const SCROLLBACK_PAGE_LINES = 1e3;
const POLL_INTERVAL_MS = 25;

function maybeTruncate(content, maxOutputChars, incomplete = false) {
  if (content.length <= maxOutputChars && !incomplete) return content;
  if (content.length <= maxOutputChars) return content + TRUNCATED_MESSAGE;
  return content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function markers() {
  const nonce = randomUUID();
  return {
    start: `__DSH_FAST_START_${nonce}__`,
    end: `__DSH_FAST_END_${nonce}:`,
  };
}

function quoteForPwsh(value) {
  return value
    .replaceAll('`', '``')
    .replaceAll('"', '`"')
    .replaceAll('$', '`$')
    .replaceAll('\r', '')
    .replaceAll('\n', '`n')
    .replaceAll('\x1B', '`e');
}

function wrapCommand(command, marker) {
  const body = quoteForPwsh(command);
  return `Write-Output '${marker.start}'; $LASTEXITCODE = $null; $__s = 1; try { Invoke-Expression "${body}"; $__ok = $? } catch { $__ok = $false }; if ($null -ne $LASTEXITCODE) { $__s = [int]$LASTEXITCODE } else { $__s = if ($__ok) { 0 } else { 1 } }; Write-Output ('${marker.end}' + $__s)`;
}

function trimTrailingNewline(text) {
  return text.replace(/\r?\n$/, '');
}

function commandOutput(snapshot, marker, wrapper) {
  const text = snapshot.text;
  const end = text.lastIndexOf(marker.end);
  const status = /^(\d+) *\r?\n/.exec(text.slice(end + marker.end.length))?.[1];
  if (status === undefined) return undefined;
  const startMarker = text.lastIndexOf(marker.start, end);
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
  let captured = text.slice(start, end);
  captured = captured.replaceAll(wrapper, '');
  return {
    text: captured.replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  };
}

function partialOutput(snapshot, marker, wrapper, fallback, fallbackTruncated = false) {
  const startMarker = snapshot.text.lastIndexOf(marker.start);
  if (startMarker >= 0) {
    return {
      text: trimTrailingNewline(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, '')),
      incomplete: false,
    };
  }
  const fallbackStart = fallback.lastIndexOf(marker.start);
  const afterStart =
    fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, '');
  const fallbackEnd = afterStart.lastIndexOf(marker.end);
  return {
    text: trimTrailingNewline((fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)).replaceAll(wrapper, '')),
    incomplete: fallbackTruncated || fallbackStart < 0,
  };
}

function appendStatusMarker(content, marker) {
  if (marker === undefined) return content;
  return content.length === 0 ? marker : `${content}\n${marker}`;
}

function renderCaptured(output, maxOutputChars) {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete);
  return appendStatusMarker(
    output.incomplete && output.text.length > 0 ? LOST_PREFIX_MESSAGE + rendered : rendered,
    output.exitCode !== undefined && output.exitCode !== 0 ? `[exit code: ${output.exitCode}]` : undefined,
  );
}

function renderShellExitStatus(content, exitCode, signal) {
  return appendStatusMarker(
    content,
    signal !== null
      ? `[shell killed by signal: ${signal}]`
      : exitCode !== null
        ? `[shell exited: code ${exitCode}]`
        : '[shell exited]',
  );
}

function nextScrollbackOffset(page, offset) {
  if (page.text.length === 0 || page.lineEnd <= offset) return undefined;
  return page.lineEnd;
}

function retainedScrollback(ctx, owner, id, latest = ctx.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES })) {
  const pages = latest.text.length === 0 ? [] : [latest.text];
  let offset = latest.lineEnd;
  let truncated = latest.truncated;
  while (true) {
    if (offset >= latest.totalLines) break;
    const page = ctx.terminals.read(owner, id, { offset, count: SCROLLBACK_PAGE_LINES });
    truncated ||= page.truncated;
    if (page.text.length > 0) pages.unshift(page.text);
    const next = nextScrollbackOffset(page, offset);
    if (next === undefined || next >= page.totalLines) break;
    offset = next;
  }
  return { text: pages.join('\n'), truncated };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

async function respondToSessionExit(ctx, shells, owner, id, status, marker, wrapped, fallback, fallbackTruncated, config) {
  const snapshot = retainedScrollback(ctx, owner, id);
  await shells.reset(owner, 'persistent shell exited');
  return [
    renderShellExitStatus(
      renderCaptured(partialOutput(snapshot, marker, wrapped, fallback, fallbackTruncated), config.maxOutputChars),
      status.exitCode,
      status.signal,
    ),
    SHELL_RESET_MESSAGE,
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

function persistentShells(ctx, config) {
  const pending = new WeakMap();
  const live = new Map();
  const creating = new Set();
  const ownerCleanupInstalled = new WeakSet();
  const lifecycle = new AbortController();

  const close = async (owner, id, reason) => {
    if (!ctx.terminals.list(owner).some((snapshot) => snapshot.sessionId === id)) return;
    await ctx.terminals.kill(owner, id, reason);
  };

  ctx.effect(
    () => async () => {
      lifecycle.abort(new Error('shell-fast disposed during shell creation'));
      await Promise.allSettled([...creating]);
      await Promise.all([...live].map(async ([owner, id]) => close(owner, id, 'shell-fast disposed')));
      live.clear();
    },
    'shell-fast: shell cleanup',
  );

  const reset = async (owner, reason) => {
    pending.delete(owner);
    const id = live.get(owner);
    live.delete(owner);
    if (id !== undefined) await close(owner, id, reason);
  };

  const get = (owner, signal) => {
    const existing = pending.get(owner);
    if (existing !== undefined) return existing;
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal]);
    const tracked = (async () => {
      try {
        const cwd = await ctx.workingDirectory.ensure(owner, combinedSignal);
        const spawned = await ctx.terminals.spawn(owner, { type: config.backendType, cwd }, combinedSignal);
        live.set(owner, spawned.sessionId);
        if (!ownerCleanupInstalled.has(owner)) {
          ownerCleanupInstalled.add(owner);
          owner.ctx.effect(
            () => () => {
              pending.delete(owner);
              live.delete(owner);
            },
            'shell-fast: owner cache cleanup',
          );
        }
        return spawned.sessionId;
      } catch (error) {
        await reset(owner, 'persistent shell initialization failed');
        throw error;
      }
    })().finally(() => {
      creating.delete(tracked);
    });
    creating.add(tracked);
    pending.set(owner, tracked);
    return tracked;
  };

  return { get, reset };
}

async function executeCommand(ctx, shells, owner, command, config, upstream) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('persistent shell command timeout'));
  }, config.timeoutMs);
  const combined = AbortSignal.any([upstream, controller.signal]);
  try {
    let id;
    try {
      id = await shells.get(owner, combined);
    } catch (error) {
      if (upstream.aborted && error === upstream.reason) return '';
      throw error;
    }
    if (timedOut) return `Your command timed out after ${Math.round(config.timeoutMs / 1e3)} seconds.\n${SHELL_RESET_MESSAGE}`;

    const marker = markers();
    const wrapped = wrapCommand(command, marker);
    let first = true;
    let fallback = '';
    let fallbackTruncated = false;

    while (true) {
      const status = ctx.terminals.list(owner).find((session) => session.sessionId === id)?.status;
      if (status?.kind === 'exited') {
        return await respondToSessionExit(ctx, shells, owner, id, status, marker, wrapped, fallback, fallbackTruncated, config);
      }

      let operation;
      let result;
      try {
        operation = ctx.terminals.startSend(owner, id, { text: first ? wrapped : '', submit: first, signal: combined });
        first = false;
        result = await operation.done;
      } catch (error) {
        await shells.reset(owner, 'persistent shell send failed');
        throw error;
      }

      const incremental = operation.readOutput();
      fallback = incremental.delta.length > 0 ? fallback + incremental.delta : result.viewport;
      fallbackTruncated ||= incremental.truncated || result.truncated;

      const latest = ctx.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES });

      if (timedOut) {
        const partial = renderCaptured(
          partialOutput(retainedScrollback(ctx, owner, id, latest), marker, wrapped, fallback, fallbackTruncated),
          config.maxOutputChars,
        );
        await shells.reset(owner, 'persistent shell command timed out');
        return [
          `Your command timed out after ${Math.round(config.timeoutMs / 1e3)} seconds. Below is partial output:`,
          partial,
          SHELL_RESET_MESSAGE,
        ].join('\n');
      }
      if (upstream.aborted) {
        await shells.reset(owner, 'persistent shell command aborted');
        return '';
      }
      if (latest.text.includes(marker.end)) {
        const complete = commandOutput(retainedScrollback(ctx, owner, id, latest), marker, wrapped);
        if (complete !== undefined) return renderCaptured(complete, config.maxOutputChars);
      }
      if (result.sessionStatus.kind === 'exited') {
        return await respondToSessionExit(ctx, shells, owner, id, result.sessionStatus, marker, wrapped, fallback, fallbackTruncated, config);
      }
      if (result.waitReason === 'stdin_read') {
        return renderCaptured(
          partialOutput(retainedScrollback(ctx, owner, id, latest), marker, wrapped, fallback, fallbackTruncated),
          config.maxOutputChars,
        );
      }
      await pause();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** @param ctx - plugin context carrying tools, the PTY service and the working directory. */
function apply(ctx, config = {}) {
  const toolName = config.toolName ?? 'pws';
  const backendType = config.backendType ?? 'shellfast';
  const timeoutMs = config.timeoutMs ?? 3e5;
  const maxOutputChars = config.maxOutputChars ?? 16e3;
  const description = config.description ?? ROUTE_DESCRIPTION;

  if (typeof toolName !== 'string' || toolName.trim().length === 0) throw new Error('shell-fast: toolName must be a non-empty string');
  if (typeof backendType !== 'string' || backendType.trim().length === 0) throw new Error('shell-fast: backendType must be a non-empty string');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('shell-fast: timeoutMs must be a positive safe integer');
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) throw new Error('shell-fast: maxOutputChars must be a positive safe integer');

  const resolved = { toolName, backendType, timeoutMs, maxOutputChars, description };
  const shells = persistentShells(ctx, resolved);
  const queues = new WeakMap();

  const serialized = async (owner, operation) => {
    const run = (queues.get(owner) ?? Promise.resolve()).then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(owner, tail);
    try {
      return await run;
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner);
    }
  };

  const disposer = ctx.tools.register({
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The PowerShell command to run. Relative paths are preferred; the working directory persists between calls.',
        },
      },
      required: ['command'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('command must be a non-empty string');
      }
      const owner = exec.agent;
      if (owner === undefined) throw new Error(`${toolName} requires an owning agent session`);
      return serialized(owner, async () => {
        if (exec.signal.aborted) return '';
        return executeCommand(ctx, shells, owner, args.command, resolved, exec.signal);
      });
    },
    presentCall: (args) => ({ card: 'terminal', title: args.command }),
  });

  ctx.effect(() => disposer, 'shell-fast: tool registration');
}

const name = 'shell-fast';
const inject = ['tools', 'terminals', 'workingDirectory'];

export { apply, inject, name };
