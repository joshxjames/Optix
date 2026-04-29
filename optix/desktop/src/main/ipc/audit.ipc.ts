import { dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  deleteAuditLog,
  listAuditLogs,
  readAuditLog,
  type AuditLog,
  type AuditLogSummary,
} from '@main/automation/audit';
import { getWidgetWindow } from '@main/windows/widget-window';

const ReadRequest = z.object({ filename: z.string() });
const ExportRequest = z.object({
  filename: z.string(),
  format: z.enum(['json', 'markdown', 'text']),
});

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '?';
  return new Date(iso).toLocaleString();
}

/** Backwards-compat: synthesise a single user message from `log.prompt`
 *  for old audit JSON written before per-message tracking existed. */
function userMessagesOf(log: AuditLog): AuditLog['userMessages'] {
  if (Array.isArray(log.userMessages) && log.userMessages.length > 0) {
    return log.userMessages;
  }
  return [
    { index: 0, prompt: log.prompt, startedAt: log.startedAt, firstTurnIndex: 0 },
  ];
}

/** Render an audit log as Markdown. */
function toMarkdown(log: AuditLog): string {
  const lines: string[] = [];
  const messages = userMessagesOf(log);
  lines.push(`# Optix Agent Run`);
  lines.push('');
  lines.push(`- **Started:** ${formatTimestamp(log.startedAt)}`);
  if (log.endedAt) lines.push(`- **Ended:** ${formatTimestamp(log.endedAt)}`);
  lines.push(`- **Outcome:** ${log.outcome ?? '?'}`);
  lines.push(`- **Provider / Model:** ${log.providerId} / ${log.modelId}`);
  lines.push(`- **Messages:** ${messages.length}`);
  lines.push(`- **Turns:** ${log.turns.length}`);
  const actions = log.turns.reduce((n, t) => n + t.actions.length, 0);
  lines.push(`- **Actions:** ${actions}`);
  if (log.estimatedCostUsd !== undefined) {
    lines.push(`- **Estimated cost:** $${log.estimatedCostUsd.toFixed(4)}`);
  }
  if (log.errorMessage) lines.push(`- **Error:** ${log.errorMessage}`);
  if (log.finalText) {
    lines.push('');
    lines.push(`> ${log.finalText.replace(/\n/g, '\n> ')}`);
  }
  lines.push('');
  // One section per user message; turns are sliced under their owning
  // message so multi-message conversations export as a clear narrative.
  messages.forEach((msg, mi) => {
    const next = messages[mi + 1];
    const endIdx = next ? next.firstTurnIndex : log.turns.length;
    const msgTurns = log.turns.slice(msg.firstTurnIndex, endIdx);
    lines.push(`## Message ${msg.index + 1} — ${formatTimestamp(msg.startedAt)}`);
    lines.push('');
    lines.push(`> **${msg.prompt}**`);
    lines.push('');
    for (const turn of msgTurns) {
      lines.push(`### Turn ${turn.turnIndex + 1}`);
      lines.push('');
      if (turn.modelText) {
        lines.push(`> ${turn.modelText.replace(/\n/g, '\n> ')}`);
        lines.push('');
      }
      const tokens =
        `input ${turn.inputTokens ?? '?'} · output ${turn.outputTokens ?? '?'}` +
        (turn.cacheCreationInputTokens
          ? ` · cache write ${turn.cacheCreationInputTokens}`
          : '') +
        (turn.cacheReadInputTokens
          ? ` · cache read ${turn.cacheReadInputTokens}`
          : '');
      lines.push(`*${turn.apiMs}ms · ${tokens} · stop: ${turn.stopReason ?? '?'}*`);
      lines.push('');
      for (const a of turn.actions) {
        const status = a.ok ? '✓' : '✗';
        const dur = a.durationMs > 0 ? ` (${a.durationMs}ms)` : '';
        lines.push(`- ${status} ${a.description}${dur}${a.errorText ? ` — ${a.errorText}` : ''}`);
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}

/** Render an audit log as plain text. Same content as Markdown but without
 *  the markdown sigils — for users who want a clean copy/paste. */
function toPlainText(log: AuditLog): string {
  const lines: string[] = [];
  const messages = userMessagesOf(log);
  lines.push('OPTIX AGENT RUN');
  lines.push('===============');
  lines.push('');
  lines.push(`Started: ${formatTimestamp(log.startedAt)}`);
  if (log.endedAt) lines.push(`Ended: ${formatTimestamp(log.endedAt)}`);
  lines.push(`Outcome: ${log.outcome ?? '?'}`);
  lines.push(`Provider/Model: ${log.providerId} / ${log.modelId}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push(`Turns: ${log.turns.length}`);
  const actions = log.turns.reduce((n, t) => n + t.actions.length, 0);
  lines.push(`Actions: ${actions}`);
  if (log.estimatedCostUsd !== undefined) {
    lines.push(`Estimated cost: $${log.estimatedCostUsd.toFixed(4)}`);
  }
  if (log.errorMessage) lines.push(`Error: ${log.errorMessage}`);
  if (log.finalText) {
    lines.push('');
    lines.push(log.finalText);
  }
  lines.push('');
  messages.forEach((msg, mi) => {
    const next = messages[mi + 1];
    const endIdx = next ? next.firstTurnIndex : log.turns.length;
    const msgTurns = log.turns.slice(msg.firstTurnIndex, endIdx);
    const header = `Message ${msg.index + 1} — ${formatTimestamp(msg.startedAt)}`;
    lines.push(header);
    lines.push('='.repeat(header.length));
    lines.push(`> ${msg.prompt}`);
    lines.push('');
    for (const turn of msgTurns) {
      const turnHeader = `Turn ${turn.turnIndex + 1}`;
      lines.push(turnHeader);
      lines.push('-'.repeat(turnHeader.length));
      if (turn.modelText) {
        lines.push(turn.modelText);
        lines.push('');
      }
      const tokens =
        `in ${turn.inputTokens ?? '?'} / out ${turn.outputTokens ?? '?'}` +
        (turn.cacheCreationInputTokens
          ? ` · cache write ${turn.cacheCreationInputTokens}`
          : '') +
        (turn.cacheReadInputTokens
          ? ` · cache read ${turn.cacheReadInputTokens}`
          : '');
      lines.push(`${turn.apiMs}ms · ${tokens} · stop ${turn.stopReason ?? '?'}`);
      lines.push('');
      for (const a of turn.actions) {
        const status = a.ok ? '[OK]' : '[FAIL]';
        const dur = a.durationMs > 0 ? ` (${a.durationMs}ms)` : '';
        lines.push(`  ${status} ${a.description}${dur}${a.errorText ? ` -- ${a.errorText}` : ''}`);
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}

export function registerAuditIpc(): void {
  ipcMain.handle(IPC.audit.list, async (): Promise<AuditLogSummary[]> => {
    return await listAuditLogs();
  });

  ipcMain.handle(IPC.audit.read, async (_e, raw: unknown): Promise<AuditLog | null> => {
    const { filename } = ReadRequest.parse(raw);
    return await readAuditLog(filename);
  });

  ipcMain.handle(IPC.audit.export, async (_e, raw: unknown): Promise<{ ok: true; path: string } | { ok: false; error?: string }> => {
    const { filename, format } = ExportRequest.parse(raw);
    const log = await readAuditLog(filename);
    if (!log) return { ok: false, error: 'Audit log not found.' };

    let content: string;
    let extension: string;
    if (format === 'json') {
      content = JSON.stringify(log, null, 2);
      extension = 'json';
    } else if (format === 'markdown') {
      content = toMarkdown(log);
      extension = 'md';
    } else {
      content = toPlainText(log);
      extension = 'txt';
    }

    // Default filename: same stem as the source, plus the new extension.
    const baseName = filename.replace(/\.json$/, '');
    const widget = getWidgetWindow();
    const defaultPath = `${baseName}.${extension}`;
    const result = widget
      ? await dialog.showSaveDialog(widget, {
          defaultPath,
          filters: [
            { name: format === 'json' ? 'JSON' : format === 'markdown' ? 'Markdown' : 'Text', extensions: [extension] },
          ],
        })
      : await dialog.showSaveDialog({
          defaultPath,
          filters: [
            { name: format === 'json' ? 'JSON' : format === 'markdown' ? 'Markdown' : 'Text', extensions: [extension] },
          ],
        });

    if (result.canceled || !result.filePath) return { ok: false };
    try {
      await writeFile(result.filePath, content, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.audit.delete, async (_e, raw: unknown): Promise<boolean> => {
    const { filename } = ReadRequest.parse(raw);
    return await deleteAuditLog(filename);
  });
}
