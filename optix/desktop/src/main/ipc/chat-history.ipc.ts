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

const AppendTurnRequestSchema = z.object({
  convId: z.string(),
  mode: ModeSchema,
  prompt: z.string(),
  attachments: z
    .array(
      z.object({
        bytes: Uint8ArraySchema,
        mimeType: z.string(),
        filename: z.string().optional(),
      }),
    )
    .default([]),
  capture: z
    .object({
      bytes: Uint8ArraySchema,
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

  ipcMain.handle(IPC.chatHistory.list, async () => {
    return await listConversations();
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
