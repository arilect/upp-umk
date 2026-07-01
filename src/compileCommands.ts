import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  Assembly,
  resolveWorkspaceFolders,
} from './assemblyParser';
import { updateWorkspaceFile, persistSetting, resolveUmkPath } from './utils';
import { activeInstallation } from './state';

// ─── Parse editable command string ────────────────────────────────────────────

export interface ParsedCompileCommand {
  umkPath: string;
  assemblyName: string;
  packageName: string;    // template package name from the stored command
  buildMethod: string;
  configurationFlag: string;
}

/**
 * Parse the editable `upp.generateCompileCommands` string.
 *
 * Expected format:
 *   umk <assembly> <package> <method> -j [+configurationFlag]
 *
 * Returns null if the string is empty or malformed.
 */
export function parseCompileCommandsCommand(cmd: string): ParsedCompileCommand | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);

  // Drop leading executable (umk / umk.exe / full path)
  const firstIsExec = tokens.length > 0 &&
    (path.basename(tokens[0]) === 'umk' || path.basename(tokens[0]) === 'umk.exe');
  const parts = firstIsExec ? tokens.slice(1) : tokens;

  if (parts.length < 3) return null;

  const assemblyName = parts[0];
  const packageName  = parts[1];
  const buildMethod  = parts[2];

  // Find +flags token
  const extraFlagToken = parts.find(p => p.startsWith('+'));
  const configurationFlag = extraFlagToken ? extraFlagToken.slice(1) : '';

  return {
    umkPath: firstIsExec ? tokens[0] : 'umk',
    assemblyName,
    packageName,
    buildMethod,
    configurationFlag,
  };
}

// ─── Sync / auto-generate the editable command string ─────────────────────────

/**
 * Construct the compile_commands.json generation command from current settings
 * and write it to `upp.generateCompileCommands` (workspace or global).
 *
 * Mirrors the existing `syncBuildCommand()` pattern.
 */
export async function syncCompileCommandsCommand(
  assembly: Assembly,
  mainPackage: string,
  cfg: vscode.WorkspaceConfiguration,
): Promise<void> {
  const umkPath     = resolveUmkPath(cfg, activeInstallation);
  const buildMethod = cfg.get('buildMethod', 'CLANG');
  const configurationFlag  = cfg.get('configurationFlag', '');

  const parts = [umkPath, assembly.name, mainPackage, buildMethod, '-j'];
  if (configurationFlag) parts.push(`+${configurationFlag}`);
  const cmd = parts.filter(Boolean).join(' ');

  // Skip if already up to date
  if (cfg.get<string>('generateCompileCommands', '') === cmd) return;

  await persistSetting('upp.generateCompileCommands', cmd, cfg);
}

// ─── Generation ───────────────────────────────────────────────────────────────

/**
 * Generate compile_commands.json for every package in the dependency tree
 * of the active package, using umk's `-j` flag.
 *
 * Each package directory gets its own compile_commands.json file.
 * The correct assembly name is resolved per-package by checking all .var files.
 *
 * @returns list of package dirs that were processed
 */
export async function generateCompileCommands(
  assembly: Assembly,
  mainPackage: string,
  buildMethod: string,
  configurationFlag: string,
  outputChannel: vscode.OutputChannel,
  umkPath: string = 'umk',
): Promise<string[]> {
  // Resolve the main package's .upp file to walk the dependency tree
  const pkgDir = resolvePkgDir(assembly, mainPackage);
  if (!pkgDir) {
    outputChannel.appendLine(`✗ Cannot find directory for package "${mainPackage}"`);
    return [];
  }

  const leaf = path.basename(pkgDir);
  const uppFile = path.join(pkgDir, `${leaf}.upp`);
  const packageDirs = resolveWorkspaceFolders(uppFile, assembly.nests);

  outputChannel.appendLine('');
  outputChannel.appendLine(`► Generating compile_commands.json (${packageDirs.length} packages)`);
  outputChannel.appendLine('─'.repeat(72));

  const processed: string[] = [];

  for (const dir of packageDirs) {
    if (!fs.existsSync(dir)) continue;

    // Derive package name from directory relative to nest
    const pkgName = derivePackageName(dir, assembly.nests);

    // Find the correct assembly for THIS package based on which nest it belongs to
    const pkgAssembly = assembly.name;

    const args = [pkgAssembly, pkgName, buildMethod, '-j'];
    if (configurationFlag) args.push(`+${configurationFlag}`);

    const cmd = `${umkPath} ${args.join(' ')}`;
    outputChannel.appendLine(`  [${pkgAssembly}] ${cmd}`);

    try {
      // IMPORTANT: umk -j writes compile_commands.json to the current directory,
      // so we must cd to the package directory first
      await runUmkOnce(umkPath, args, outputChannel, { cwd: dir });
      processed.push(dir);
      const ccPath = path.join(dir, 'compile_commands.json');
      if (fs.existsSync(ccPath)) {
        outputChannel.appendLine(`  ✓ ${ccPath} (${fs.statSync(ccPath).size} bytes)`);
      } else {
        outputChannel.appendLine(`  ✗ ${ccPath} NOT created`);
      }
    } catch {
      outputChannel.appendLine(`  ✗ Failed for ${pkgName}`);
    }
  }

  outputChannel.appendLine('');
  outputChannel.appendLine(`✓ compile_commands.json written to ${processed.length} package dirs`);

  // Strip header-file entries so clangd analyses headers in context rather than
  // as isolated TUs (which causes "Unknown type name" false errors in U++ code).
  const HEADER_EXTS = new Set(['.h', '.hpp', '.hxx', '.hh', '.inl']);
  let totalRemoved = 0;
  for (const dir of processed) {
    const ccPath = path.join(dir, 'compile_commands.json');
    try {
      // umk emits JSON with a trailing comma before the closing ']' — strip it
      // before parsing since JSON.parse rejects trailing commas.
      const raw = fs.readFileSync(ccPath, 'utf8').replace(/,(\s*])/g, '$1');
      const entries: { file: string; [k: string]: unknown }[] = JSON.parse(raw);
      const filtered = entries.filter(e => !HEADER_EXTS.has(path.extname(e.file).toLowerCase()));
      const removed = entries.length - filtered.length;
      if (removed > 0) {
        fs.writeFileSync(ccPath, JSON.stringify(filtered, null, '\t'), 'utf8');
        totalRemoved += removed;
      }
    } catch { /* skip unreadable files */ }

    // Ensure compile_commands.json is in .gitignore
    const gitignorePath = path.join(dir, '.gitignore');
    const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignoreContent.includes('compile_commands.json')) {
      fs.appendFileSync(gitignorePath, '\n# Generated by umk -j\ncompile_commands.json\n', 'utf8');
    }
  }
  outputChannel.appendLine(
    totalRemoved > 0
      ? `  clangd: stripped ${totalRemoved} header entries from compile_commands.json files`
      : `  clangd: no header entries to strip`
  );

  return processed;
}

/**
 * Find the directory for a package name within the assembly's nests.
 */
function resolvePkgDir(assembly: Assembly, mainPackage: string): string | undefined {
  for (const nest of assembly.nests) {
    const candidate = path.join(nest, mainPackage.replace(/\//g, path.sep));
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Derive a package name (for umk) from a directory path by finding which nest
 * it lives under.
 *
 * e.g. nest="/home/user/uppsrc", dir="/home/user/uppsrc/Core" → "Core"
 *      nest="/home/user/uppsrc", dir="/home/user/uppsrc/CtrlLib/Core" → "CtrlLib/Core"
 */
function derivePackageName(dir: string, nests: string[]): string {
  const sep = path.sep;
  for (const nest of nests) {
    if (dir.startsWith(nest + sep) || dir === nest) {
      return dir.slice(nest.length + 1).replace(/\\/g, '/');
    }
  }
  return path.basename(dir);
}

interface RunUmkOptions {
  cwd?: string;
}

function runUmkOnce(umkPath: string, args: string[], outputChannel: vscode.OutputChannel, options?: RunUmkOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const proc = cp.spawn(umkPath, args, {
      env: process.env,
      shell: false,
      cwd: options?.cwd,
    });

    proc.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
    proc.stderr.on('data', (data: Buffer) => outputChannel.append(data.toString()));

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`umk exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      outputChannel.appendLine(`✗ Could not start umk: ${err.message}`);
      reject(err);
    });
  });
}

// ─── Watcher Management ──────────────────────────────────────────────────────

let compileCommandsWatcher: vscode.Disposable | undefined;

export function disposeCompileCommandsWatcher() {
  if (compileCommandsWatcher) {
    compileCommandsWatcher.dispose();
    compileCommandsWatcher = undefined;
  }
}

export function updateCompileCommandsWatcher(
  assembly: Assembly | undefined,
  mainPackage: string | undefined,
  outputChannel: vscode.OutputChannel,
) {
  disposeCompileCommandsWatcher();

  if (!assembly || !mainPackage) return;

  const cfg = vscode.workspace.getConfiguration('upp');
  const mode: string = cfg.get('compileCommandsMode', 'off');
  if (mode !== 'auto') return;

  const buildMethod = cfg.get('buildMethod', 'CLANG');
  const configurationFlag  = cfg.get('configurationFlag', '');
  const umkPath     = resolveUmkPath(cfg, activeInstallation);

  compileCommandsWatcher = createCompileCommandsWatcher(
    assembly,
    mainPackage,
    buildMethod,
    configurationFlag,
    outputChannel,
    umkPath,
    () => doCompileCommandsGeneration(assembly, mainPackage, outputChannel),
  );
}

export async function doCompileCommandsGeneration(
  assembly: Assembly,
  mainPackage: string,
  outputChannel: vscode.OutputChannel,
) {
  const cfg = vscode.workspace.getConfiguration('upp');
  const buildMethod = cfg.get('buildMethod', 'CLANG');
  const configurationFlag  = cfg.get('configurationFlag', '');
  const umkPath     = resolveUmkPath(cfg, activeInstallation);
  const buildFlags  = cfg.get('buildFlags', '');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'UPP: Generating compile_commands.json',
    cancellable: true,
  }, async (progress) => {
    progress.report({ message: 'Running umk...' });
    try {
      await generateCompileCommands(
        assembly,
        mainPackage,
        buildMethod,
        configurationFlag,
        outputChannel,
        umkPath,
      );
      progress.report({ message: 'Updating IntelliSense...' });
      // Lazy import to avoid circular dependency
      const { updateIntelliSense } = await import('./intelliSense');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (root) {
        await updateIntelliSense(assembly, root, mainPackage, buildFlags, outputChannel);
      }
      progress.report({ increment: 100, message: 'Done' });

      if (cfg.get('restartClangdAfterGenerate', true)) {
        const hasClangd = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
        if (hasClangd) {
          const choice = await vscode.window.showInformationMessage(
            'UPP: compile_commands.json generated. Reload window for clangd?',
            'Reload'
          );
          if (choice === 'Reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        }
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`UPP compile_commands.json generation failed: ${err.message}`);
    }
  });
}

// ─── File watcher ─────────────────────────────────────────────────────────────

export function createCompileCommandsWatcher(
  assembly: Assembly,
  mainPackage: string,
  buildMethod: string,
  configurationFlag: string,
  outputChannel: vscode.OutputChannel,
  umkPath: string = 'umk',
  onGenerate: () => void,  // called to re-trigger generation from extension.ts
): vscode.Disposable {
  const bag: vscode.Disposable[] = [];

  // Resolve the main package's .upp file
  const pkgDir = resolvePkgDir(assembly, mainPackage);
  if (!pkgDir) {
    return { dispose() {} };
  }

  const leaf = path.basename(pkgDir);
  const uppFile = path.join(pkgDir, `${leaf}.upp`);
  const packageDirs = resolveWorkspaceFolders(uppFile, assembly.nests);

  // Watch source files across all dependency package dirs
  // Escape glob-special characters in directory paths
  const escapeGlob = (p: string) => p.replace(/[\[\]\{\}\?\*]/g, '\\$&');
  const pattern = `{${packageDirs.map(escapeGlob).join(',')}}/**/*.{cpp,c,h,hpp,icpp}`;
  const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  bag.push(watcher);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRegenerate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      outputChannel.appendLine('');
      outputChannel.appendLine('⟳ Source files changed — regenerating compile_commands.json');
      onGenerate();
    }, 2000);
  }

  bag.push(watcher.onDidChange(scheduleRegenerate));
  bag.push(watcher.onDidCreate(scheduleRegenerate));
  bag.push(watcher.onDidDelete(scheduleRegenerate));

  outputChannel.appendLine(`🔍 Watching ${packageDirs.length} package dirs for source file changes`);

  return {
    dispose() {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const d of bag) d.dispose();
    },
  };
}
