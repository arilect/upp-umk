import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, findAssemblies, resolveWorkspaceFolders } from './assemblyParser';
import { persistSetting } from './utils';

// ─── Build Settings ──────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

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

// ─── Workspace file helpers ─────────────────────────────────────────────────

/**
 * Return the expected .code-workspace file path for a package.
 * Uses upp.workspacesDir if configured, otherwise falls back to the
 * directory alongside the .var file.
 */
export function getWorkspaceFilePath(assembly: Assembly, pkgName: string): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const workspacesDir = expandHome(cfg.get<string>('workspacesDir') ?? '');
  const safeName = pkgName.replace(/[/\\]/g, '-');
  if (workspacesDir) {
    return path.join(workspacesDir, `${safeName}.code-workspace`);
  }
  return path.join(path.dirname(assembly.filePath), `${safeName}.code-workspace`);
}

/**
 * Create or update the .code-workspace file for a package so that it
 * contains the package directory as a workspace folder and the latest
 * assembly/package/build settings.
 *
 * Returns the absolute path to the workspace file, or undefined on failure.
 */
export function ensureWorkspaceFile(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  uppFile: string,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
): string | undefined {
  const wsPath = getWorkspaceFilePath(assembly, pkgName);
  const wsDir = path.dirname(wsPath);

  try {
    if (!fs.existsSync(wsDir)) {
      fs.mkdirSync(wsDir, { recursive: true });
    }

    // Build workspace folders from the .upp file (includes nests)
    const folders = resolveWorkspaceFolders(uppFile, assembly.nests);

    // Read existing workspace file if present
    let wsJson: Record<string, any> = { folders: [], settings: {} };
    if (fs.existsSync(wsPath)) {
      try {
        wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      } catch { /* ignore corrupt file — will overwrite */ }
    }

    // Replace folders with the resolved ones (deduplicate by resolved path)
    const seen = new Set<string>();
    wsJson.folders = [];
    for (const dir of folders) {
      const resolved = path.resolve(dir);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        wsJson.folders.push({ path: dir });
      }
    }

    // Write settings into the workspace file
    wsJson.settings = wsJson.settings ?? {};
    wsJson.settings['upp.activeAssembly']    = assembly.filePath;
    wsJson.settings['upp.activeMainPackage'] = pkgName;
    if (buildParams) {
      wsJson.settings['upp.buildMethod']        = buildParams.buildMethod;
      wsJson.settings['upp.configurationFlag']  = buildParams.configurationFlag;
      wsJson.settings['upp.buildCommand']       = buildParams.buildCommand;
    } else if (!wsJson.settings['upp.buildMethod']) {
      const cfg = vscode.workspace.getConfiguration('upp');
      wsJson.settings['upp.buildMethod']        = cfg.get('buildMethod', '');
      wsJson.settings['upp.configurationFlag']  = cfg.get('configurationFlag', '');
      wsJson.settings['upp.buildCommand']       = cfg.get('buildCommand', '');
    }

    fs.writeFileSync(wsPath, JSON.stringify(wsJson, null, 2), 'utf8');
    return wsPath;
  } catch (err) {
    console.warn(`UPP: Failed to create/update workspace file: ${err}`);
    return undefined;
  }
}

// ─── Workspace Switching ─────────────────────────────────────────────────────

/**
 * Persist assembly/package selection and build params.
 *
 * Creates / updates a per-package .code-workspace file in
 * `upp.workspacesDir` (or next to the .var file) so that:
 *
 *  - Settings are properly isolated per package
 *  - File → Save Workspace (Ctrl+S) saves to the existing location
 *    instead of prompting for a save location each time
 *
 * The user is offered to switch to the new workspace file on first creation,
 * respecting `upp.autoPackageSwitchWorkspace`.
 */
export async function switchWorkspace(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  uppFile: string,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
): Promise<void> {
  await switchWorkspaceInner(assembly, pkgName, pkgDir, uppFile, buildParams);
}

async function switchWorkspaceInner(
  assembly: Assembly,
  pkgName: string,
  pkgDir: string,
  uppFile: string,
  buildParams?: { buildMethod: string; configurationFlag: string; buildCommand: string },
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('upp');

  // Detect whether the workspace file already exists (before we write to it)
  const currentWsFile  = vscode.workspace.workspaceFile;
  const wsPath         = getWorkspaceFilePath(assembly, pkgName);
  const wsFileExists   = fs.existsSync(wsPath);

  // Create/update the per-package workspace file
  const wsCreated = ensureWorkspaceFile(assembly, pkgName, pkgDir, uppFile, buildParams);

  // --- Decide whether we need to write to the current session's settings ---
  const correctWsOpen = !!wsCreated &&
    currentWsFile?.scheme === 'file' &&
    path.resolve(currentWsFile.fsPath) === path.resolve(wsPath);

  if (correctWsOpen) {
    // The package's own workspace file is already open — settings were
    // written there by ensureWorkspaceFile, nothing more to do.
  } else if (currentWsFile?.scheme === 'file') {
    // A different workspace file is open — write new package settings into
    // the current workspace file so they persist across sessions.
    try {
      const curWsJson = JSON.parse(fs.readFileSync(currentWsFile.fsPath, 'utf8'));
      curWsJson.settings = curWsJson.settings ?? {};
      curWsJson.settings['upp.activeAssembly']    = assembly.filePath;
      curWsJson.settings['upp.activeMainPackage'] = pkgName;
      if (buildParams) {
        curWsJson.settings['upp.buildMethod']       = buildParams.buildMethod;
        curWsJson.settings['upp.configurationFlag'] = buildParams.configurationFlag;
        curWsJson.settings['upp.buildCommand']      = buildParams.buildCommand;
      } else {
        curWsJson.settings['upp.buildMethod']       = cfg.get('buildMethod', '');
        curWsJson.settings['upp.configurationFlag'] = cfg.get('configurationFlag', '');
        curWsJson.settings['upp.buildCommand']      = cfg.get('buildCommand', '');
      }
      fs.writeFileSync(currentWsFile.fsPath, JSON.stringify(curWsJson, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  } else {
    // No workspace file at all — persist to .vscode/settings.json so the
    // current session works.
    await persistSetting('upp.activeAssembly', assembly.filePath, cfg);
    await persistSetting('upp.activeMainPackage', pkgName, cfg);
    if (buildParams) {
      await persistSetting('upp.buildMethod', buildParams.buildMethod, cfg);
      await persistSetting('upp.configurationFlag', buildParams.configurationFlag, cfg);
      await persistSetting('upp.buildCommand', buildParams.buildCommand, cfg);
    } else if (wsCreated) {
      // Read saved settings from the workspace file we just wrote
      try {
        const wsJson = JSON.parse(fs.readFileSync(wsCreated, 'utf8'));
        const wsSettings = wsJson.settings ?? {};
        const bm = wsSettings['upp.buildMethod'] ?? cfg.get<string>('buildMethod', '');
        const cf = wsSettings['upp.configurationFlag'] ?? cfg.get<string>('configurationFlag', '');
        const bc = wsSettings['upp.buildCommand'] ?? cfg.get<string>('buildCommand', '');
        if (bm) await persistSetting('upp.buildMethod', bm, cfg);
        if (cf) await persistSetting('upp.configurationFlag', cf, cfg);
        if (bc) await persistSetting('upp.buildCommand', bc, cfg);
      } catch {
        // fallback to current config
        const bm = cfg.get<string>('buildMethod', '');
        const cf = cfg.get<string>('configurationFlag', '');
        const bc = cfg.get<string>('buildCommand', '');
        if (bm) await persistSetting('upp.buildMethod', bm, cfg);
        if (cf) await persistSetting('upp.configurationFlag', cf, cfg);
        if (bc) await persistSetting('upp.buildCommand', bc, cfg);
      }
    }
  }

  // --- Offer to switch to the package's workspace file ---
  if (wsCreated && !correctWsOpen) {
    const autoSwitch = cfg.get<boolean>('autoPackageSwitchWorkspace', true);

    if (autoSwitch) {
      logWorkspaces(`Auto-switching to workspace: ${wsPath}`);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), false);
      return; // VSCode reloads the window — no more work to do
    }

    // Prompt only on first creation to avoid nagging
    if (!wsFileExists) {
      logWorkspaces(`Workspace file created: ${wsPath}`);
      const shouldSwitch = await vscode.window.showInformationMessage(
          `UPP: Workspace created for "${pkgName}". Switch?`,
          'Switch', 'Stay'
        ) === 'Switch';

      if (shouldSwitch) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), false);
        return;
      }
    }
  }

  // --- Switch workspace folder to the selected package's directory ---
  // (only reached when the user chose Stay or when no ws file was created)
  if (pkgDir && fs.existsSync(pkgDir)) {
    vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0,
      { uri: vscode.Uri.file(pkgDir) }
    );
  }
}

// ─── Workspace Sync & Logging ───────────────────────────────────────────────

export function getWorkspacesDir(): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  return expandHome(cfg.get<string>('workspacesDir') ?? '');
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
  const workspacesDir = expandHome(cfg.get<string>('workspacesDir') ?? '');
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
