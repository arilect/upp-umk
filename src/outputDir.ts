import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Output Directory Resolution ──────────────────────────────────────────────

export function resolveOutputDir(activeMainPackage: string | undefined, buildFlags?: string): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const outputDir = cfg.get('outputDir', '') || path.join(os.homedir(), '.cache', 'upp.out');
  const pkgLeaf = path.basename(activeMainPackage ?? '');
  const method = cfg.get('buildMethod', 'CLANG');
  const flags = buildFlags ?? cfg.get('buildFlags', '');
  const mode = flags.includes('r') ? 'Release' : 'Debug';
  return path.join(outputDir, pkgLeaf, `${method}.${mode}`);
}

/**
 * Find the actual binary in the U++ output directory.
 * U++ output convention: ~/.cache/upp.out/<assembly>/<method>.<mode>.<flags>/<package>
 * Build output dirs start with the build method name (e.g. CLANG., GCC.)
 * Package source dirs are named after packages (ArrayCtrl, Core, etc.)
 */
export function findBinaryInOutputDir(outputDir: string, pkgLeaf: string): string | undefined {
  if (!fs.existsSync(outputDir)) return undefined;

  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Only look in build output directories (start with CLANG, GCC, etc.)
    if (!/^(CLANG|GCC|MSC|ICC|FPC)\./i.test(entry.name)) continue;

    const subdir = path.join(outputDir, entry.name);
    const candidate = path.join(subdir, pkgLeaf);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the debug output directory by searching for the assembly's build output.
 * U++ convention: ~/.cache/upp.out/<assembly>/<method>.<mode>.<flags>/
 * Build output dirs start with the build method name (CLANG., GCC., etc.)
 */
export function resolveDebugOutputDir(assemblyName: string | undefined, activeMainPackage: string | undefined): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const baseOutputDir = cfg.get('outputDir', '') || path.join(os.homedir(), '.cache', 'upp.out');
  const pkgLeaf = path.basename(activeMainPackage ?? '');

  if (!assemblyName || !pkgLeaf || !fs.existsSync(baseOutputDir)) {
    return path.join(baseOutputDir, pkgLeaf, 'Debug');
  }

  // Search under assembly name directory
  const assemblyDir = path.join(baseOutputDir, assemblyName);
  if (!fs.existsSync(assemblyDir)) {
    return path.join(baseOutputDir, pkgLeaf, 'Debug');
  }

  // Find build output subdirectories (start with CLANG, GCC, etc.)
  const entries = fs.readdirSync(assemblyDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^(CLANG|GCC|MSC|ICC|FPC)\./i.test(entry.name)) continue;

    const candidate = path.join(assemblyDir, entry.name, pkgLeaf);
    if (fs.existsSync(candidate)) {
      return path.join(assemblyDir, entry.name);
    }
  }

  // Fallback: return first build output directory
  const buildDirs = entries.filter(e => e.isDirectory() && /^(CLANG|GCC|MSC|ICC|FPC)\./i.test(e.name));
  if (buildDirs.length > 0) {
    return path.join(assemblyDir, buildDirs[0].name);
  }

  return path.join(baseOutputDir, pkgLeaf, 'Debug');
}

export function resolveBinaryPath(activeMainPackage: string | undefined, buildFlags?: string): string {
  return path.join(resolveOutputDir(activeMainPackage, buildFlags), path.basename(activeMainPackage ?? ''));
}

export function resolveDebugBinaryPath(assemblyName: string | undefined, activeMainPackage: string | undefined): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const baseOutputDir = cfg.get('outputDir', '') || path.join(os.homedir(), '.cache', 'upp.out');
  const pkgLeaf = path.basename(activeMainPackage ?? '');

  // First try to find the actual binary in the output directory
  const found = findBinaryInOutputDir(baseOutputDir, pkgLeaf);
  if (found) return found;

  // Fallback to constructed path
  return path.join(resolveDebugOutputDir(assemblyName, activeMainPackage), pkgLeaf);
}
