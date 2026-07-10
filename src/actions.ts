import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { UmkAction, runUmk } from './umkRunner';
import * as path from 'path';
import {
  activeAssembly, activeMainPackage, activeInstallation, outputChannel,
  setIsRunning, setActiveRunProcess, setActiveRunTerminal, updateStatusBar,
} from './state';
import { selectAssembly } from './panels';
import { resolveDebugOutputDir, resolveBinaryPath, resolveOutputDir } from './outputDir';
import { resolveUmkPath } from './utils';
import { effectiveBuildFlags } from './buildCommand';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function ensureActiveAssembly(): Promise<boolean> {
  if (activeAssembly && activeMainPackage) return true;
  await selectAssembly();
  return !!(activeAssembly && activeMainPackage);
}

// ─── Run in XDG Terminal ─────────────────────────────────────────────────────

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function parseEnv(envStr: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!envStr.trim()) return env;
  for (const line of envStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      env[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
    }
  }
  return env;
}

export function getDefaultTerminal(): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const custom: string = cfg.get('terminalApp', '');
  if (custom) return custom;
  if (process.platform === 'win32') {
    try {
      const r = require('child_process').execSync('where wt 2>nul', { encoding: 'utf8' }).trim().split('\n')[0];
      if (r && fs.existsSync(r)) return r;
    } catch { /* not found */ }
    try {
      const r = require('child_process').execSync('where pwsh 2>nul', { encoding: 'utf8' }).trim().split('\n')[0];
      if (r && fs.existsSync(r)) return r;
    } catch { /* not found */ }
    try {
      const r = require('child_process').execSync('where powershell 2>nul', { encoding: 'utf8' }).trim().split('\n')[0];
      if (r && fs.existsSync(r)) return r;
    } catch { /* not found */ }
    return process.env.COMSPEC || 'cmd.exe';
  }
  if (process.env.TERMINAL) return process.env.TERMINAL;
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM;
  const de = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() || '';
  // GNOME
  if (de.includes('gnome') || de.includes('unity') || de.includes('cinnamon') || de.includes('mate') || de.includes('budgie')) {
    try {
      const r = require('child_process').execSync('gsettings get org.gnome.desktop.default-applications.terminal exec 2>/dev/null', { encoding: 'utf8' }).trim();
      if (r && r !== "''" && r !== '""') return r.replace(/^['"]|['"]$/g, '');
    } catch { /* ignore */ }
  }
  // KDE Plasma
  if (de.includes('kde')) {
    try {
      const r = require('child_process').execSync('kreadconfig5 --file kdeglobals --group General --key TerminalApplication 2>/dev/null', { encoding: 'utf8' }).trim();
      if (r) return r;
    } catch { /* ignore */ }
    try {
      const fs = require('fs');
      const os = require('os');
      const kdeConf = os.homedir() + '/.config/kdeglobals';
      if (fs.existsSync(kdeConf)) {
        const content = fs.readFileSync(kdeConf, 'utf8');
        const match = content.match(/TerminalApplication\s*=\s*(\S+)/);
        if (match) return match[1];
      }
    } catch { /* ignore */ }
  }
  // Hyprland
  if (de.includes('hyprland')) {
    try {
      const fs = require('fs');
      const os = require('os');
      const hyprDir = os.homedir() + '/.config/hypr/';
      const files = fs.readdirSync(hyprDir).filter((f: string) => f.endsWith('.conf'));
      for (const f of files) {
        const content = fs.readFileSync(hyprDir + f, 'utf8');
        const match = content.match(/^\$terminal\s*=\s*(\S+)/m);
        if (match && match[1] !== '$terminal') return match[1];
      }
    } catch { /* ignore */ }
  }
  // Debian/Ubuntu alternatives
  try {
    const r = require('child_process').execSync('readlink -f /etc/alternatives/x-terminal-emulator 2>/dev/null', { encoding: 'utf8' }).trim();
    if (r) return require('path').basename(r);
  } catch { /* ignore */ }
  // XDG desktop entry
  try {
    const r = require('child_process').execSync('xdg-mime query default x-scheme-handler/terminal 2>/dev/null', { encoding: 'utf8' }).trim();
    if (r) return r.replace(/\.desktop$/, '');
  } catch { /* ignore */ }
  // XDG settings
  try {
    const r = require('child_process').execSync('xdg-settings get default-terminal-emulator 2>/dev/null', { encoding: 'utf8' }).trim();
    if (r) return r;
  } catch { /* ignore */ }
  return 'xterm';
}

/**
 * Whether to run programs in VS Code's integrated terminal instead of an
 * external X11 emulator. True when the user opts in, or (when unset) when
 * running headless / remote where no display server is available.
 */
export function shouldUseIntegratedTerminal(cfg: vscode.WorkspaceConfiguration): boolean {
  const explicit: boolean | undefined = cfg.get('useIntegratedTerminal');
  if (typeof explicit === 'boolean') return explicit;
  if (process.platform === 'win32') return false;
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (hasDisplay) return false;
  const tp = (process.env.TERM_PROGRAM || '').toLowerCase();
  return tp === 'vscode' || tp === 'code-server' || tp === 'vscode-insiders';
}

/** Check whether a process with the given image/comm name is currently running. */
function isProcessAlive(binName: string): boolean {
  const { execSync } = require('child_process');
  if (process.platform === 'win32') {
    const out = execSync(
      `tasklist /FI "IMAGENAME eq ${binName}" /FO CSV /NH`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return out.includes(binName);
  }
  try {
    execSync(`pgrep -x "${binName}"`, { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function runInTerminal(umkPath: string, args: string[], cwd: string, env: Record<string, string>, openTerminal: boolean) {
  const cfg = vscode.workspace.getConfiguration('upp');
  const term = getDefaultTerminal();
  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (activeInstallation?.path) {
    mergedEnv.UPP = activeInstallation.path;
  }

  if (process.platform === 'win32' || shouldUseIntegratedTerminal(cfg)) {
    // Use VS Code's integrated terminal — avoids all cmd.exe quoting issues
    // and lets the user select/copy output directly.
    const cmdLine = [umkPath, ...args].join(' ');
    const terminal = vscode.window.createTerminal({
      name: 'UPP Run',
      cwd: cwd || undefined,
      env: mergedEnv as { [key: string]: string },
    });
    terminal.sendText(cmdLine);
    terminal.show();
    setActiveRunTerminal(terminal);
    setIsRunning(true);
    updateStatusBar();

    // Poll for process exit — VS Code terminals don't expose the child process,
    // so we check if the binary is still running via the platform task tool.
    const binName = path.basename(umkPath);
    const poll = setInterval(() => {
      try {
        const alive = isProcessAlive(binName);
        if (!alive) {
          clearInterval(poll);
          setIsRunning(false);
          updateStatusBar();
        }
      } catch {
        // query failed — assume process exited
        clearInterval(poll);
        setIsRunning(false);
        updateStatusBar();
      }
    }, 2000);

    // Stop polling if terminal is disposed
    const disposeListener = vscode.window.onDidCloseTerminal(t => {
      if (t === terminal) {
        clearInterval(poll);
        setIsRunning(false);
        updateStatusBar();
        disposeListener.dispose();
      }
    });

    return;
  }

  const cmd = [umkPath, ...args].map(a => shellEscape(a)).join(' ');
  const fullCmd = openTerminal
    ? `${cmd}; echo; echo "Process exited. Press enter to close..."; read`
    : cmd;

  const child = spawn(term, ['-e', `bash -c '${fullCmd.replace(/'/g, "'\\''")}'`], {
    cwd: cwd || undefined,
    env: mergedEnv,
    detached: true,
    stdio: 'ignore',
  });

  setActiveRunProcess(child);
  setIsRunning(true);
  updateStatusBar();

  child.on('exit', () => {
    setActiveRunProcess(undefined);
    setIsRunning(false);
    updateStatusBar();
  });

  child.on('error', (err) => {
    vscode.window.showErrorMessage(`UPP: Failed to launch terminal "${term}": ${err.message}`);
    setActiveRunProcess(undefined);
    setIsRunning(false);
    updateStatusBar();
  });

  child.unref();
}

// ─── Build / Run / Rebuild Action ────────────────────────────────────────────

export async function doAction(action: UmkAction) {
  if (!(await ensureActiveAssembly())) return;

  const cfg = vscode.workspace.getConfiguration('upp');
  const umkPath = resolveUmkPath(cfg, activeInstallation);

  const assemblyName = activeAssembly!.name;
  const mainPackage  = activeMainPackage!;
  const buildMethod  = cfg.get('buildMethod', 'CLANG');
  const flagArg      = effectiveBuildFlags(cfg);
  let   configurationFlag   = cfg.get('configurationFlag', '');
  const outPath      = cfg.get('outPath', '');
  const useTarget    = cfg.get('useTarget', false);
  const runArgs: string = cfg.get('runArgs', '');
  const guiMode      = cfg.get<'auto' | 'gui' | 'console'>('guiMode', 'auto');

  // Apply guiMode to configurationFlag
  if (guiMode === 'gui') {
    const flags = new Set(configurationFlag.split(',').filter(Boolean));
    flags.add('GUI');
    configurationFlag = [...flags].join(',');
  } else if (guiMode === 'console') {
    const flags = new Set(configurationFlag.split(',').filter(Boolean));
    flags.delete('GUI');
    configurationFlag = [...flags].join(',');
  }

  // Run via XDG terminal so we can detect process exit
  if (action === 'run') {
    let runCwd: string = cfg.get('runCwd', '');
    if (!runCwd) {
      const resolved = resolveDebugOutputDir(activeInstallation, activeAssembly, activeMainPackage);
      runCwd = fs.existsSync(resolved) ? resolved : '';
    }
    const runEnv: string = cfg.get('runEnv', '');
    const outputConsole: string = cfg.get('outputConsole', 'auto');
    const openTerminal = outputConsole !== 'never';

    if (process.platform === 'win32') {
      // Windows: run the compiled binary directly (umk + "!" doesn't work reliably)
      const binaryPath = resolveBinaryPath(activeInstallation, activeAssembly, activeMainPackage, buildMethod, flagArg);
      if (!binaryPath || !fs.existsSync(binaryPath)) {
        vscode.window.showErrorMessage(`UPP: Binary not found at "${binaryPath}". Build the project first.`);
        return;
      }
      if (!runCwd || !fs.existsSync(runCwd)) {
        runCwd = path.dirname(binaryPath);
      }
      const runArgsArr = runArgs ? runArgs.split(/\s+/).filter(Boolean) : [];
      runInTerminal(binaryPath, runArgsArr, runCwd, parseEnv(runEnv), openTerminal);
    } else {
      // Unix: umk with "!" builds if needed then runs
      const args = [assemblyName, mainPackage];
      if (buildMethod) args.push(buildMethod);
      if (flagArg)    args.push(`-${flagArg}`);
      if (useTarget)  args.push('-u');
      if (configurationFlag) args.push(`+${configurationFlag}`);
      if (outPath)    args.push(outPath);
      args.push('!');
      if (runArgs)    args.push(...runArgs.split(/\s+/).filter(Boolean));
      runInTerminal(umkPath, args, runCwd, parseEnv(runEnv), openTerminal);
    }
    return;
  }

  const showBuildOutput: 'always' | 'auto' | 'never' = 'always';

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `UPP: ${action}`,
    cancellable: false,
  }, async (progress) => {
    progress.report({ message: `Running umk ${action}...` });
    try {
      await runUmk({
        umkPath,
        assemblyName,
        mainPackage,
        buildMethod,
        buildFlags: flagArg,
        configurationFlag,
        outPath,
        useTarget,
        action,
        outputChannel,
        showOutput: showBuildOutput,
        uppEnv: activeInstallation?.path,
      });
      progress.report({ increment: 100, message: 'Done' });
    } catch (err: any) {
      vscode.window.showErrorMessage(`UPP ${action} failed: ${err.message}`);
    }
  });
}

// ─── Clean Build Output ─────────────────────────────────────────────────────

export async function cleanBuildOutput() {
  if (!activeAssembly || !activeMainPackage) {
    vscode.window.showWarningMessage('UPP: No active assembly/package selected.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('upp');
  const outputDir = resolveOutputDir(activeInstallation, activeAssembly, activeMainPackage);

  if (!fs.existsSync(outputDir)) {
    vscode.window.showInformationMessage(`UPP: Output directory already clean: ${outputDir}`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `UPP: Delete build output in "${outputDir}"?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  try {
    fs.rmSync(outputDir, { recursive: true, force: true });
    vscode.window.showInformationMessage(`UPP: Build output cleaned: ${outputDir}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`UPP: Failed to clean output: ${err.message}`);
  }
}
