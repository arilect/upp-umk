import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, findAssemblies, resolveWorkspaceFolders } from './assemblyParser';
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
 * Creates a per-package .code-workspace file in workspacesDir if needed,
 * then opens it via vscode.openFolder to fully switch the workspace.
 */
export async function switchWorkspace(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  uppFile: string,
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

  // Compute workspace path from package name
  const workspacesDir = cfg.get<string>('workspacesDir', '');
  const safeName = pkgName.replace(/[/\\]/g, '-');
  const wsPath = workspacesDir
    ? path.join(workspacesDir, `${safeName}.code-workspace`)
    : '';

  // Create .code-workspace file if it doesn't exist
  if (workspacesDir && !fs.existsSync(wsPath)) {
    try {
      const folders = resolveWorkspaceFolders(uppFile, assembly.nests);
      const wsJson: Record<string, any> = {
        folders: folders.map(dir => ({ path: dir })),
        settings: buildSettings(assembly, pkgName, buildParams),
      };
      if (!fs.existsSync(workspacesDir)) {
        fs.mkdirSync(workspacesDir, { recursive: true });
      }
      fs.writeFileSync(wsPath, JSON.stringify(wsJson, null, 2), 'utf8');

      const showNotification = cfg.get<boolean>('workspaceCreationNotification', true);
      if (showNotification) {
        vscode.window.showInformationMessage(
          `UPP: Workspace created for "${pkgName}" at ${wsPath}`
        );
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`UPP: Failed to create workspace: ${err.message}`);
    }
  }

  // Update settings in an existing workspace file too
  if (wsPath && fs.existsSync(wsPath)) {
    try {
      const wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      wsJson.settings = buildSettings(assembly, pkgName, buildParams, wsJson.settings);
      fs.writeFileSync(wsPath, JSON.stringify(wsJson, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  // Switch to the workspace if not already in it
  if (wsPath && fs.existsSync(wsPath)) {
    const wsUri = vscode.Uri.file(wsPath);
    const currentWs = vscode.workspace.workspaceFile;

    // Already open in this workspace — nothing to do
    if (currentWs?.scheme === 'file' && path.normalize(currentWs.fsPath) === path.normalize(wsPath)) {
      return;
    }

    const showSwitchPrompt = cfg.get<boolean>('showWorkspaceSwitchNotification', true);
    if (!showSwitchPrompt) {
      await vscode.commands.executeCommand('vscode.openFolder', wsUri, false);
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `UPP: Switch to workspace "${safeName}"?`,
      'Switch', 'Stay'
    );
    if (choice === 'Switch') {
      await vscode.commands.executeCommand('vscode.openFolder', wsUri, false);
    }
  } else if (pkgDir && fs.existsSync(pkgDir)) {
    // Fallback: no workspacesDir configured, just add package folder to current window
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

  // Collect all known package names across all assemblies
  const { findPackagesInAssembly } = await import('./assemblyParser');
  const knownPackages = new Set<string>();
  for (const asm of assemblies) {
    for (const pkg of findPackagesInAssembly(asm)) {
      knownPackages.add(pkg.name);
    }
  }

  // Validate each workspace file
  for (const wsFile of wsFiles) {
    const wsPath = path.join(workspacesDir, wsFile);
    try {
      const wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      const pkgName: string | undefined = wsJson.settings?.upp?.activeMainPackage;
      if (pkgName && !knownPackages.has(pkgName)) {
        logWorkspaces(`WARN: ${wsFile} references unknown package "${pkgName}"`);
        const choice = await vscode.window.showWarningMessage(
          `Workspace "${wsFile}" references unknown package "${pkgName}". Delete?`,
          'Ignore', 'Delete'
        );
        if (choice === 'Delete') {
          try { fs.unlinkSync(wsPath); } catch { /* ignore */ }
          logWorkspaces(`DELETED: ${wsFile}`);
        }
      } else {
        logWorkspaces(`OK: ${wsFile} → ${pkgName ?? '(no package set)'}`);
      }
    } catch (err: any) {
      logWorkspaces(`ERROR: ${wsFile}: ${err.message}`);
    }
  }

  logWorkspaces('=== Workspace Sync Completed ===');
}
