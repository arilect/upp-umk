import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UppInstallation } from './installations';
import { findBuildMethods, parseBmFile } from './assemblyParser';

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

  // cfg is scoped to 'upp', so strip the prefix
  const unprefixed = key.replace(/^upp\./i, '');
  try {
    await cfg.update(unprefixed, value, vscode.ConfigurationTarget.Workspace);
  } catch {
    await cfg.update(unprefixed, value, vscode.ConfigurationTarget.Global);
  }
}

export function resolveUmkPath(cfg: vscode.WorkspaceConfiguration, installation?: UppInstallation): string {
  const configured = cfg.get<string>('umkPath', '');
  if (configured) return configured;
  if (os.platform() === 'win32' && installation) {
    return path.join(installation.path, 'umk.exe');
  }
  return 'umk';
}

/**
 * Resolve the active C++ standard from the build method's .bm file
 * (COMMON_CPP_OPTIONS -std=c++XX), falling back to the upp.cppStandard
 * workspace setting, then to 'c++17'.
 */
export function resolveCppStandard(
  buildMethod: string,
  varDir: string,
  cfg: vscode.WorkspaceConfiguration,
): string {
  if (buildMethod) {
    const bms = findBuildMethods(varDir);
    const bm = bms.find(b => b.name === buildMethod || b.filePath === buildMethod);
    if (bm) {
      const data = parseBmFile(bm.filePath);
      const match = data.COMMON_CPP_OPTIONS?.match(/-std=(c\+\+\S+)/);
      if (match) return match[1];
    }
  }
  return cfg.get<string>('cppStandard', '') || 'c++17';
}
