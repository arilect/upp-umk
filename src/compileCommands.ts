import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  Assembly,
  resolveWorkspaceFolders,
} from './assemblyParser';
import { updateWorkspaceFile, persistSetting, resolveUmkPath, resolveCppStandard } from './utils';
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
  // Also extract -D/-I/-std flags from the first .cpp entry for .clangd generation.
  const HEADER_EXTS = new Set(['.h', '.hpp', '.hxx', '.hh', '.inl']);
  let totalRemoved = 0;
  const extractedDefines = new Set<string>();
  const extractedIncludes = new Set<string>();
  let extractedStd = '';
  for (const dir of processed) {
    const ccPath = path.join(dir, 'compile_commands.json');
    try {
      // umk emits JSON with a trailing comma before the closing ']' — strip it
      // before parsing since JSON.parse rejects trailing commas.
      const raw = fs.readFileSync(ccPath, 'utf8').replace(/,(\s*])/g, '$1');
      const entries: { file: string; command?: string; [k: string]: unknown }[] = JSON.parse(raw);
      const filtered = entries.filter(e => !HEADER_EXTS.has(path.extname(e.file).toLowerCase()));
      const removed = entries.length - filtered.length;
      if (removed > 0) {
        fs.writeFileSync(ccPath, JSON.stringify(filtered, null, '\t'), 'utf8');
        totalRemoved += removed;
      }

      // Extract flags from the first .cpp entry's command string
      if (!extractedStd) {
        const cppEntry = entries.find(e => e.command && e.file?.endsWith('.cpp'));
        if (cppEntry?.command) {
          const cmd = cppEntry.command;
          for (const m of cmd.matchAll(/-D(\S+)/g)) extractedDefines.add(m[1]);
          for (const m of cmd.matchAll(/-I(\S+)/g)) extractedIncludes.add(m[1]);
          const stdMatch = cmd.match(/-std=(c\+\+\S+)/);
          if (stdMatch) extractedStd = stdMatch[1];
        }
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

  // Generate .clangd configuration files in each package directory
  const extractedFlags = {
    defines: Array.from(extractedDefines),
    includes: Array.from(extractedIncludes),
    std: extractedStd,
  };
  const preamblePath = await generateClangdConfig(assembly, buildMethod, processed, extractedFlags, outputChannel);

  // Inject -include <preamble> into every compile_commands.json entry so clangd
  // always has U++ types available — even when it resolves headers via the
  // compile database instead of .clangd.
  if (preamblePath) {
    let patched = 0;
    for (const dir of processed) {
      const ccPath = path.join(dir, 'compile_commands.json');
      try {
        const raw = fs.readFileSync(ccPath, 'utf8').replace(/,(\s*])/g, '$1');
        const entries: { file: string; command?: string; [k: string]: unknown }[] = JSON.parse(raw);
        const includeFlag = `-include ${preamblePath}`;
        let changed = false;
        for (const entry of entries) {
          if (entry.command && !entry.command.includes(includeFlag)) {
            entry.command = entry.command.replace(
              'clang++ ',
              `clang++ ${includeFlag} `
            );
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(ccPath, JSON.stringify(entries, null, '\t'), 'utf8');
          patched++;
        }
      } catch { /* skip */ }
    }
    if (patched > 0) {
      outputChannel.appendLine(`  clangd: injected preamble -include into ${patched} compile_commands.json files`);
    }
  }

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

// ─── .clangd Configuration ────────────────────────────────────────────────────

interface ExtractedFlags {
  defines: string[];
  includes: string[];
  std: string;
}

/**
 * Generate .clangd configuration files in each package directory.
 * Flags are extracted from the actual compile_commands.json entries produced
 * by umk, so the .clangd matches the real build configuration exactly.
 *
 * A preamble header (upp-clangd-preamble.h) is written to the workspace root.
 * It includes Core/Core.h and brings the Upp namespace into global scope,
 * so U++ headers like Value.h work when opened directly in the editor.
 */
async function generateClangdConfig(
  assembly: Assembly,
  buildMethod: string,
  processedDirs: string[],
  extractedFlags: ExtractedFlags,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  if (processedDirs.length === 0) return undefined;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!root) return;

  // Use extracted std if available, otherwise fall back to resolveCppStandard
  let stdFlag: string;
  if (extractedFlags.std) {
    stdFlag = `-std=${extractedFlags.std}`;
  } else {
    const cfg = vscode.workspace.getConfiguration('upp');
    const varDir = cfg.get<string>('varDir', '');
    stdFlag = `-std=${resolveCppStandard(buildMethod, varDir, cfg)}`;
  }

  // Write preamble header: includes Core/Core.h and brings Upp:: into global scope.
  // This lets clangd resolve U++ types (dword, String, Value, etc.) when opening
  // headers directly — U++ headers are not self-contained and expect namespace Upp.
  // Placed in uppsrc root so it's accessible from any nest directory.
  const uppSrcPath = extractedFlags.includes.find(p => p.endsWith('/uppsrc'));
  const preambleDir = uppSrcPath || root;
  const preamblePath = path.join(preambleDir, 'upp-clangd-preamble.h');
  const preambleContent = `// Auto-generated by U++ extension — do not edit
#include "Core/Core.h"
using namespace Upp;
`;
  try {
    fs.writeFileSync(preamblePath, preambleContent, 'utf8');
  } catch { /* skip */ }

  const dFlags = extractedFlags.defines.map(d => `    "-D${d}"`).join(',\n');
  const iPaths = extractedFlags.includes.map(p => `    "-I${p}"`).join(',\n');

  // U++ framework headers (under uppsrc/) are not self-contained — they rely on
  // being compiled inside namespace Upp { } with specific include ordering.
  // clangd can't replicate theide's per-file include trick, so diagnostics for
  // framework headers are all false positives. User project code keeps full diagnostics.
  const clangdBase = `CompileFlags:
  Add: [
    "${stdFlag}",
    "-x", "c++",
    "-include", "${preamblePath}",
${dFlags},
${iPaths}
  ]`;

  // Read the user-configurable suppression list from settings.
  const cfg = vscode.workspace.getConfiguration('upp');
  const suppressList = cfg.get<string[]>('clangdSuppress', [
    'ambiguous_reference', 'ovl_ambiguous_call', 'access',
    'access_field_ctor', 'undeclared_var_use_suggest', 'unknown_type_leading_errors',
  ]);
  const suppressItems = suppressList.map(d => `    - "${d}"`).join('\n');
  const clangdFramework = `
Diagnostics:
  Suppress:
${suppressItems}
`;

  let written = 0;
  for (const dir of processedDirs) {
    try {
      const isFramework = dir.replace(/\\/g, '/').includes('/uppsrc/');
      fs.writeFileSync(path.join(dir, '.clangd'), clangdBase + (isFramework ? clangdFramework : '\n'), 'utf8');
      written++;
    } catch { /* skip */ }
  }

  // Also write .clangd to each assembly nest so U++ headers opened directly
  // (e.g. Core/Value.h) pick up the preamble and flags.
  // clangd discovers .clangd by walking UP from the file, not from the workspace root.
  // Nest dirs are always framework dirs.
  let nestsWritten = 0;
  for (const nest of assembly.nests) {
    if (processedDirs.includes(nest)) continue; // already has .clangd
    try {
      fs.writeFileSync(path.join(nest, '.clangd'), clangdBase + clangdFramework, 'utf8');
      nestsWritten++;
    } catch { /* skip */ }
  }

  outputChannel.appendLine(`  clangd: wrote .clangd to ${written} package dirs + ${nestsWritten} nest dirs`);
  return preamblePath;
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
      const { updateLaunchJson } = await import('./launchConfig');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (root) {
        await Promise.all([
          updateIntelliSense(assembly, root, mainPackage, buildFlags, outputChannel),
          updateLaunchJson(activeInstallation, assembly, mainPackage, root, buildFlags),
        ]);
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
