import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly } from './assemblyParser';
import { UppInstallation } from './installations';

/**
 * Resolve the base output directory for a given installation/assembly.
 * Precedence:
 *   1. Assembly .var OUTPUT directive
 *   2. upp.outputDir setting
 *   3. <installation>/out/
 *   4. ~/.cache/upp.out/ (fallback)
 */
export function resolveBaseOutputDir(
  installation?: UppInstallation,
  assembly?: Assembly,
): string {
  if (assembly?.output) return assembly.output;

  const cfg = vscode.workspace.getConfiguration('upp');
  const configured = cfg.get<string>('outputDir', '');
  if (configured) return configured;

  if (installation) return path.join(installation.path, 'out');

  return path.join(os.homedir(), '.cache', 'upp.out');
}

/**
 * Resolve the assembly-level output directory.
 * U++ convention: <base>/<assembly>/
 */
export function resolveOutputDir(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? path.basename(activeMainPackage ?? '');
  return path.join(baseOutputDir, assName);
}

/**
 * Find the actual binary in the U++ output directory.
 * Searches <base>/<assembly>/ for builder-prefixed subdirs (CLANG.*, GCC.*, etc.)
 * and looks for the binary inside.
 */
function scanAssemblyDirForBinary(
  assemblyDir: string,
  pkgLeaf: string,
): string | undefined {
  if (!fs.existsSync(assemblyDir)) return undefined;
  const entries = fs.readdirSync(assemblyDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^(CLANG|GCC|MSC|ICC|FPC)\./i.test(entry.name)) continue;

    const candidate = path.join(assemblyDir, entry.name, pkgLeaf);

    // Windows: <variant>/<pkgLeaf>.exe directly in variant dir
    const candidateExe = candidate + '.exe';
    if (fs.existsSync(candidateExe)) return candidateExe;

    if (!fs.existsSync(candidate)) continue;

    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      return candidate; // Linux: <variant>/<pkgLeaf> is the binary
    }
    if (stat.isDirectory()) {
      // Windows (legacy subdir): <variant>/<pkgLeaf>/<pkgLeaf>.exe
      const binaryInDir = path.join(candidate, pkgLeaf + '.exe');
      if (fs.existsSync(binaryInDir)) return binaryInDir;
    }
  }
  return undefined;
}

export function findBinaryInOutputDir(
  baseOutputDir: string,
  assemblyName: string,
  pkgLeaf: string,
): string | undefined {
  // First try: <base>/<assemblyName>/
  const assemblyDir = path.join(baseOutputDir, assemblyName);
  const found = scanAssemblyDirForBinary(assemblyDir, pkgLeaf);
  if (found) return found;

  // Fallback: scan all subdirs of baseOutputDir (assembly name may not match on-disk dir)
  if (!fs.existsSync(baseOutputDir)) return undefined;
  for (const entry of fs.readdirSync(baseOutputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === assemblyName) continue;
    const found = scanAssemblyDirForBinary(path.join(baseOutputDir, entry.name), pkgLeaf);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve the debug output directory by searching for the assembly's build output.
 * Searches <base>/<assembly>/ for builder-prefixed subdirs.
 */
export function resolveDebugOutputDir(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? path.basename(activeMainPackage ?? '');
  const pkgLeaf = path.basename(activeMainPackage ?? '');
  const assemblyDir = path.join(baseOutputDir, assName);

  if (!pkgLeaf || !fs.existsSync(assemblyDir)) {
    return path.join(assemblyDir, 'Debug');
  }

  const entries = fs.readdirSync(assemblyDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^(CLANG|GCC|MSC|ICC|FPC)\./i.test(entry.name)) continue;

    const candidate = path.join(assemblyDir, entry.name, pkgLeaf);
    if (fs.existsSync(candidate)) {
      return path.join(assemblyDir, entry.name);
    }
  }

  const buildDirs = entries.filter(e => e.isDirectory() && /^(CLANG|GCC|MSC|ICC|FPC)\./i.test(e.name));
  if (buildDirs.length > 0) {
    return path.join(assemblyDir, buildDirs[0].name);
  }

  return path.join(assemblyDir, 'Debug');
}

export function resolveDebugBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? path.basename(activeMainPackage ?? '');
  const pkgLeaf = path.basename(activeMainPackage ?? '');

  const found = findBinaryInOutputDir(baseOutputDir, assName, pkgLeaf);
  if (found) return found;

  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(resolveDebugOutputDir(installation, assembly, activeMainPackage), pkgLeaf + ext);
}
