import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, findAssemblies } from './assemblyParser';
import { persistSetting } from './utils';

// ─── Build Settings ──────────────────────────────────────────────────────────

export function buildSettings(
  assembly: Assembly,
  mainPackage: string | undefined,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
  existing: Record<string, any> = {},
): Record<string, any> {
  const s = { ...existing };
  s['upp.activeAssembly']    = assembly.filePath;
  s['upp.activeMainPackage'] = mainPackage;
  if (buildParams) {
    s['upp.buildMethod']   = buildParams.buildMethod;
    s['upp.configurationFlag']    = buildParams.configurationFlag;
    s['upp.buildCommand']  = buildParams.buildCommand;
  }
  return s;
}

// ─── Workspace Switching ─────────────────────────────────────────────────────

/**
 * Persist assembly/package selection and build params to VS Code settings.
 * Does NOT create or switch to .code-workspace files — settings are saved
 * directly to workspace folder settings (.vscode/settings.json).
 */
export async function switchWorkspace(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('upp');

  // Persist assembly/package selection to VS Code settings
  await persistSetting('upp.activeAssembly', assembly.filePath, cfg);
  await persistSetting('upp.activeMainPackage', pkgName, cfg);

  // Persist build params to VS Code settings
  if (buildParams) {
    await persistSetting('upp.buildMethod', buildParams.buildMethod, cfg);
    await persistSetting('upp.configurationFlag', buildParams.configurationFlag, cfg);
    await persistSetting('upp.buildCommand', buildParams.buildCommand, cfg);
  }

  // If a .code-workspace file happens to be open, update its settings too (backward compat)
  try {
    const wsFile = vscode.workspace.workspaceFile;
    if (wsFile?.scheme === 'file') {
      const existing = JSON.parse(fs.readFileSync(wsFile.fsPath, 'utf8'));
      existing.settings = buildSettings(assembly, pkgName, buildParams, existing.settings);
      fs.writeFileSync(wsFile.fsPath, JSON.stringify(existing, null, 2), 'utf8');
    }
  } catch { /* non-fatal */ }

  // Switch workspace folder to the selected package's directory
  if (pkgDir && fs.existsSync(pkgDir)) {
    vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0,
      { uri: vscode.Uri.file(pkgDir) }
    );
  }
}

// ─── Workspace Sync & Logging ───────────────────────────────────────────────

export function getWorkspacesDir(): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  return cfg.get<string>('workspacesDir', '') ?? '';
}

function getLogPath(): string {
  const dir = getWorkspacesDir();
  if (!dir) return '';
  return path.join(dir, 'workspaces.log');
}

function logWorkspaces(message: string) {
  const logPath = getLogPath();
  if (!logPath) return;
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}${os.EOL}`;
  try {
    fs.appendFileSync(logPath, entry, 'utf8');
  } catch { /* non-fatal */ }
}

export async function syncWorkspaces() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const workspacesDir = cfg.get<string>('workspacesDir', '');
  if (!workspacesDir) {
    vscode.window.showWarningMessage('UPP: Set "upp.workspacesDir" first.');
    return;
  }
  logWorkspaces('=== Workspace Sync Started ===');

  if (!fs.existsSync(workspacesDir)) {
    vscode.window.showWarningMessage(`UPP: Workspaces dir not found: ${workspacesDir}`);
    return;
  }

  const assemblies = findAssemblies(cfg.get<string>('varDir', ''));
  const wsFiles = fs.readdirSync(workspacesDir).filter(f => f.endsWith('.code-workspace'));
  const wsNameToAssembly = new Map(assemblies.map(a => [a.name, a]));

  for (const wsFile of wsFiles) {
    const wsPath = path.join(workspacesDir, wsFile);
    const wsName = wsFile.replace('.code-workspace', '');
    const assembly = wsNameToAssembly.get(wsName);

    if (!assembly) {
      logWorkspaces(`WARN: ${wsName} has no matching assembly`);
      const choice = await vscode.window.showWarningMessage(
        `Workspace "${wsName}" has no matching assembly. Delete?`,
        'Ignore', 'Delete'
      );
      if (choice === 'Delete') {
        try { fs.unlinkSync(wsPath); } catch { /* ignore */ }
        logWorkspaces(`DELETED: ${wsName}`);
      }
      continue;
    }

    try {
      JSON.parse(fs.readFileSync(wsPath, 'utf8'));
    } catch (err: any) {
      logWorkspaces(`ERROR: ${wsName}: ${err.message}`);
    }
  }

  const missing = assemblies.filter(a => !wsFiles.some(f => f === `${a.name}.code-workspace`));
  if (missing.length > 0) {
    const names = missing.map(a => a.name).join(', ');
    logWorkspaces(`Assemblies without workspaces: ${names}`);
    vscode.window.showWarningMessage(`UPP: Assemblies without workspaces: ${names}. Use "UPP: Select Active Assembly" to create.`);
  } else {
    vscode.window.showInformationMessage('UPP: All assemblies have workspaces.');
  }

  logWorkspaces('=== Workspace Sync Completed ===');
}
