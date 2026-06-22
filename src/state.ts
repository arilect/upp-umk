import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Assembly, parseAssembly, parseUppFile } from './assemblyParser';
import { UppStateProvider } from './sidebarProvider';
import { resolveOutputDir, resolveDebugOutputDir } from './outputDir';

// ─── State ───────────────────────────────────────────────────────────────────

export let outputChannel: vscode.OutputChannel;
export let activeAssembly: Assembly | undefined;
export let activeMainPackage: string | undefined;
export let activePackageDescription: string | undefined;
export let activePackageUppFile: string | undefined;
export let statusBarItem: vscode.StatusBarItem;
export let stateProvider: UppStateProvider;
export let stateTreeView: vscode.TreeView<unknown>;
export let activeRunProcess: cp.ChildProcess | undefined;
export let isRunning = false;
export let isDebugging = false;
export let debugTerminal: vscode.Terminal | undefined;

export function getActiveState(): { assName: string; mainPkg: string } | undefined {
  if (!activeAssembly || !activeMainPackage) return undefined;
  return { assName: activeAssembly.name, mainPkg: activeMainPackage };
}

export function setActiveAssembly(ass: Assembly | undefined) { activeAssembly = ass; }
export function setActiveMainPackage(pkg: string | undefined) { activeMainPackage = pkg; }
export function setActivePackageDescription(desc: string | undefined) { activePackageDescription = desc; }
export function setActivePackageUppFile(f: string | undefined) { activePackageUppFile = f; }
export function setOutputChannel(ch: vscode.OutputChannel) { outputChannel = ch; }
export function setStatusBarItem(sb: vscode.StatusBarItem) { statusBarItem = sb; }
export function setStateProvider(sp: UppStateProvider) { stateProvider = sp; }
export function setStateTreeView(tv: vscode.TreeView<unknown>) { stateTreeView = tv; }
export function setActiveRunProcess(p: cp.ChildProcess | undefined) { activeRunProcess = p; }
export function setIsRunning(v: boolean) { isRunning = v; }
export function setIsDebugging(v: boolean) { isDebugging = v; }
export function setDebugTerminal(t: vscode.Terminal | undefined) { debugTerminal = t; }

// ─── Status Bar ──────────────────────────────────────────────────────────────

export function updateStatusBar() {
  if (activeAssembly && activeMainPackage) {
    const anim = isRunning ? '~spin ' : '';
    statusBarItem.text = `$(${anim}tools) ${activeAssembly.name} / ${path.basename(activeMainPackage)}`;
    statusBarItem.tooltip =
      `Active U++ assembly: ${activeAssembly.name}\n` +
      `.var: ${path.basename(activeAssembly.filePath)}\n` +
      `Main package: ${activeMainPackage}\n` +
      `Click to change`;
  } else {
    statusBarItem.text = `$(tools) UPP: no assembly`;
    statusBarItem.tooltip = 'Click to select a U++ assembly';
  }
  statusBarItem.show();
  const cfg = vscode.workspace.getConfiguration('upp');
  const outputDirPath = activeAssembly && activeMainPackage ? resolveOutputDir(activeMainPackage) : undefined;
  const debugOutputDirPath = activeAssembly && activeMainPackage ? resolveDebugOutputDir(activeAssembly.name, activeMainPackage) : undefined;
  const debugCmdText = cfg.get<string>('debugCommand', '');
  stateProvider?.refresh(activeAssembly, activeMainPackage, isRunning, activePackageDescription, activePackageUppFile, isDebugging, outputDirPath, debugOutputDirPath, debugCmdText);
}

// ─── Restore Persisted State ─────────────────────────────────────────────────

export function restoreState() {
  let savedAssPath = '';
  let savedPkg     = '';

  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile?.scheme === 'file') {
    try {
      const wsJson = JSON.parse(fs.readFileSync(wsFile.fsPath, 'utf8'));
      savedAssPath = wsJson.settings?.['upp.activeAssembly']    ?? '';
      savedPkg     = wsJson.settings?.['upp.activeMainPackage'] ?? '';
    } catch { /* file unreadable — state cleared below */ }
  } else {
    const cfg = vscode.workspace.getConfiguration('upp');
    const assInfo = cfg.inspect<string>('activeAssembly');
    const pkgInfo = cfg.inspect<string>('activeMainPackage');
    savedAssPath = assInfo?.workspaceFolderValue ?? assInfo?.workspaceValue ?? '';
    savedPkg     = pkgInfo?.workspaceFolderValue ?? pkgInfo?.workspaceValue ?? '';
  }

  if (savedAssPath && savedPkg) {
    try {
      activeAssembly    = parseAssembly(savedAssPath);
      activeMainPackage = savedPkg;
      activePackageDescription = undefined;
      activePackageUppFile = undefined;
      if (activeAssembly.nests.length > 0) {
        const pkgLeaf = path.basename(savedPkg);
        for (const nest of activeAssembly.nests) {
          const candidate = path.join(nest, savedPkg.replace(/\//g, path.sep));
          if (fs.existsSync(candidate)) {
            const uppPath = path.join(candidate, `${pkgLeaf}.upp`);
            if (fs.existsSync(uppPath)) {
              const meta = parseUppFile(uppPath);
              activePackageDescription = meta.description;
              activePackageUppFile = uppPath;
            }
            break;
          }
        }
      }
      if (!activePackageUppFile) {
        vscode.window.showWarningMessage(
          `UPP: Package "${savedPkg}" not found in assembly "${activeAssembly.name}". ` +
          `Use "UPP: Select Active Assembly" to pick a valid package.`
        );
        activeAssembly    = undefined;
        activeMainPackage = undefined;
      }
    } catch {
      activeAssembly    = undefined;
      activeMainPackage = undefined;
      activePackageDescription = undefined;
      activePackageUppFile = undefined;
    }
  } else {
    activeAssembly    = undefined;
    activeMainPackage = undefined;
    activePackageDescription = undefined;
    activePackageUppFile = undefined;
  }
}
