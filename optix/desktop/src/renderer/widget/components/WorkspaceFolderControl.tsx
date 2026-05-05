import { useState } from 'react';
import type { Settings } from '../../../shared/schemas';
import { FolderIcon } from './Icons';

type Props = {
  settings: Settings;
};

/** Single icon button toggles the workspace folder:
 *  • No folder set → click opens the OS folder picker.
 *  • Folder set (icon highlighted) → click clears the workspace.
 *  Clicking again after clear opens the picker. Two clicks to switch
 *  folders, but the controls row stays at one button regardless of
 *  state so the layout never reflows. */
export function WorkspaceFolderControl({ settings }: Props) {
  const folder = settings.agentWorkspaceFolder;
  // Disable while an async IPC is in flight so a double-click can't
  // launch two pickers (Electron will queue/stack them) or fire a
  // clear-then-pick race that ends up writing whichever resolves last.
  const [isLoading, setIsLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (isLoading) return;
    setIsLoading(true);
    try {
      if (folder) {
        // Currently active → first click clears scope. Persist via
        // settings.set so the change broadcasts to all windows and the
        // App-level onChange subscriber updates local settings state.
        await window.optix.settings.set({ agentWorkspaceFolder: null });
        return;
      }
      // No folder → open the picker.
      const chosen = await window.optix.widget.chooseWorkspaceFolder();
      if (!chosen) return; // user cancelled
      await window.optix.settings.set({ agentWorkspaceFolder: chosen });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <button
      type="button"
      className={`btn btn--icon workspace-folder__btn${folder ? ' workspace-folder__btn--active' : ''}`}
      onClick={() => void handleClick()}
      disabled={isLoading}
      // Tooltip carries the full path on hover so the user can verify
      // their selection without the path eating horizontal space.
      // Wording reflects the toggle behaviour: highlighted = clear,
      // unhighlighted = pick.
      title={
        folder
          ? `Workspace: ${folder}\nClick to clear`
          : 'Choose a workspace folder for file-system access'
      }
      aria-label={folder ? `Workspace folder: ${folder} (click to clear)` : 'Choose workspace folder'}
    >
      <FolderIcon />
    </button>
  );
}
