import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  ModelResponseSchema,
  ModeSchema,
  ProviderIdSchema,
  TokenUsageSchema,
  Uint8ArraySchema,
} from '@shared/schemas';
import {
  appendTurn,
  deleteConversation,
  listConversations,
  readAttachment,
  readConversation,
  startConversation,
} from '@main/storage/chat-history';

// Validation schemas — validate everything from the renderer because main
// trusts nothing (path traversal, missing fields, etc.).

const StartRequestSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string(),
});

// Per-attachment 10 MB cap and 20-item array cap on attachments — defense
// against a compromised renderer pushing huge blobs through to disk
// (each turn is persisted under the conversation dir). Same 10 MB cap
// applies to the captured screenshot. 10 MB comfortably covers a 4K PNG
// screenshot or a moderate-resolution camera photo; anything larger is
// almost certainly junk we shouldn't be writing out.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

const AppendTurnRequestSchema = z.object({
  convId: z.string(),
  mode: ModeSchema,
  prompt: z.string(),
  attachments: z
    .array(
      z.object({
        bytes: Uint8ArraySchema.refine(
          (b) => b.byteLength <= MAX_ATTACHMENT_BYTES,
          { message: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` },
        ),
        mimeType: z.string(),
        filename: z.string().optional(),
      }),
    )
    .max(MAX_ATTACHMENTS)
    .default([]),
  capture: z
    .object({
      bytes: Uint8ArraySchema.refine(
        (b) => b.byteLength <= MAX_ATTACHMENT_BYTES,
        { message: `capture exceeds ${MAX_ATTACHMENT_BYTES} bytes` },
      ),
      mimeType: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  response: ModelResponseSchema.optional(),
  loopId: z.string().optional(),
  finalText: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: TokenUsageSchema.optional(),
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().optional(),
});

const IdRequestSchema = z.object({ id: z.string() });

// Optional pagination for the list endpoint — kept BACKWARD compatible
// so existing renderer callers passing nothing get the first page
// (default 100). 500 is a hard ceiling enforced both here and in the
// storage layer to keep a buggy/compromised renderer from asking for
// "everything" on a directory of thousands of conversations.
const ListRequestSchema = z
  .object({
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

const ReadAttachmentRequestSchema = z.object({
  convId: z.string(),
  path: z.string(),
});

export function registerChatHistoryIpc(): void {
  ipcMain.handle(IPC.chatHistory.start, async (_event, raw: unknown) => {
    const req = StartRequestSchema.parse(raw);
    return startConversation(req);
  });

  ipcMain.handle(IPC.chatHistory.appendTurn, async (_event, raw: unknown) => {
    const req = AppendTurnRequestSchema.parse(raw);
    return await appendTurn(req);
  });

  ipcMain.handle(IPC.chatHistory.list, async (_event, raw: unknown) => {
    const req = ListRequestSchema.parse(raw ?? {});
    // Wire shape stays a bare array of summaries for backward compat
    // with existing renderer callers (`window.optix.chatHistory.list()`
    // → `ConversationSummary[]`). The storage layer is paginated and
    // bounded under the hood — default 100 per call, hard cap 500 —
    // so a directory of thousands of conversations can no longer OOM
    // main on a single read. When the renderer grows a paginated UI,
    // a separate listPage IPC can expose `hasMore` + `nextCursor`.
    const result = await listConversations(req);
    return result.items;
  });

  ipcMain.handle(IPC.chatHistory.read, async (_event, raw: unknown) => {
    const { id } = IdRequestSchema.parse(raw);
    return await readConversation(id);
  });

  ipcMain.handle(IPC.chatHistory.delete, async (_event, raw: unknown) => {
    const { id } = IdRequestSchema.parse(raw);
    return await deleteConversation(id);
  });

  ipcMain.handle(IPC.chatHistory.readAttachment, async (_event, raw: unknown) => {
    const req = ReadAttachmentRequestSchema.parse(raw);
    const result = await readAttachment(req.convId, req.path);
    if (!result) return null;
    // Convert Buffer → Uint8Array for IPC structured-clone.
    return {
      bytes: new Uint8Array(result.bytes),
      mimeType: result.mimeType,
    };
  });
}
