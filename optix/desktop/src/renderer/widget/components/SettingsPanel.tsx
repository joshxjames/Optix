import { useEffect, useMemo, useState } from 'react';
import type { ProviderId, Settings } from '../../../shared/schemas';
import { MODELS_BY_PROVIDER, PROVIDER_LABELS } from '../../../shared/models';
import { AuditLogViewer } from './AuditLogViewer';
import { ChatHistoryViewer } from './ChatHistoryViewer';
import { RoutinesViewer } from './RoutinesViewer';

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'kimi', 'google'];

type Props = {
  settings: Settings;
  onClose: () => void;
};

type KeyStatus =
  | { kind: 'unknown' }
  | { kind: 'stored' }
  | { kind: 'missing' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

export function SettingsPanel({ settings, onClose }: Props) {
  const activeId = settings.activeProviderId;
  const models = MODELS_BY_PROVIDER[activeId];
  const currentModelId = settings.modelByProvider[activeId] ?? '';
  const isCustomModel = useMemo(
    () => !models.some((m) => m.id === currentModelId),
    [models, currentModelId],
  );

  const [keyInput, setKeyInput] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [status, setStatus] = useState<KeyStatus>({ kind: 'unknown' });
  const [view, setView] = useState<'settings' | 'audit' | 'chat' | 'routines'>('settings');

  // Re-check key status whenever the active provider changes.
  useEffect(() => {
    setKeyInput('');
    setStatus({ kind: 'unknown' });
    void window.optix.settings.hasApiKey(activeId).then((has) => {
      setStatus({ kind: has ? 'stored' : 'missing' });
    });
  }, [activeId]);

  useEffect(() => {
    if (isCustomModel) setCustomModel(currentModelId);
  }, [isCustomModel, currentModelId]);

  async function patchSettings(patch: Partial<Settings>) {
    await window.optix.settings.set(patch);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    await window.optix.settings.setApiKey(activeId, keyInput.trim());
    setKeyInput('');
    setStatus({ kind: 'stored' });
  }

  async function deleteKey() {
    await window.optix.settings.deleteApiKey(activeId);
    setStatus({ kind: 'missing' });
  }

  async function testKey() {
    setStatus({ kind: 'testing' });
    const result = await window.optix.provider.testKey(activeId);
    if (result.ok) setStatus({ kind: 'ok' });
    else setStatus({ kind: 'error', message: result.error });
  }

  function onModelChange(modelId: string) {
    void patchSettings({
      modelByProvider: { ...settings.modelByProvider, [activeId]: modelId },
    });
  }

  if (view === 'audit') {
    return (
      <div className="settings-panel">
        <AuditLogViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  if (view === 'chat') {
    return (
      <div className="settings-panel">
        <ChatHistoryViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  if (view === 'routines') {
    return (
      <div className="settings-panel">
        <RoutinesViewer onClose={() => setView('settings')} />
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <button type="button" className="btn btn--small" onClick={onClose}>
          ← Back
        </button>
        <strong>Settings</strong>
        <div className="settings-panel__header-actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('chat')}
          >
            Ask Logs
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('audit')}
          >
            Access Logs
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setView('routines')}
          >
            Automations
          </button>
        </div>
      </div>

      <div className="settings-panel__body">
        <section className="settings-panel__section">
          <label className="settings-panel__label">Provider</label>
          <div className="settings-panel__radios">
            {PROVIDER_IDS.map((id) => (
              <label key={id} className="settings-panel__radio">
                <input
                  type="radio"
                  name="activeProvider"
                  value={id}
                  checked={activeId === id}
                  onChange={() => void patchSettings({ activeProviderId: id })}
                />
                <span>{PROVIDER_LABELS[id]}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-panel__section">
          <label className="settings-panel__label">Model</label>
          <select
            className="settings-panel__input"
            value={isCustomModel ? '__custom__' : currentModelId}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                onModelChange(customModel || '');
              } else {
                onModelChange(e.target.value);
              }
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}{m.note ? ` — ${m.note}` : ''}
              </option>
            ))}
            <option value="__custom__">Custom model ID…</option>
          </select>
          {isCustomModel && (
            <input
              type="text"
              className="settings-panel__input settings-panel__input--mono"
              placeholder="provider-specific model id"
              value={customModel}
              onChange={(e) => {
                setCustomModel(e.target.value);
                onModelChange(e.target.value);
              }}
            />
          )}
        </section>

        <section className="settings-panel__section">
          <label className="settings-panel__label">{PROVIDER_LABELS[activeId]} API key</label>
          <div className="settings-panel__row">
            <input
              type="password"
              placeholder={
                status.kind === 'stored' || status.kind === 'ok'
                  ? '•••••••• (stored in keychain)'
                  : 'Paste API key'
              }
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="settings-panel__input"
            />
            <button type="button" className="btn btn--small" onClick={saveKey} disabled={!keyInput.trim()}>
              Save
            </button>
            {(status.kind === 'stored' || status.kind === 'ok' || status.kind === 'error') && (
              <>
                <button type="button" className="btn btn--small" onClick={testKey}>
                  Test
                </button>
                <button type="button" className="btn btn--small" onClick={deleteKey}>
                  Remove
                </button>
              </>
            )}
          </div>
          <KeyStatusLine status={status} />
        </section>

        <section className="settings-panel__section">
          <label className="settings-panel__label">Hotkey</label>
          <input
            type="text"
            className="settings-panel__input settings-panel__input--mono"
            value={settings.hotkeyToggleWidget}
            onChange={(e) => void patchSettings({ hotkeyToggleWidget: e.target.value })}
            placeholder="e.g. Ctrl+Shift+Space"
          />
        </section>

        <section className="settings-panel__section">
          <div className="settings-panel__toggle-grid">
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.privacyPaused}
                onChange={() => void patchSettings({ privacyPaused: !settings.privacyPaused })}
              />
              <span>Pause capture</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.webSearchEnabled}
                onChange={() => void patchSettings({ webSearchEnabled: !settings.webSearchEnabled })}
              />
              <span>Web search</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.overlayEnabled}
                onChange={() => void patchSettings({ overlayEnabled: !settings.overlayEnabled })}
              />
              <span>Show overlay</span>
            </label>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.conversationMode}
                onChange={() => void patchSettings({ conversationMode: !settings.conversationMode })}
              />
              <span>Conversation</span>
            </label>
          </div>
        </section>

        <section className="settings-panel__section">
          <h3 className="settings-panel__section-title">Agent (Action mode)</h3>
          <div className="settings-panel__field-row">
            <label className="settings-panel__field">
              <span>Approval before actions</span>
              <select
                value={settings.agentApprovalMode}
                onChange={(e) =>
                  void patchSettings({
                    agentApprovalMode: e.target.value as 'per-task' | 'each-action' | 'never',
                  })
                }
              >
                <option value="per-task">Per task</option>
                <option value="each-action">Per action</option>
                <option value="never">Never</option>
              </select>
            </label>
            <label className="settings-panel__field">
              <span>Cost ceiling (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="No cap"
                value={settings.agentCostCeilingUsd ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const num = raw === '' ? null : Number(raw);
                  if (num !== null && !Number.isFinite(num)) return;
                  void patchSettings({ agentCostCeilingUsd: num });
                }}
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

function KeyStatusLine({ status }: { status: KeyStatus }) {
  if (status.kind === 'unknown') return null;
  if (status.kind === 'missing')
    return <div className="settings-panel__status settings-panel__status--muted">No key stored.</div>;
  if (status.kind === 'stored')
    return <div className="settings-panel__status settings-panel__status--ok">Key stored. Test it to verify.</div>;
  if (status.kind === 'testing')
    return <div className="settings-panel__status">Testing…</div>;
  if (status.kind === 'ok')
    return <div className="settings-panel__status settings-panel__status--ok">✓ Key works.</div>;
  return <div className="settings-panel__status settings-panel__status--error">✗ {status.message}</div>;
}
