// File-system tool executor — Node fs operations driven by the agent's
// `list_directory` / `read_file` / `search_files` / `write_file` tool_uses.
//
// Two safeguards live here:
//
// 1. Path resolution: every input path is run through `path.resolve()` AND
//    `fs.realpath()` (when the target exists) before any operation. Symlink
//    escapes get caught at the realpath step.
//
// 2. Read size cap: `read_file` rejects anything over READ_BYTE_CAP. Stops
//    the model from inhaling a multi-gig log into context.
//
// Scope checking lives in the loop driver, NOT here — the executor will run
// any path it's given. The loop is responsible for asking the user before
// dispatching out-of-scope actions.

import { readFile, readdir, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileToolAction } from '@shared/schemas';

const READ_BYTE_CAP = 100_000;
const SEARCH_RESULT_CAP = 200;
const SEARCH_DEPTH_CAP = 8;
const LIST_ENTRY_CAP = 500;

export type FileExecuteResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

/** Resolve a user-supplied path to its canonical absolute form. If the
 *  target doesn't exist we just normalise; for existing targets we walk
 *  symlinks via realpath so a `~/Documents/escape` link can't hide the
 *  real destination from a scope check. */
export async function canonicalisePath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/** True when `target` is the same as `scope` or sits underneath it.
 *  `scope === null` means "no scope set" — the caller should rely on the
 *  user's approval mode instead of treating this check as a hard bound. */
export async function isPathInScope(
  target: string,
  scope: string | null,
): Promise<boolean> {
  if (!scope) return true;
  const canonicalTarget = await canonicalisePath(target);
  const canonicalScope = await canonicalisePath(scope);
  if (canonicalTarget === canonicalScope) return true;
  return canonicalTarget.startsWith(canonicalScope + path.sep);
}

export async function executeFileAction(
  action: FileToolAction,
): Promise<FileExecuteResult> {
  try {
    switch (action.action) {
      case 'list_directory': {
        const dir = await canonicalisePath(action.path);
        const entries = await readdir(dir, { withFileTypes: true });
        const limited = entries.slice(0, LIST_ENTRY_CAP);
        const lines: string[] = [];
        for (const e of limited) {
          const tag = e.isDirectory() ? 'D' : e.isSymbolicLink() ? 'L' : 'F';
          // Best-effort size for files only — directories don't have a
          // meaningful size on Windows.
          let sizeStr = '';
          if (e.isFile()) {
            try {
              const s = await stat(path.join(dir, e.name));
              sizeStr = ` ${s.size}`;
            } catch {
              // ignore
            }
          }
          lines.push(`${tag}${sizeStr} ${e.name}`);
        }
        if (entries.length > LIST_ENTRY_CAP) {
          lines.push(`... (${entries.length - LIST_ENTRY_CAP} more entries truncated)`);
        }
        return { ok: true, output: `Directory: ${dir}\n${lines.join('\n')}` };
      }

      case 'read_file': {
        const file = await canonicalisePath(action.path);
        const s = await stat(file);
        if (!s.isFile()) {
          return { ok: false, error: `Not a file: ${file}` };
        }
        if (s.size > READ_BYTE_CAP) {
          return {
            ok: false,
            error: `File ${file} is ${s.size} bytes; exceeds ${READ_BYTE_CAP}-byte read cap.`,
          };
        }
        const content = await readFile(file, 'utf8');
        return { ok: true, output: content };
      }

      case 'search_files': {
        const root = await canonicalisePath(action.root);
        const pattern = action.pattern;
        const re = compilePattern(pattern);
        const matches: string[] = [];
        await walk(root, 0, (rel) => {
          if (re.test(rel)) {
            matches.push(rel);
            return matches.length < SEARCH_RESULT_CAP;
          }
          return true;
        });
        if (matches.length === 0) {
          return { ok: true, output: `No matches for "${pattern}" under ${root}` };
        }
        const truncated = matches.length === SEARCH_RESULT_CAP
          ? `\n... (truncated at ${SEARCH_RESULT_CAP} results)`
          : '';
        return {
          ok: true,
          output: `${matches.length} match${matches.length === 1 ? '' : 'es'}:\n${matches.join('\n')}${truncated}`,
        };
      }

      case 'write_file': {
        // Resolve symlinks via realpath BEFORE writing so a planted
        // symlink (`workspace/foo` → `/etc/passwd`) can't redirect the
        // write outside the directory the loop's scope check
        // approved. `canonicalisePath` falls through to plain
        // `path.resolve` for paths that don't exist yet (the common
        // case for new files), which is correct: a not-yet-existent
        // path can't itself be a symlink.
        const file = await canonicalisePath(action.path);
        // Make sure the parent directory exists; don't create deep new
        // hierarchies silently — only ONE level so a typo doesn't seed a
        // new tree. The agent has `create_directory` for explicit deeper
        // creates.
        const parent = path.dirname(file);
        try {
          await stat(parent);
        } catch {
          await mkdir(parent, { recursive: false });
        }
        await writeFile(file, action.content, 'utf8');
        return {
          ok: true,
          output: `Wrote ${Buffer.byteLength(action.content, 'utf8')} bytes to ${file}`,
        };
      }

      case 'create_directory': {
        const dir = path.resolve(action.path);
        // Recursive on purpose: when the agent explicitly asks to create a
        // directory, it can ask for any depth. Compare with `write_file`,
        // which only auto-mkdirs ONE level for the file's parent — that
        // restriction is to prevent accidental tree-seeding from a typo'd
        // target path.
        await mkdir(dir, { recursive: true });
        return { ok: true, output: `Created directory ${dir}` };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/** Translate a glob-ish or substring pattern to a regex. We accept three
 *  flavours so the model can pick whatever feels natural:
 *  - `*.json`         (glob — `*` matches anything except path separators)
 *  - `**\/*.test.ts`  (`**` matches across separators)
 *  - `foo`            (plain substring — case-insensitive)
 */
function compilePattern(pattern: string): RegExp {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return new RegExp(escapeRegex(pattern), 'i');
  }
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    // `i < pattern.length` guarantees `pattern[i]` is defined, but
    // `noUncheckedIndexedAccess` widens the indexed type — bind once
    // and let TS narrow.
    const ch = pattern[i] as string;
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
    } else if (ch === '*') {
      re += '[^/\\\\]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/\\\\]';
      i += 1;
    } else {
      re += escapeRegex(ch);
      i += 1;
    }
  }
  return new RegExp(re, 'i');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walk a directory tree depth-first, calling `visit` with each entry's
 *  path RELATIVE to the root. Stops descending when `visit` returns false
 *  (used as a stop signal once enough matches accumulate). */
async function walk(
  root: string,
  depth: number,
  visit: (relPath: string) => boolean,
): Promise<boolean> {
  if (depth > SEARCH_DEPTH_CAP) return true;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    // Skip hidden + node_modules / .git by default — too noisy and not
    // typically what the user is searching for.
    if (
      e.name.startsWith('.') ||
      e.name === 'node_modules' ||
      e.name === '__pycache__'
    ) {
      continue;
    }
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const cont = await walk(full, depth + 1, visit);
      if (!cont) return false;
    } else if (e.isFile()) {
      const cont = visit(full);
      if (!cont) return false;
    }
  }
  return true;
}

/** Human-readable description of a file action for UI display. Mirrors the
 *  computer-action describe helper. */
export function describeFileAction(a: FileToolAction): string {
  switch (a.action) {
    case 'list_directory': return `List ${a.path}`;
    case 'read_file': return `Read ${a.path}`;
    case 'search_files': return `Search ${a.root} for "${a.pattern}"`;
    case 'write_file': {
      const len = Buffer.byteLength(a.content, 'utf8');
      return `Write ${len}b to ${a.path}`;
    }
    case 'create_directory': return `Create directory ${a.path}`;
  }
}

/** The single file-system path this action operates on. Used by the loop
 *  driver to scope-check. */
export function primaryPathOf(a: FileToolAction): string {
  switch (a.action) {
    case 'list_directory': return a.path;
    case 'read_file': return a.path;
    case 'write_file': return a.path;
    case 'search_files': return a.root;
    case 'create_directory': return a.path;
  }
}
