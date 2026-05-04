// Shell tool executor — runs the agent's `run_command` tool_uses via
// Node's `child_process.spawn` with `shell: true` so OS-level shell
// features (pipes, redirects, &&) work as the agent expects.
//
// Output handling:
//  • stdout + stderr are interleaved into a single buffer with a tag
//    prefix on each block, so the agent can tell which stream produced
//    what without us having to fabricate two separate fields.
//  • Total captured output is truncated to OUTPUT_BYTE_CAP. We keep
//    the TAIL of the output (build/test logs are most informative at
//    the end), with a "[truncated N bytes]" header marking what was
//    dropped.
//
// Scope:
//  • Cwd defaults to the workspace folder when set, otherwise the
//    user's home directory. The loop driver decides whether to gate
//    based on cwd-vs-workspace; this executor just runs what it's
//    told.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ShellToolAction } from '@shared/schemas';
import { getSettings } from '@main/storage/settings-store';

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_BYTE_CAP = 16 * 1024;

export type ShellExecuteResult =
  | { ok: true; output: string; exitCode: number }
  | { ok: false; error: string; output?: string; exitCode?: number };

/** Resolve the effective cwd for a shell command. Explicit cwd wins;
 *  workspace folder is the next-best default; OS home dir is the
 *  ultimate fallback. The returned path is absolute, normalised, AND
 *  realpath-resolved (when the path exists) so the IPC scope check —
 *  which canonicalises the workspace via realpath — compares apples to
 *  apples. Without this, a symlinked workspace + symlinked cwd could
 *  disagree on whether they point to the same place. realpathSync is
 *  fine here: cwd resolution happens once per shell invocation and the
 *  paths are trivially short. */
export function resolveShellCwd(cwd: string | undefined): string {
  let resolved: string;
  if (cwd && cwd.trim().length > 0) {
    resolved = path.resolve(cwd);
  } else {
    const ws = getSettings().agentWorkspaceFolder;
    resolved = ws ? path.resolve(ws) : homedir();
  }
  try {
    return realpathSync(resolved);
  } catch {
    // Path doesn't exist yet (rare for cwd) — fall back to the
    // normalised form so spawn surfaces the real ENOENT.
    return resolved;
  }
}

/** Execute a `run_command` action. Captures stdout + stderr,
 *  truncates the tail to OUTPUT_BYTE_CAP, kills on timeout, and
 *  returns a structured result the loop driver can ship back as the
 *  tool_result text. */
export async function executeShellAction(
  action: ShellToolAction,
): Promise<ShellExecuteResult> {
  if (action.action !== 'run_command') {
    return { ok: false, error: `Unknown shell action: ${(action as { action: string }).action}` };
  }
  const cwd = resolveShellCwd(action.cwd);
  const timeoutMs = action.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Tagged chunks: stdout / stderr interleave preserves order so logs
  // reading "compile error then traceback" still make sense to the
  // agent. Each chunk header starts on its own line.
  const chunks: string[] = [];
  let totalBytes = 0;
  let droppedBytes = 0;

  const pushChunk = (tag: 'out' | 'err', s: string) => {
    if (!s) return;
    const formatted = tag === 'out' ? s : `\n[stderr] ${s.replace(/\n/g, '\n[stderr] ')}\n`;
    const len = Buffer.byteLength(formatted, 'utf8');
    chunks.push(formatted);
    totalBytes += len;
  };

  return new Promise<ShellExecuteResult>((resolve) => {
    let done = false;
    const finish = (result: ShellExecuteResult): void => {
      if (done) return;
      done = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(action.command, {
        cwd,
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      finish({
        ok: false,
        error: `Failed to spawn shell: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      // Graceful kill: SIGTERM first so the child can flush + clean
      // up, then SIGKILL after 500ms if still alive. Without the
      // grace window we leave zombie children (e.g. orphaned node
      // processes started by `npm test`). On Windows, child.kill()
      // already does best-effort tree kill via taskkill so the
      // signal name doesn't matter much there; on Unix the
      // distinction is real.
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 500);
      finish({
        ok: false,
        error: `Command timed out after ${timeoutMs}ms.`,
        output: assembleOutput(chunks, totalBytes, droppedBytes),
      });
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      pushChunk('out', data.toString('utf8'));
    });
    child.stderr?.on('data', (data: Buffer) => {
      pushChunk('err', data.toString('utf8'));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `Shell error: ${err.message}`,
        output: assembleOutput(chunks, totalBytes, droppedBytes),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = assembleOutput(chunks, totalBytes, droppedBytes);
      const exitCode = typeof code === 'number' ? code : -1;
      if (exitCode === 0) {
        finish({ ok: true, output, exitCode });
      } else {
        finish({
          ok: false,
          error: `Command exited with code ${exitCode}.`,
          output,
          exitCode,
        });
      }
    });
  });
}

/** Glue chunks into one string. If the total exceeds the cap, keep
 *  BOTH head and tail with a marker between them. The tail-only
 *  scheme lost early errors (e.g. "module not found" preamble that
 *  cascaded into thousands of lines of follow-on tracebacks); a
 *  head + tail split keeps both the originating diagnostic and the
 *  final state visible to the agent. */
function assembleOutput(
  chunks: string[],
  totalBytes: number,
  _droppedBytesIgnored: number,
): string {
  const joined = chunks.join('');
  if (totalBytes <= OUTPUT_BYTE_CAP) {
    return joined.trim();
  }
  // Half the cap to head, half to tail, leaving a tiny margin for the
  // separator marker. 8KB + 8KB fits under the 16KB cap.
  const sliceBytes = Math.floor(OUTPUT_BYTE_CAP / 2) - 64;
  const headBuf = Buffer.from(joined, 'utf8').subarray(0, sliceBytes);
  const tailBuf = Buffer.from(joined, 'utf8').subarray(
    Math.max(0, Buffer.byteLength(joined, 'utf8') - sliceBytes),
  );
  const head = headBuf.toString('utf8');
  const tail = tailBuf.toString('utf8');
  const dropped = totalBytes - headBuf.length - tailBuf.length;
  return `${head}\n... [truncated ${dropped} bytes] ...\n${tail}`.trim();
}

/** Human-readable description of a shell action for UI display. The
 *  audit log + run timeline both render this above the per-action
 *  approval gate so the user knows what they're approving. */
export function describeShellAction(a: ShellToolAction): string {
  if (a.action === 'run_command') {
    const cmd = a.command.length > 80 ? a.command.slice(0, 77) + '…' : a.command;
    const cwdSuffix = a.cwd ? ` (cwd: ${a.cwd})` : '';
    return `Run: ${cmd}${cwdSuffix}`;
  }
  return 'Shell action';
}
