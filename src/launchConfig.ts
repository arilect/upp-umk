import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Assembly } from './assemblyParser';
import { resolveBinaryPath } from './outputDir';
import { UppInstallation } from './installations';
import { showDebugAdapterPanel } from './debugAdapterPanel';

function resolveDebuggerPath(
  installation: UppInstallation | undefined,
  buildMethod: string,
): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const custom = cfg.get<string>('debuggerPath', '');
  if (custom) return custom;

  const { parseBmFile, findBuildMethods } = require('./assemblyParser') as typeof import('./assemblyParser');
  const varDir = cfg.get<string>('varDir', '');
  const bms = findBuildMethods(varDir);
  const bm = bms.find((b: any) => b.name === buildMethod || b.filePath === buildMethod);
  if (bm) {
    const data = parseBmFile(bm.filePath);
    const dbgName = data.DEBUGGER || 'gdb';
    if (path.isAbsolute(dbgName) && fs.existsSync(dbgName)) return dbgName;
    const bmDir = path.dirname(bm.filePath);
    const searchPaths = [bmDir];
    if (data.PATH) {
      data.PATH.split(';').filter(Boolean).forEach((p: string) => searchPaths.push(p));
    }
    if (installation?.path) {
      searchPaths.push(path.join(installation.path, 'bin', 'clang', 'bin'));
      searchPaths.push(path.join(installation.path, 'bin', 'clang', 'x86_64-w64-mingw32', 'bin'));
    }
    for (const dir of searchPaths) {
      const exe = path.join(dir, dbgName + (process.platform === 'win32' ? '.exe' : ''));
      if (fs.existsSync(exe)) return exe;
      if (process.platform === 'win32') {
        const lldbMi = path.join(dir, 'lldb-mi.exe');
        if (fs.existsSync(lldbMi)) return lldbMi;
      }
    }
  }
  return process.platform === 'win32' ? 'lldb-mi' : 'gdb';
}

export async function updateLaunchJson(
  installation: UppInstallation | undefined,
  assembly: Assembly,
  mainPackage: string | undefined,
  workspaceRoot: string,
  buildFlags?: string,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('upp');
  if (!cfg.get<boolean>('autoLaunchJson', true)) return;

  const nativeDebug = vscode.extensions.getExtension('webfreak.debug');
  const cpptools = vscode.extensions.getExtension('ms-vscode.cpptools');
  if (!nativeDebug && !cpptools) {
    showDebugAdapterPanel();
    return;
  }

  const buildMethod = cfg.get<string>('buildMethod', 'CLANG');
  const runArgs: string = cfg.get('runArgs', '');
  const binaryPath = resolveBinaryPath(installation, assembly, mainPackage, buildMethod, buildFlags);
  const debuggerPath = resolveDebuggerPath(installation, buildMethod);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.fsPath ?? workspaceRoot;

  let launchConfig: any;
  if (nativeDebug) {
    launchConfig = {
      name: 'UPP: Debug',
      type: 'gdb',
      request: 'launch',
      target: binaryPath,
      cwd,
      arguments: runArgs || undefined,
      gdbpath: debuggerPath,
    };
  } else {
    const args = runArgs ? runArgs.split(/\s+/).filter(Boolean) : [];
    launchConfig = {
      name: 'UPP: Debug',
      type: 'cppdbg',
      request: 'launch',
      program: binaryPath,
      args,
      stopAtEntry: false,
      cwd,
      environment: [],
      externalConsole: false,
      MIMode: 'gdb',
      miDebuggerPath: debuggerPath,
      setupCommands: [
        { text: '-enable-pretty-printing', description: 'Enable pretty printing', ignoreFailures: true },
      ],
    };
  }

  const vscodeDir = path.join(workspaceRoot, '.vscode');
  const launchJsonPath = path.join(vscodeDir, 'launch.json');
  const launchJson = {
    version: '0.2.0',
    configurations: [launchConfig],
  };

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }
  fs.writeFileSync(launchJsonPath, JSON.stringify(launchJson, null, 4) + '\n', 'utf8');
}
