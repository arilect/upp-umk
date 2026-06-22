import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Read-modify-write the .code-workspace file in one sync block.
 * Returns true if the update succeeded, false otherwise.
 */
export function updateWorkspaceFile(updateFn: (wsJson: Record<string, any>) => void): boolean {
  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile?.scheme !== 'file') return false;
  try {
    const wsJson = JSON.parse(fs.readFileSync(wsFile.fsPath, 'utf8'));
    wsJson.settings = wsJson.settings ?? {};
    updateFn(wsJson);
    fs.writeFileSync(wsFile.fsPath, JSON.stringify(wsJson, null, 2), 'utf8');
    return true;
  } catch (err: any) {
    console.warn(`UPP: Failed to update workspace file: ${err.message}`);
    return false;
  }
}

/**
 * Persist a setting value, preferring the workspace file, falling back to cfg.update.
 * Avoids the scope ambiguity of cfg.update for .code-workspace files.
 */
export async function persistSetting(key: string, value: string, cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const written = updateWorkspaceFile(wsJson => {
    wsJson.settings[key] = value;
  });
  if (written) return;

  try {
    await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
  } catch {
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }
}
