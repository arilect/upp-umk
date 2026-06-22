import * as vscode from 'vscode';
import * as path from 'path';
import { findBuildMethods, parseMainConfigs } from './assemblyParser';
import { activeAssembly, activeMainPackage, updateStatusBar } from './state';
import { persistSetting, updateWorkspaceFile } from './utils';

// ─── Build Params Interface ──────────────────────────────────────────────────

export interface BuildParams {
  buildMethod: string;
  configurationFlag: string;
  buildCommand: string;
}

// ─── Build Command Helpers ───────────────────────────────────────────────────

/**
 * Strip s/S from buildFlags (link mode is controlled by upp.linkMode).
 */
function stripLinkFlags(flags: string): string {
  return flags.split('').filter(c => c !== 's' && c !== 'S').join('');
}

/**
 * Get the link mode flag from upp.linkMode setting.
 * Returns 's', 'S', or '' for static.
 */
function getLinkModeFlag(cfg: vscode.WorkspaceConfiguration): string {
  const mode: string = cfg.get('linkMode', 'use-shared');
  if (mode === 'use-shared') return 's';
  if (mode === 'all-shared') return 'S';
  return '';
}

/**
 * Get effective build flags with link mode injected and s/S stripped from raw flags.
 */
function effectiveBuildFlags(cfg: vscode.WorkspaceConfiguration): string {
  const raw: string = cfg.get('buildFlags', '');
  return stripLinkFlags(raw) + getLinkModeFlag(cfg);
}

/**
 * Construct the umk command line from current workspace settings.
 */
export function buildCommandLine(
  umkPath: string,
  assemblyName: string,
  mainPackage: string,
  buildMethod: string,
  configurationFlag: string,
  buildFlags: string,
  outPath: string,
): string {
  const parts = [umkPath, assemblyName, mainPackage, buildMethod];
  if (buildFlags) parts.push(`-${buildFlags}`);
  if (configurationFlag) parts.push(`+${configurationFlag}`);
  if (outPath) parts.push(outPath);
  return parts.filter(Boolean).join(' ');
}

/**
 * Construct the umk command line from current workspace settings.
 * This is what gets written to upp.buildCommand and also what doAction uses
 * unless the user has manually edited upp.buildCommand.
 */
export async function syncBuildCommand() {
  if (!activeAssembly || !activeMainPackage) return;
  const cfg = vscode.workspace.getConfiguration('upp');
  const umkPath = cfg.get('umkPath', 'umk');
  const assemblyName = activeAssembly.name;
  const mainPackage = activeMainPackage;
  const buildMethod = cfg.get('buildMethod', 'CLANG');
  const configurationFlag = cfg.get('configurationFlag', '');
  const buildFlags = effectiveBuildFlags(cfg);
  const outPath = cfg.get('outPath', '');

  const cmd = buildCommandLine(umkPath, assemblyName, mainPackage, buildMethod, configurationFlag, buildFlags, outPath);

  // Debug command: strip r and d from buildFlags (debug mode with symbols)
  const debugFlags = buildFlags.replace(/[rd]/g, '');
  const debugCmd = buildCommandLine(umkPath, assemblyName, mainPackage, buildMethod, configurationFlag, debugFlags, outPath);

  // Release command: ensure r is present
  const releaseFlags = buildFlags.includes('r') ? buildFlags : 'r' + buildFlags;
  const releaseCmd = buildCommandLine(umkPath, assemblyName, mainPackage, buildMethod, configurationFlag, releaseFlags, outPath);

  if (cfg.get<string>('buildCommand', '') === cmd &&
      cfg.get<string>('debugCommand', '') === debugCmd &&
      cfg.get<string>('releaseCommand', '') === releaseCmd) return;

  await persistSetting('upp.buildCommand', cmd, cfg);
  await persistSetting('upp.debugCommand', debugCmd, cfg);
  await persistSetting('upp.releaseCommand', releaseCmd, cfg);
}

// ─── Build Method Selection ──────────────────────────────────────────────────

export async function selectBuildMethod() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const varDir: string = cfg.get('varDir', '');
  const bms = findBuildMethods(varDir);
  let chosen: string | undefined;

  if (bms.length === 0) {
    chosen = await vscode.window.showInputBox({
      prompt: 'Build method name or path to .bm file',
      placeHolder: 'e.g. GCC, CLANG',
      value: cfg.get('buildMethod', 'CLANG'),
    });
    if (chosen === undefined) return;
    chosen = chosen.trim();
  } else {
    const current: string = cfg.get('buildMethod', '');
    const picked = await vscode.window.showQuickPick(
      bms.map(bm => ({ label: bm.name, description: bm.filePath, picked: bm.name === current || bm.filePath === current })),
      { placeHolder: 'Select build method' }
    );
    if (!picked) return;
    chosen = picked.label;
  }

  if (!chosen) return;

  const newCmd = buildCommandLine(
    cfg.get('umkPath', 'umk'),
    activeAssembly?.name ?? '',
    activeMainPackage ?? '',
    chosen,
    cfg.get('configurationFlag', ''),
    effectiveBuildFlags(cfg),
    cfg.get('outPath', ''),
  );

  updateWorkspaceFile(wsJson => {
    wsJson.settings['upp.buildMethod']  = chosen;
    wsJson.settings['upp.buildCommand'] = newCmd;
  });
  updateStatusBar();
}

// ─── Link Mode Selection ────────────────────────────────────────────────────

export async function selectLinkMode() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const current: string = cfg.get('linkMode', 'static');

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'All Static',      description: 'Link everything statically (default)', picked: current === 'all-static' },
      { label: 'Use Shared Libs', description: 'Use shared libraries (-s)',           picked: current === 'use-shared' },
      { label: 'All Shared',      description: 'Use shared and build as shared (-S)', picked: current === 'all-shared' },
    ],
    { placeHolder: 'Select link mode' }
  );
  if (!picked) return;

  const modeMap: Record<string, string> = { 'All Static': 'all-static', 'Use Shared Libs': 'use-shared', 'All Shared': 'all-shared' };
  const newMode = modeMap[picked.label];
  if (newMode === current) return;

  await cfg.update('linkMode', newMode, vscode.ConfigurationTarget.Workspace);
  await syncBuildCommand();
  updateStatusBar();
}

// ─── Output Type Selection (Debug / Release) ─────────────────────────────────

export async function selectOutput() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const currentFlags: string = effectiveBuildFlags(cfg);
  const isRelease = currentFlags.includes('r');

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Debug',   picked: !isRelease },
      { label: 'Release', picked: isRelease  },
    ],
    { placeHolder: 'Select output type' }
  );
  if (!picked) return;

  // Remove only the 'r' flag character, not other characters that happen to be 'r'
  const otherFlags = currentFlags.split('').filter(c => c !== 'r').join('');
  const newFlags   = picked.label === 'Release' ? 'r' + otherFlags : otherFlags;

  // Strip linkMode flags before saving back to buildFlags (linkMode is separate setting)
  const rawFlags = stripLinkFlags(newFlags);

  const newCmd = buildCommandLine(
    cfg.get('umkPath', 'umk'),
    activeAssembly?.name ?? '',
    activeMainPackage ?? '',
    cfg.get('buildMethod', 'CLANG'),
    cfg.get('configurationFlag', ''),
    newFlags,
    cfg.get('outPath', ''),
  );

  updateWorkspaceFile(wsJson => {
    wsJson.settings['upp.buildFlags']   = rawFlags;
    wsJson.settings['upp.buildCommand'] = newCmd;
  });
  updateStatusBar();
}

// ─── Build Params Selection ──────────────────────────────────────────────────

/**
 * Quick pick for build method (.bm) and mainconfig flags.
 * Saves choices into workspace settings so they persist and are used by
 * doAction() when invoking umk.
 */
export async function selectBuildParams(pkgDir: string): Promise<BuildParams | undefined> {
  const cfg = vscode.workspace.getConfiguration('upp');
  const varDir: string = cfg.get('varDir', '');

  // ── Build method ──
  const bms = findBuildMethods(varDir);
  let chosenBm: string | undefined;

  if (bms.length === 0) {
    chosenBm = await vscode.window.showInputBox({
      prompt: 'Build method name or path to .bm file',
      placeHolder: 'e.g. GCC, CLANG, or /path/to/Custom.bm',
      value: cfg.get('buildMethod', 'CLANG'),
    });
  } else {
    const current: string = cfg.get('buildMethod', '');
    const bmChoices = bms.map(bm => ({
      label: bm.name,
      description: bm.filePath,
      picked: bm.name === current || bm.filePath === current,
    }));
    const picked = await vscode.window.showQuickPick(bmChoices, {
      placeHolder: 'Select build method',
    });
    if (picked) chosenBm = picked.label;
  }

  if (!chosenBm) return undefined; // cancelled

  // ── Main config ──
  const pkgLeaf = path.basename(pkgDir);
  const uppFile = path.join(pkgDir, `${pkgLeaf}.upp`);
  const configs = parseMainConfigs(uppFile);
  let chosenConfig: string | undefined;

  if (configs.length === 0) {
    chosenConfig = await vscode.window.showInputBox({
      prompt: 'Compilation flags (optional, no mainconfig found in .upp)',
      placeHolder: 'e.g. GUI MT',
      value: cfg.get('configurationFlag', ''),
    });
    chosenConfig = chosenConfig?.trim() ?? '';
  } else {
    const current: string = cfg.get('configurationFlag', '');
    const cfgChoices = configs.map(c => ({
      label: c,
      picked: c === current,
    }));
    const picked = await vscode.window.showQuickPick(cfgChoices, {
      placeHolder: 'Select main configuration',
    });
    if (picked) chosenConfig = picked.label;
  }

  // mainconfig flags are space-separated in .upp but umk wants comma-separated +FLAGS
  const configurationFlag = (chosenConfig ?? '').replace(/\s+/g, ',').replace(/,+/g, ',');

  const buildCommand = buildCommandLine(
    cfg.get('umkPath', 'umk'),
    activeAssembly!.name,
    activeMainPackage!,
    chosenBm,
    configurationFlag,
    effectiveBuildFlags(cfg),
    cfg.get('outPath', ''),
  );

  return { buildMethod: chosenBm, configurationFlag, buildCommand };
}
