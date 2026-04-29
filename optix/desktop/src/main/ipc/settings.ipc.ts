import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { ProviderIdSchema, SettingsSchema } from '@shared/schemas';
import { getSettings, setSettings } from '@main/storage/settings-store';
import { getApiKey, hasApiKey, setApiKey, deleteApiKey } from '@main/security/keychain';
import { registerHotkeys } from '@main/hotkeys/register';

const SetApiKeyArgs = z.object({
  providerId: ProviderIdSchema,
  apiKey: z.string().min(1),
});

const PartialSettingsSchema = SettingsSchema.partial();

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
  });

  ipcMain.handle(IPC.settings.hasApiKey, async (_event, rawId: unknown) => {
    const providerId = ProviderIdSchema.parse(rawId);
    return hasApiKey(providerId);
  });

  ipcMain.handle(IPC.settings.deleteApiKey, async (_event, rawId: unknown) => {
    const providerId = ProviderIdSchema.parse(rawId);
    await deleteApiKey(providerId);
  });
}

// Exported for tests / debugging; not wired to IPC.
export { getApiKey };
