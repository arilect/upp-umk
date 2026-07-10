import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { Assembly, parseAssembly, setAssemblyUpHub, addNestToAssembly, removeNestFromAssembly, getDefaultVarDirs } from './assemblyParser';
import { activeInstallation } from './state';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UppHubNest {
  name: string;
  packages: string[];
  description: string;
  repo: string;
  status: 'stable' | 'experimental' | 'rolling' | 'broken';
  category: string;
  readme?: string;
  branch?: string;
}

export interface UppHubCatalog {
  nests: UppHubNest[];
  loadedAt: Date;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/ultimatepp/UppHub/main/nests.json';

// ─── Catalog ─────────────────────────────────────────────────────────────────

export async function fetchCatalog(url?: string): Promise<UppHubCatalog> {
  const catalogUrl = url || DEFAULT_CATALOG_URL;
  const response = await fetch(catalogUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch UppHub catalog: ${response.statusText}`);
  }
  const raw = await response.json() as { nests: Array<Partial<UppHubNest> & { repository?: string }> };
  return {
    nests: raw.nests.map(n => ({
      name: n.name || '',
      packages: n.packages || [],
      description: n.description || '',
      repo: n.repository || n.repo || '',
      status: n.status || 'experimental',
      category: n.category || '',
      readme: n.readme,
      branch: n.branch,
    })),
    loadedAt: new Date(),
  };
}

// ─── Hub Directory ───────────────────────────────────────────────────────────

export function getHubDir(assembly?: Assembly): string | undefined {
  if (assembly?.uppHub) return assembly.uppHub;
  return path.join(os.homedir(), 'upp', 'UppHub');
}

export function ensureHubDir(hubDir: string): void {
  if (!fs.existsSync(hubDir)) {
    fs.mkdirSync(hubDir, { recursive: true });
  }
}

export function isInstalled(hubDir: string, nestName: string): boolean {
  return fs.existsSync(path.join(hubDir, nestName));
}

export function getInstalledNests(hubDir: string): string[] {
  if (!fs.existsSync(hubDir)) return [];
  return fs.readdirSync(hubDir).filter(entry => {
    const full = path.join(hubDir, entry);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, '.git'));
  });
}

// ─── Git Operations ──────────────────────────────────────────────────────────

function gitExec(args: string[], cwd: string, outputChannel: vscode.OutputChannel): Promise<string> {
  return new Promise((resolve, reject) => {
    const gitPath = process.platform === 'win32' ? 'git.exe' : 'git';
    execFile(gitPath, args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        outputChannel.appendLine(`✗ git ${args[0]} failed: ${error.message}`);
        if (stderr) outputChannel.appendLine(`  ${stderr}`);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function installNest(
  nest: UppHubNest,
  hubDir: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  ensureHubDir(hubDir);
  const targetDir = path.join(hubDir, nest.name);
  if (fs.existsSync(targetDir)) {
    outputChannel.appendLine(`⊘ ${nest.name} already installed`);
    return;
  }

  outputChannel.appendLine(`↓ Installing ${nest.name}...`);
  outputChannel.show(true);

  const args = ['clone', '--progress'];
  if (nest.branch) {
    args.push('-b', nest.branch);
  }
  args.push(nest.repo, targetDir);

  await gitExec(args, hubDir, outputChannel);
  outputChannel.appendLine(`✓ ${nest.name} installed`);

  // Auto-resolve dependencies
  const deps = resolveDependencies(nest, hubDir);
  if (deps.length > 0) {
    outputChannel.appendLine(`  Dependencies to install: ${deps.join(', ')}`);
  }
}

export async function uninstallNest(
  hubDir: string,
  nestName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const targetDir = path.join(hubDir, nestName);
  if (!fs.existsSync(targetDir)) {
    outputChannel.appendLine(`⊘ ${nestName} not installed`);
    return;
  }

  outputChannel.appendLine(`✗ Uninstalling ${nestName}...`);
  fs.rmSync(targetDir, { recursive: true, force: true });
  outputChannel.appendLine(`✓ ${nestName} uninstalled`);
}

export async function updateNest(
  hubDir: string,
  nestName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const targetDir = path.join(hubDir, nestName);
  if (!fs.existsSync(targetDir)) {
    outputChannel.appendLine(`⊘ ${nestName} not installed, skipping update`);
    return;
  }

  outputChannel.appendLine(`↻ Updating ${nestName}...`);
  outputChannel.show(true);

  // Reset any local changes, then pull
  await gitExec(['clean', '-fxd'], targetDir, outputChannel).catch(() => {});
  await gitExec(['checkout', '.'], targetDir, outputChannel).catch(() => {});
  await gitExec(['pull', '--rebase'], targetDir, outputChannel);
  outputChannel.appendLine(`✓ ${nestName} updated`);
}

export async function updateAll(
  hubDir: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const installed = getInstalledNests(hubDir);
  if (installed.length === 0) {
    outputChannel.appendLine('No UppHub packages installed.');
    return;
  }

  outputChannel.appendLine(`Updating ${installed.length} UppHub package(s)...`);
  outputChannel.show(true);

  let success = 0;
  let failed = 0;
  for (const name of installed) {
    try {
      await updateNest(hubDir, name, outputChannel);
      success++;
    } catch {
      failed++;
    }
  }
  outputChannel.appendLine(`\n✓ Update complete: ${success} updated, ${failed} failed`);
}

// ─── Dependency Resolution ───────────────────────────────────────────────────

/**
 * Scan .upp files in a nest directory for `uses` declarations.
 * Returns package names that are not provided by the nest itself.
 */
export function resolveDependencies(
  nest: UppHubNest,
  hubDir: string,
): string[] {
  const nestDir = path.join(hubDir, nest.name);
  if (!fs.existsSync(nestDir)) return [];

  const ownPackages = new Set(nest.packages.map(p => path.basename(p)));
  const deps = new Set<string>();

  // Scan .upp files for `uses` lines
  const scan = (dir: string, depth = 0) => {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          scan(path.join(dir, entry.name), depth + 1);
        } else if (entry.name.endsWith('.upp')) {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          const usesMatch = content.match(/^uses\s*\(([^)]*)\)\s*;/gm);
          if (usesMatch) {
            for (const line of usesMatch) {
              const pkgs = line.match(/\(([^)]*)\)/)?.[1];
              if (pkgs) {
                for (const pkg of pkgs.split(/\s*,\s*/)) {
                  const trimmed = pkg.trim().replace(/"/g, '');
                  if (trimmed && !ownPackages.has(trimmed) && !deps.has(trimmed)) {
                    deps.add(trimmed);
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  };

  scan(nestDir);
  return [...deps];
}

/**
 * Install a nest and all its missing dependencies.
 * Returns the list of all nests that were installed (including the primary).
 */
export async function installWithDeps(
  nest: UppHubNest,
  catalog: UppHubCatalog,
  hubDir: string,
  outputChannel: vscode.OutputChannel,
): Promise<string[]> {
  const installed: string[] = [];
  const queue = [nest.name];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    if (isInstalled(hubDir, name)) {
      continue;
    }

    const nestData = catalog.nests.find(n => n.name === name);
    if (!nestData) {
      outputChannel.appendLine(`⚠ Dependency "${name}" not found in UppHub catalog`);
      continue;
    }

    await installNest(nestData, hubDir, outputChannel);
    installed.push(name);

    // Find missing deps
    const deps = resolveDependencies(nestData, hubDir);
    for (const dep of deps) {
      if (!visited.has(dep) && !isInstalled(hubDir, dep)) {
        queue.push(dep);
      }
    }
  }

  return installed;
}

// ─── Assembly Integration ────────────────────────────────────────────────────

/**
 * After installing/uninstalling packages, update the .var file's
 * UPPHUB key and optionally add/remove the hub dir from the nest list.
 */
export function syncAssemblyUpHub(
  assembly: Assembly,
  hubDir: string | undefined,
): void {
  if (hubDir) {
    setAssemblyUpHub(assembly.filePath, hubDir);
  } else {
    setAssemblyUpHub(assembly.filePath, '');
  }
}

/**
 * Add the hub directory to the assembly's UPP nest list.
 */
export function addHubToAssemblyNests(assembly: Assembly, hubDir: string): void {
  addNestToAssembly(assembly.filePath, hubDir);
}

/**
 * Remove the hub directory from the assembly's UPP nest list.
 */
export function removeHubFromAssemblyNests(assembly: Assembly, hubDir: string): void {
  removeNestFromAssembly(assembly.filePath, hubDir);
}

// ─── Auto-create UppHub assembly ─────────────────────────────────────────────

/**
 * Ensure the UppHub.var assembly file exists at the default var directory.
 * Creates the .var file and the source tree directory if missing.
 * Returns the parsed Assembly object.
 *
 * The generated UPP line always includes:
 *   1. hubDir (UppHub nests)
 *   2. uppsrc (the U++ standard library source, found from the active installation)
 *
 * OUTPUT defaults to ~/.cache/upp.out if no other source is available.
 */
export function ensureUppHubAssembly(): Assembly {
  const varDirs = getDefaultVarDirs();
  const varDir = varDirs[0]; // e.g. ~/.config/u++/theide
  const varPath = path.join(varDir, 'UppHub.var');
  const hubDir = path.join(os.homedir(), 'upp', 'UppHub');

  // Find uppsrc from the active installation or by scanning common locations
  let uppsrc = '';
  if (activeInstallation?.path && fs.existsSync(path.join(activeInstallation.path, 'uppsrc'))) {
    uppsrc = path.join(activeInstallation.path, 'uppsrc');
  } else {
    const candidates = [
      path.join(os.homedir(), 'upp-stable'),
      path.join(os.homedir(), 'upp'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'uppsrc'))) {
        uppsrc = path.join(candidate, 'uppsrc');
        break;
      }
    }
  }

  const outputDir = path.join(os.homedir(), '.cache', 'upp.out');

  // Ensure source tree directory exists
  if (!fs.existsSync(hubDir)) {
    fs.mkdirSync(hubDir, { recursive: true });
  }

  // Create .var file if missing
  if (!fs.existsSync(varPath)) {
    if (!fs.existsSync(varDir)) {
      fs.mkdirSync(varDir, { recursive: true });
    }
    const uppParts = uppsrc ? [hubDir, uppsrc] : [hubDir];
    const content = `UPP = "${uppParts.join(';')};";\nOUTPUT = "${outputDir}";\nUPPHUB = "${hubDir}";\n`;
    fs.writeFileSync(varPath, content, 'utf8');
  } else {
    // Patch existing .var: ensure uppsrc is in UPP and OUTPUT is not empty
    patchAssembly(varPath, hubDir, uppsrc, outputDir);
  }

  return parseAssembly(varPath);
}

/**
 * Patch an existing .var file to ensure it has uppsrc in UPP and a non-empty OUTPUT.
 */
function patchAssembly(varPath: string, hubDir: string, uppsrc: string, outputDir: string): void {
  let content = fs.readFileSync(varPath, 'utf8');
  let changed = false;

  // Ensure OUTPUT is not empty
  if (/OUTPUT\s*=\s*""\s*;/.test(content) && outputDir) {
    content = content.replace(/OUTPUT\s*=\s*""\s*;/, `OUTPUT = "${outputDir}";`);
    changed = true;
  }

  // Ensure uppsrc is in the UPP list
  if (uppsrc) {
    const uppMatch = content.match(/UPP\s*=\s*"([^"]*)"\s*;/);
    if (uppMatch) {
      const parts = uppMatch[1].split(';').filter(Boolean);
      const normalizedUp = uppsrc.replace(/\/+$/, '');
      const hasUp = parts.some(p => p.replace(/\/+$/, '') === normalizedUp);
      if (!hasUp) {
        parts.push(uppsrc);
        content = content.replace(
          /UPP\s*=\s*"[^"]*"\s*;/,
          `UPP = "${parts.join(';')}";`
        );
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(varPath, content, 'utf8');
  }
}

/**
 * Add the hub directory to an assembly's UPP nest list if not already present.
 */
export function ensureHubInAssemblyNests(assembly: Assembly, hubDir: string): void {
  if (!assembly.nests.includes(hubDir)) {
    addNestToAssembly(assembly.filePath, hubDir);
    assembly.nests.push(hubDir);
  }
}
