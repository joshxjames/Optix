import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { ProviderIdSchema, SettingsSchema } from '@shared/schemas';
import { getSettings, setSettings } from '@main/storage/settings-store';
import { getApiKey, hasApiKey, setApiKey, deleteApiKey } from '@main/security/keychain';
import { registerHotkeys } from '@main/hotkeys/register';
import { invalidateProviderCache } from '@main/providers/registry';

const SetApiKeyArgs = z.object({
  providerId: ProviderIdSchema,
  apiKey: z.string().min(1),
});

// `.strict()` rejects unknown fields at the IPC boundary so a buggy or
// compromised renderer can't smuggle extra keys through to the
// settings store (which currently merges-and-persists whatever it
// receives). `.partial()` is applied first so every known field stays
// optional for incremental updates.
const PartialSettingsSchema = SettingsSchema.partial().strict();

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settings.get, async () => getSettings());

  ipcMain.handle(IPC.settings.set, async (_event, patch: unknown) => {
    const parsed = PartialSettingsSchema.parse(patch);
    const prev = getSettings();
    const next = setSettings(parsed);
    // If the global toggle hotkey changed, re-register so the new combo
    // works immediately — no app restart required. Idempotent: a no-op if
    // the value didn't change.
    if (prev.hotkeyToggleWidget !== next.hotkeyToggleWidget) {
      registerHotkeys();
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.settings.changed, next);
    }
    return next;
  });

  ipcMain.handle(IPC.settings.setApiKey, async (_event, args: unknown) => {
    const { providerId, apiKey } = SetApiKeyArgs.parse(args);
    await setApiKey(providerId, apiKey);
    // Drop the pooled SDK client so the next prompt picks up the new
    // key instead of serving stale auth from the module-level cache.
    invalidateProviderCache(providerId);
  });

  ipcMain.handle(IPC.settings.hasApiKey, async (_event, rawId: unknown) => {
    const providerId = ProviderIdSchema.parse(rawId);
    return hasApiKey(providerId);
  });

  ipcMain.handle(IPC.settings.deleteApiKey, async (_event, rawId: unknown) => {
    const providerId = ProviderIdSchema.parse(rawId);
    await deleteApiKey(providerId);
    // Same rationale as setApiKey — drop the cached client so prompts
    // after a key removal correctly fail-fast instead of using the
    // last-known key from the in-memory pool.
    invalidateProviderCache(providerId);
  });
}

// Exported for tests / debugging; not wired to IPC.
export { getApiKey };
