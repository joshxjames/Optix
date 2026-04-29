import Store from 'electron-store';
import { DEFAULT_MODEL_BY_PROVIDER } from '@shared/models';
import type { ProviderId, Settings } from '@shared/schemas';
import { SettingsSchema } from '@shared/schemas';

const defaults: Settings = {
  activeProviderId: 'anthropic',
  modelByProvider: { ...DEFAULT_MODEL_BY_PROVIDER },
  privacyPaused: false,
  hotkeyToggleWidget: process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space',
  webSearchEnabled: false,
  overlayEnabled: true,
  agentApprovalMode: 'per-task',
  agentCostCeilingUsd: null,
  agentWorkspaceFolder: null,
  conversationMode: false,
};

// Lazy-init: `new Store()` resolves `app.getPath('userData')` eagerly, which
// is only safe once `app.whenReady()` has fired. We delay construction until
// the first read.
let storeInstance: Store<Settings> | null = null;

function store(): Store<Settings> {
  if (!storeInstance) {
    storeInstance = new Store<Settings>({
      name: 'settings',
      defaults,
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export function getSettings(): Settings {
  const s = store();
  const parsed = SettingsSchema.safeParse(s.store);
  if (parsed.success) return parsed.data;
  // If the on-disk file is corrupted or from an older schema, reset to defaults.
  s.clear();
  s.set(defaults);
  return defaults;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next: Settings = {
    ...current,
    ...patch,
    modelByProvider: {
      ...current.modelByProvider,
      ...(patch.modelByProvider ?? {}),
    },
  };
  const parsed = SettingsSchema.parse(next);
  store().set(parsed);
  return parsed;
}

export function getModelFor(providerId: ProviderId): string {
  const s = getSettings();
  return s.modelByProvider[providerId] ?? DEFAULT_MODEL_BY_PROVIDER[providerId] ?? '';
}
