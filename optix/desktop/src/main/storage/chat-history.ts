import { app } from 'electron';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ConversationSchema } from '@shared/schemas';
import type {
  Conversation,
  ConversationAttachment,
  ConversationTurn,
  ModelResponse,
  Mode,
  ProviderId,
  TokenUsage,
} from '@shared/schemas';
import { costForTurns } from '@shared/pricing';

// One directory per conversation under <userData>/conversations/<id>/.
// Inside: `conversation.json` for the metadata + turns, and `images/` for
// attached uploads referenced by turns. Persists on every append so a
// crash mid-task still leaves a usable record. Mirrors the audit log
// pattern (see automation/audit.ts) but with binary attachment storage.

// In-memory cache with a soft FIFO cap — the Map's iteration order is
// insertion order, so the oldest entry is always `keys().next()`.
// Without this, a long-lived process that opened thousands of past
// conversations would hold every turn array in RAM forever. 50 is a
// loose ceiling that comfortably covers a normal session's context
// without growing without bound.
const CONVERSATION_CACHE_CAP = 50;
const conversations = new Map<string, Conversation>();

function cacheConversation(conv: Conversation): void {
  // Refresh recency by re-inserting — Map keys move to the end on
  // delete + set, giving us a simple LRU on writes.
  if (conversations.has(conv.id)) conversations.delete(conv.id);
  conversations.set(conv.id, conv);
  while (conversations.size > CONVERSATION_CACHE_CAP) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
}

function getConversationsDir(): string {
  return path.join(app.getPath('userData'), 'conversations');
}

function getConversationDir(convId: string): string {
  return path.join(getConversationsDir(), convId);
}

export function getChatHistoryDirectoryPath(): string {
  return getConversationsDir();
}

async function persist(conv: Conversation): Promise<void> {
  try {
    const dir = getConversationDir(conv.id);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'conversation.json');
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(conv, null, 2), 'utf8');
    await rename(tmp, target);
  } catch (err) {
    console.warn(
      '[optix-chat-history] persist failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

export function startConversation(opts: {
  providerId: ProviderId;
  modelId: string;
}): Conversation {
  const conv: Conversation = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    providerId: opts.providerId,
    modelId: opts.modelId,
    turns: [],
  };
  cacheConversation(conv);
  void persist(conv);
  return conv;
}

/**
 * Save attachment bytes to the conversation's images directory and return
 * the persisted metadata (relative path + mime + filename). Renderer-side
 * users pass us the raw bytes; we write them once and from then on the
 * conversation JSON references the file by relative path.
 */
async function persistAttachment(
  convId: string,
  bytes: Uint8Array,
  mimeType: string,
  filename: string | undefined,
): Promise<ConversationAttachment> {
  const ext = mimeToExtension(mimeType);
  const stem = randomUUID();
  const rel = path.posix.join('images', `${stem}${ext}`);
  const abs = path.join(getConversationDir(convId), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, abs);
  return {
    path: rel,
    mimeType,
    filename,
    byteLength: bytes.byteLength,
  };
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.bin';
  }
}

export type AppendTurnInput = {
  convId: string;
  mode: Mode;
  prompt: string;
  attachments: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
  capture?: { bytes: Uint8Array; mimeType: string; width: number; height: number };
  /** Ask-mode result, mutually exclusive with loopId. */
  response?: ModelResponse;
  /** Access-mode loop id; deep-links into the audit log. */
  loopId?: string;
  finalText?: string;
  errorMessage?: string;
  /** Token usage for this turn — drives Ask-log cost. */
  usage?: TokenUsage;
  providerId?: ProviderId;
  modelId?: string;
};

export async function appendTurn(input: AppendTurnInput): Promise<ConversationTurn | null> {
  const conv = conversations.get(input.convId);
  if (!conv) {
    console.warn(
      `[optix-chat-history] appendTurn: unknown conversation ${input.convId}`,
    );
    return null;
  }
  const turnId = randomUUID();
  const startedAt = new Date().toISOString();

  // Persist binary attachments + capture under the conversation's image dir.
  // We only ever cache the persisted-attachment metadata (path + mime +
  // byteLength) on the in-memory conversation — raw `bytes` from
  // `input.attachments` go straight to disk and stay function-local so
  // long-running conversations don't accumulate image RAM. The renderer
  // re-reads attachment bytes on demand via the `readAttachment` IPC.
  const persistedAttachments: ConversationAttachment[] = [];
  for (const att of input.attachments) {
    try {
      persistedAttachments.push(
        await persistAttachment(input.convId, att.bytes, att.mimeType, att.filename),
      );
    } catch (err) {
      console.warn(
        '[optix-chat-history] attachment write failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  let capturePath: string | undefined;
  let captureMimeType: string | undefined;
  let captureWidth: number | undefined;
  let captureHeight: number | undefined;
  if (input.capture) {
    try {
      const ext = mimeToExtension(input.capture.mimeType);
      const rel = path.posix.join('images', `capture-${randomUUID()}${ext}`);
      const abs = path.join(getConversationDir(input.convId), rel);
      await mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp`;
      await writeFile(tmp, input.capture.bytes);
      await rename(tmp, abs);
      capturePath = rel;
      captureMimeType = input.capture.mimeType;
      captureWidth = input.capture.width;
      captureHeight = input.capture.height;
    } catch (err) {
      console.warn(
        '[optix-chat-history] capture write failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const turn: ConversationTurn = {
    id: turnId,
    startedAt,
    endedAt: new Date().toISOString(),
    mode: input.mode,
    prompt: input.prompt,
    attachments: persistedAttachments,
    capturePath,
    captureMimeType,
    captureWidth,
    captureHeight,
    response: input.response,
    usage: input.usage,
    providerId: input.providerId,
    modelId: input.modelId,
    loopId: input.loopId,
    finalText: input.finalText,
    errorMessage: input.errorMessage,
  };
  conv.turns.push(turn);
  // Auto-derive a title from the first turn's prompt when not yet set.
  if (!conv.title && conv.turns.length === 1) {
    conv.title = input.prompt.slice(0, 60).replace(/\s+/g, ' ').trim();
  }
  conv.endedAt = new Date().toISOString();
  await persist(conv);
  return turn;
}

export type ConversationSummary = {
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  providerId: ProviderId;
  modelId: string;
  turnCount: number;
  /** How many of the conversation's turns have a captured screenshot
   *  on disk. Surfaced in the Ask Logs list as a `[📷 N]` icon-pill. */
  screenshotCount: number;
  /** Estimated USD cost summed across the Ask turns using each turn's
   *  recorded usage block + provider/model. Undefined when no turn
   *  has usage data (legacy conversations from before token tracking). */
  estimatedCostUsd?: number;
};

export type ListConversationsOptions = {
  /** Page size; defaults to 100 and is hard-capped at 500 so a
   *  malicious/buggy renderer can't request "give me everything" and
   *  OOM main on a directory of thousands of conversations. */
  limit?: number;
  /** 0-based offset into the directory listing, sorted newest-first by
   *  filename. The renderer paginates by passing the previous call's
   *  `nextCursor` back. */
  cursor?: number;
};

export type ListConversationsResult = {
  items: ConversationSummary[];
  hasMore: boolean;
  nextCursor: number;
};

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
// Cap concurrent file reads — `Promise.all` over the whole entries
// array would open thousands of file descriptors at once on a busy
// install. 20 is a balance between throughput and FD pressure.
const LIST_READ_CONCURRENCY = 20;

/**
 * List persisted conversations newest-first, returning lightweight
 * summaries for the viewer's list pane. Each entry is one parsed JSON
 * file — the metadata read is cheap; we don't load attachment bytes.
 *
 * Paginated to avoid OOMing on installs with thousands of
 * conversations. Existing callers that pass nothing get the first
 * page (100 items). Sort uses `id` as a tiebreaker so a clock skew
 * or bulk-import collision doesn't produce non-deterministic order
 * across calls.
 */
export async function listConversations(
  options: ListConversationsOptions = {},
): Promise<ListConversationsResult> {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIST_LIMIT)),
    MAX_LIST_LIMIT,
  );
  const cursor = Math.max(0, Math.floor(options.cursor ?? 0));
  const dir = getConversationsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { items: [], hasMore: false, nextCursor: cursor };
  }
  // Sort by directory name descending — names are UUIDs assigned at
  // start time, so this isn't strictly newest-first, but it gives a
  // stable order to slice into pages before the expensive per-file
  // reads. We still re-sort the parsed page by `startedAt` below for
  // the actual newest-first display ordering.
  entries.sort((a, b) => b.localeCompare(a));
  const slice = entries.slice(cursor, cursor + limit);

  // Chunked Promise.all — limit FD pressure on installs with many
  // conversations. Reads one window of `LIST_READ_CONCURRENCY` files
  // at a time, gathers their summaries, and concatenates.
  const summaries: Array<ConversationSummary | null> = [];
  for (let i = 0; i < slice.length; i += LIST_READ_CONCURRENCY) {
    const chunk = slice.slice(i, i + LIST_READ_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (name): Promise<ConversationSummary | null> => {
        const file = path.join(dir, name, 'conversation.json');
        try {
          const raw = await readFile(file, 'utf8');
          // Validate the on-disk shape before iterating — a corrupt or
          // hand-edited conversation.json shouldn't be able to crash
          // the list view by coercing past the TS cast. `safeParse`
          // returns the parsed object with extras stripped, or null.
          const parsed = ConversationSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) {
            // Breadcrumb for "my conversation disappeared" reports.
            console.warn(
              `[optix-chat] corrupt conversation ${name}:`,
              parsed.error.message,
            );
            return null;
          }
          const conv = parsed.data;
          const screenshotCount = conv.turns.filter(
            (t) => t.capturePath !== undefined,
          ).length;
          // Per-turn cost — each turn carries its own model id (mixed-
          // provider conversations are possible) and falls back to the
          // conversation-level model when missing. Summary value is
          // undefined when nothing has usage (legacy data).
          const anyUsage = conv.turns.some((t) => t.usage !== undefined);
          const estimatedCostUsd = anyUsage
            ? costForTurns(
                conv.turns.map((t) => ({
                  modelId: t.modelId ?? conv.modelId,
                  usage: t.usage,
                })),
              )
            : undefined;
          return {
            id: conv.id,
            startedAt: conv.startedAt,
            endedAt: conv.endedAt,
            title: conv.title,
            providerId: conv.providerId,
            modelId: conv.modelId,
            turnCount: conv.turns.length,
            screenshotCount,
            estimatedCostUsd,
          };
        } catch (err) {
          console.warn(
            `[optix-chat] corrupt conversation ${name}:`,
            err instanceof Error ? err.message : err,
          );
          return null;
        }
      }),
    );
    for (const r of results) summaries.push(r);
  }
  const items = summaries
    .filter((s): s is ConversationSummary => s !== null)
    // Tiebreaker on `id` — two conversations with identical
    // `startedAt` (clock skew, system-time reset) would otherwise
    // shuffle order between calls. `localeCompare` on the UUID gives
    // a stable, deterministic order.
    .sort((a, b) => {
      const byTime = b.startedAt.localeCompare(a.startedAt);
      if (byTime !== 0) return byTime;
      return b.id.localeCompare(a.id);
    });
  return {
    items,
    hasMore: slice.length === limit && cursor + slice.length < entries.length,
    nextCursor: cursor + slice.length,
  };
}

/**
 * Read one conversation by id. Filename is the conversation id —
 * we validate strictly to prevent directory traversal since the
 * renderer is untrusted from main's perspective.
 */
export async function readConversation(convId: string): Promise<Conversation | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(convId)) return null;
  try {
    const raw = await readFile(
      path.join(getConversationDir(convId), 'conversation.json'),
      'utf8',
    );
    // Same validation as `listConversations` — protect the renderer
    // from a corrupt file shaping unexpected data into the UI.
    const parsed = ConversationSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    // Breadcrumb for the same "my conversation disappeared" path the
    // list endpoint logs.
    console.warn(
      `[optix-chat] corrupt conversation ${convId}:`,
      parsed.error.message,
    );
    return null;
  } catch (err) {
    // ENOENT is a normal "doesn't exist" — only log when the read
    // failed for some other reason (permission, malformed JSON,
    // disk error) so a missing file isn't noisy.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      console.warn(
        `[optix-chat] corrupt conversation ${convId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

/** Delete an entire conversation including its image directory. */
export async function deleteConversation(convId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(convId)) return false;
  try {
    await rm(getConversationDir(convId), { recursive: true, force: true });
    conversations.delete(convId);
    return true;
  } catch (err) {
    console.warn(
      '[optix-chat-history] delete failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Read a persisted attachment's bytes by conversation id + relative path.
 * Used by the viewer to render thumbnails. Validates the path to keep it
 * inside the conversation's directory.
 */
export async function readAttachment(
  convId: string,
  relPath: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(convId)) return null;
  // Reject backslashes outright (Windows quirk: `path.join` will
  // happily traverse via `\..\` even when the surface check below
  // saw forward-slash-only input). Then enforce the prefix + no-`..`
  // rules on the original string for a fast reject path.
  if (relPath.includes('\\')) return null;
  if (!relPath.startsWith('images/')) return null;
  if (relPath.includes('..')) return null;
  const convDir = getConversationDir(convId);
  const abs = path.join(convDir, relPath);
  // Defence-in-depth: walk symlinks via `realpath` and confirm the
  // resolved path is still inside the conversation's directory.
  // A planted symlink (`images/escape` → `/etc/passwd`) would
  // otherwise bypass the prefix check above. Both sides go through
  // realpath so the comparison is symmetric on platforms that
  // canonicalise differently.
  try {
    const realFile = await realpath(abs);
    const realRoot = await realpath(convDir);
    if (
      realFile !== realRoot &&
      !realFile.startsWith(realRoot + path.sep)
    ) {
      return null;
    }
    const bytes = await readFile(realFile);
    const ext = path.extname(realFile).toLowerCase();
    const mimeType =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'application/octet-stream';
    return { bytes, mimeType };
  } catch {
    return null;
  }
}
