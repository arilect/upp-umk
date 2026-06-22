import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, findAssemblies, resolveWorkspaceFolders } from './assemblyParser';
import { activeMainPackage } from './state';

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
 * After selecting an assembly + package, create or switch to a .code-workspace.
 *
 * Strategy:
 *   1. Look for <workspacesDir>/<assemblyName>.code-workspace
 *   2. If it exists, switch to it
 *   3. If it doesn't exist, create it with the assembly nests as folders, then switch
 *   4. If workspacesDir is not configured, prompt the user to set it
 */
export async function switchWorkspace(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('upp');
  const workspacesDir: string = cfg.get('workspacesDir', '');

  if (!workspacesDir) {
    const wsJsonContent: Record<string, any> = {};
    wsJsonContent.settings = buildSettings(assembly, activeMainPackage);
    try {
      const wsFile = vscode.workspace.workspaceFile;
      if (wsFile?.scheme === 'file') {
        const existing = JSON.parse(fs.readFileSync(wsFile.fsPath, 'utf8'));
        existing.settings = buildSettings(assembly, activeMainPackage, undefined, existing.settings);
        fs.writeFileSync(wsFile.fsPath, JSON.stringify(existing, null, 2), 'utf8');
      }
    } catch { /* non-fatal */ }

    const choice = await vscode.window.showWarningMessage(
      'UPP: Set "upp.workspacesDir" to enable automatic workspace switching.',
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aris.upp-umk');
    }
    vscode.window.showInformationMessage(`UPP: Active → ${assembly.name} / ${activeMainPackage}`);
    return;
  }

  // Workspace named after the assembly, e.g. "MyAssembly.code-workspace"
  const wsPath = path.join(workspacesDir, `${assembly.name}.code-workspace`);
  const wsUri  = vscode.Uri.file(wsPath);

  // Create workspace file if it doesn't exist yet
  const alreadyExisted = fs.existsSync(wsPath);
  if (!alreadyExisted) {
    const pkgLeaf = path.basename(pkgDir);
    const pkgUppFile = path.join(pkgDir, `${pkgLeaf}.upp`);
    const folders = resolveWorkspaceFolders(pkgUppFile, assembly.nests);
    const wsContent = {
      folders: folders.map(f => ({ path: f })),
      settings: buildSettings(assembly, activeMainPackage, buildParams),
    };
    try {
      if (!fs.existsSync(workspacesDir)) {
        fs.mkdirSync(workspacesDir, { recursive: true });
      }
      fs.writeFileSync(wsPath, JSON.stringify(wsContent, null, 2), 'utf8');
    } catch (err: any) {
      vscode.window.showErrorMessage(`UPP: Failed to create workspace file: ${err.message}`);
      return;
    }
  } else {
    try {
      const wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      wsJson.settings = buildSettings(assembly, activeMainPackage, buildParams, wsJson.settings);
      fs.writeFileSync(wsPath, JSON.stringify(wsJson, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  // Already in this workspace — no switch needed
  const currentWsFile = vscode.workspace.workspaceFile?.fsPath;
  if (currentWsFile && path.normalize(currentWsFile) === path.normalize(wsPath)) {
    vscode.window.showInformationMessage(`UPP: Active → ${assembly.name} / ${activeMainPackage}`);
    return;
  }

  // Switch — this restarts the extension host, state is already persisted above
  const target = `${assembly.name} / ${path.basename(pkgName)}`;
  const showNotification = cfg.get<boolean>('showWorkspaceSwitchNotification', true);

  if (!showNotification) {
    await vscode.commands.executeCommand('vscode.openFolder', wsUri, false);
    return;
  }

  const msg = alreadyExisted
    ? `UPP: Switch to  ${target}  (${assembly.name}.code-workspace)?`
    : `UPP: Created workspace for  ${target}. Open it now?`;

  const choice = await vscode.window.showInformationMessage(msg, 'Switch', 'Stay');
  if (choice === 'Switch') {
    await vscode.commands.executeCommand('vscode.openFolder', wsUri, false);
  } else {
    vscode.window.showInformationMessage(`UPP: Active → ${assembly.name} / ${activeMainPackage}`);
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
