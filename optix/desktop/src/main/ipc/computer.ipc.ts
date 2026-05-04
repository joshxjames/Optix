import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  ComputerExecuteRequestSchema,
  ComputerLoopAppendRequestSchema,
  ComputerLoopContinueRequestSchema,
  ComputerLoopStartRequestSchema,
  FileExecuteRequestSchema,
  LabelToolActionSchema,
  ShellExecuteRequestSchema,
  ToolResultSchema,
} from '@shared/schemas';
import {
  abortComputerLoop,
  appendUserMessageToLoop,
  continueComputerLoop,
  endComputerLoop,
  hasAgentSupport,
  startComputerLoop,
} from '@main/automation/computer-loop';
import { executeComputerAction, executeLabelAction } from '@main/automation/executor';
import { executeFileAction, isPathInScope } from '@main/automation/file-executor';
import { executeShellAction, resolveShellCwd } from '@main/automation/shell-executor';
import { getForegroundWindowTitle } from '@main/automation/foreground';
import { getUiaElementsAtPoint } from '@main/capture/uia';
import { getApiKey } from '@main/security/keychain';
import { getModelFor, getSettings } from '@main/storage/settings-store';

// Single-tool execute request shapes now live in shared/schemas.ts so
// the wire contract is co-located with the action schemas they wrap.
// Label-execute is the one outlier (no renderer-facing api.ts type
// distinct from the tool action) so its request stays inline.
const ExecuteLabelRequestSchema = z.object({
  action: LabelToolActionSchema,
});

const ScopeCheckRequestSchema = z.object({ path: z.string() });

const AbortRequestSchema = z.object({ loopId: z.string() });

const EndRequestSchema = z.object({
  loopId: z.string(),
  // Lets the renderer distinguish "user explicitly wrapped up the
  // conversation" from "loop torn down implicitly" (mode toggled off,
  // single-shot submit clearing a stale loop, etc.). Default 'done'
  // matches the historical behaviour for callers that don't pass it.
  outcome: z.enum(['done', 'abandoned']).default('done'),
});

export function registerComputerIpc(): void {
  ipcMain.handle(IPC.computer.start, async (_event, raw: unknown) => {
    const req = ComputerLoopStartRequestSchema.parse(raw);
    const settings = getSettings();
    const providerId = settings.activeProviderId;
    if (!hasAgentSupport(providerId)) {
      throw new Error(
        `Access mode is not yet supported on provider "${providerId}". Switch to Anthropic in Settings — OpenAI / Gemini / Kimi support is rolling out.`,
      );
    }
    // Optix Cloud: the renderer attached a fresh Firebase ID token to
    // the request. For BYO-key providers, fetch from the OS keychain.
    const credential =
      providerId === 'optixCloud'
        ? req.authToken
        : await getApiKey(providerId);
    if (!credential) {
      throw new Error(
        providerId === 'optixCloud'
          ? 'Not signed in to Optix Cloud. Click Sign in in Settings.'
          : `No ${providerId} API key configured. Open Settings to add one.`,
      );
    }
    const modelId = getModelFor(providerId);
    return await startComputerLoop(
      req,
      credential,
      modelId,
      settings.agentCostCeilingUsd ?? null,
      settings.agentWorkspaceFolder ?? null,
      providerId,
    );
  });

  ipcMain.handle(IPC.computer.continue, async (_event, raw: unknown) => {
    const req = ComputerLoopContinueRequestSchema.parse(raw);
    // Belt-and-braces: re-parse `results` against ToolResultSchema so
    // even if the outer continue schema were ever loosened, malformed
    // tool-results from a compromised renderer can't slip through to
    // the loop driver's `as AgentToolResult[]` cast.
    z.array(ToolResultSchema).parse(req.results);
    return await continueComputerLoop(req);
  });

  ipcMain.handle(IPC.computer.appendUserMessage, async (_event, raw: unknown) => {
    const req = ComputerLoopAppendRequestSchema.parse(raw);
    return await appendUserMessageToLoop(req);
  });

  ipcMain.handle(IPC.computer.end, async (_event, raw: unknown) => {
    const req = EndRequestSchema.parse(raw);
    endComputerLoop(req.loopId, req.outcome);
  });

  ipcMain.handle(IPC.computer.abort, async (_event, raw: unknown) => {
    const req = AbortRequestSchema.parse(raw);
    abortComputerLoop(req.loopId);
  });

  ipcMain.handle(IPC.computer.execute, async (_event, raw: unknown) => {
    const req = ComputerExecuteRequestSchema.parse(raw);
    return await executeComputerAction(req.action, {
      imageWidth: req.imageWidth,
      imageHeight: req.imageHeight,
      snapToUia: req.snapToUia,
    });
  });

  ipcMain.handle(IPC.computer.executeFile, async (_event, raw: unknown) => {
    const req = FileExecuteRequestSchema.parse(raw);
    return await executeFileAction(req.action);
  });

  ipcMain.handle(IPC.computer.executeLabel, async (_event, raw: unknown) => {
    const req = ExecuteLabelRequestSchema.parse(raw);
    return await executeLabelAction(req.action);
  });

  ipcMain.handle(IPC.computer.executeShell, async (_event, raw: unknown) => {
    const req = ShellExecuteRequestSchema.parse(raw);
    return await executeShellAction(req.action);
  });

  // Helper for the renderer's gating logic — reports the cwd a shell
  // command would actually run in (after applying the workspace
  // default + home-dir fallback) along with whether it sits inside
  // the current workspace. Lets the renderer decide whether to gate
  // an out-of-scope shell call regardless of approval mode.
  ipcMain.handle(
    IPC.computer.resolveShellCwd,
    async (_event, raw: unknown) => {
      const { cwd } = z.object({ cwd: z.string().optional() }).parse(raw);
      const resolved = resolveShellCwd(cwd);
      const scope = getSettings().agentWorkspaceFolder ?? null;
      // Mirror the file-action behaviour: when no workspace is set
      // there's nothing to be "outside of", so the hard boundary
      // doesn't fire. `isPathInScope` already returns true for null
      // scope — delegate to it so the two tools stay consistent.
      const inScope = await isPathInScope(resolved, scope);
      return { cwd: resolved, inScope };
    },
  );

  ipcMain.handle(IPC.computer.isPathInScope, async (_event, raw: unknown) => {
    const { path: targetPath } = ScopeCheckRequestSchema.parse(raw);
    const scope = getSettings().agentWorkspaceFolder ?? null;
    return await isPathInScope(targetPath, scope);
  });

  // Recording-time context capture. Used by the Automate tab's
  // routine recorder to enrich each saved action with semantic info
  // (UIA element name + control type at the click point, plus the
  // foreground window title) so future replays can adapt when the
  // raw coordinates no longer match the current screen state.
  ipcMain.handle(
    IPC.computer.queryRecordingContext,
    async (_event, raw: unknown) => {
      const { point } = z
        .object({ point: z.tuple([z.number(), z.number()]).optional() })
        .parse(raw);
      const [titleResult, elementsResult] = await Promise.all([
        getForegroundWindowTitle().catch(() => null),
        point ? getUiaElementsAtPoint(point[0], point[1]).catch(() => []) : Promise.resolve([]),
      ]);
      // Pick the smallest named element under the point — most
      // specific match (a button label rather than a window).
      const named = (elementsResult as Array<{
        name: string;
        controlType: string;
        bounds: { width: number; height: number };
      }>)
        .filter((e) => e.name && e.name.trim().length > 0)
        .sort(
          (a, b) =>
            a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height,
        );
      const target = named[0];
      return {
        windowTitle: titleResult,
        targetElementName: target?.name,
        targetElementType: target?.controlType,
      };
    },
  );
}
