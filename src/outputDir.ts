import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, BuildMethodData, parseBmFile } from './assemblyParser';
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

// ─── InitCaps: replicate U++ Core/CharSet.cpp InitCaps ───────────────────────
// Capitalizes first letter of each word; word boundary = non-alphanumeric char.
function initCaps(s: string): string {
  let result = '';
  let capitalizeNext = true;
  for (const ch of s) {
    if (capitalizeNext) {
      result += ch.toUpperCase();
    } else {
      result += ch.toLowerCase();
    }
    capitalizeNext = !/[a-zA-Z0-9]/.test(ch);
  }
  return result;
}

// ─── Compute variant dir name replicating MakeBuild::OutDir ──────────────────
// See Build.cpp:244-286 for the canonical logic.
export function computeVariantDirName(
  buildMethod: string,
  buildFlags: string,
  configurationFlag: string,
  methodVars?: BuildMethodData,
): string {
  const isRelease = buildFlags.includes('r');
  const isBlitz = buildFlags.includes('b');
  const debugInfoLevel = methodVars?.DEBUG_INFO ?? '';

  // Flags that go into the directory name, after exclusions
  // These mirror what PackageConfig() puts into cfg in Build.cpp
  const cfg: string[] = [];
  const x: string[] = [];

  if (!isRelease) {
    cfg.push('DEBUG');
    if (debugInfoLevel === '2') cfg.push('DEBUG_FULL');
    else if (debugInfoLevel === '1') cfg.push('DEBUG_MINIMAL');
  }

  if (isBlitz) {
    cfg.push('BLITZ');
  }

  // Add configurationFlag entries (e.g. GUI)
  if (configurationFlag) {
    for (const f of configurationFlag.split(/[,\s]+/)) {
      const flag = f.trim().toUpperCase();
      if (flag) cfg.push(flag);
    }
  }

  // Now replicate OutDir logic (Build.cpp:244-286)
  // Exclusions: builder name, MSC, platform flags
  const excl = new Set<string>(['MSC', 'WIN32', 'POSIX', 'LINUX', 'OSX', 'ANDROID', 'IOS', 'WASM']);
  if (methodVars?.BUILDER) excl.add(methodVars.BUILDER.toUpperCase());

  const hasDebug = cfg.includes('DEBUG');
  const hasDebugFull = cfg.includes('DEBUG_FULL');
  const hasDebugMinimal = cfg.includes('DEBUG_MINIMAL');
  const hasDebugLevel = hasDebugFull || hasDebugMinimal;
  const hasBlitz = cfg.includes('BLITZ');

  if (hasDebug) {
    // Debug mode: BLITZ excluded from dir name
    excl.add('BLITZ');
    if (!hasBlitz) {
      x.push('NOBLITZ');
    }
  } else if (hasDebugLevel) {
    // Release mode with debug info: inject RELEASE
    x.push('RELEASE');
  }

  // Add non-excluded flags from cfg
  for (const flag of cfg) {
    if (!excl.has(flag)) {
      x.push(flag);
    }
  }

  // Sort alphabetically (U++ OutDir sorts the flags)
  x.sort();

  // InitCaps each flag
  for (let i = 0; i < x.length; i++) {
    x[i] = initCaps(x[i]);
  }

  return buildMethod + '.' + (x.length ? x.join('.') : 'Default');
}

/**
 * Compute the expected output variant directory path.
 * This replicates MakeBuild::OutDir from Build.cpp so we can show the correct
 * path in the sidebar without scanning the filesystem.
 */
export function computeOutputVariantDir(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
  buildMethod?: string,
  buildFlags?: string,
  configurationFlag?: string,
  methodVars?: BuildMethodData,
): string {
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? path.basename(activeMainPackage ?? '');
  const variantDir = computeVariantDirName(
    buildMethod ?? '',
    buildFlags ?? '',
    configurationFlag ?? '',
    methodVars,
  );
  return path.join(baseOutputDir, assName, variantDir);
}

/**
 * Compute the expected binary path from the current build configuration.
 */
export function computeBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
  buildMethod?: string,
  buildFlags?: string,
  configurationFlag?: string,
  methodVars?: BuildMethodData,
): string {
  const variantDir = computeOutputVariantDir(installation, assembly, activeMainPackage, buildMethod, buildFlags, configurationFlag, methodVars);
  const pkgLeaf = path.basename(activeMainPackage ?? '');
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(variantDir, pkgLeaf + ext);
}

// ─── Legacy filesystem-scanning fallbacks (used for open-in-explorer etc.) ───

function scanAssemblyDirForBinary(
  assemblyDir: string,
  pkgLeaf: string,
  buildMethod?: string,
): string | undefined {
  if (!fs.existsSync(assemblyDir)) return undefined;
  const entries = fs.readdirSync(assemblyDir, { withFileTypes: true });
  const builderDirs = entries.filter(e => e.isDirectory() && /^(CLANG|GCC|MSC|ICC|FPC)\w*\./i.test(e.name));

  if (buildMethod) {
    const bm = buildMethod.toUpperCase();
    builderDirs.sort((a, b) => {
      const aUp = a.name.toUpperCase();
      const bUp = b.name.toUpperCase();
      const aMatch = aUp.startsWith(bm) ? 0 : 1;
      const bMatch = bUp.startsWith(bm) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  for (const entry of builderDirs) {
    const candidate = path.join(assemblyDir, entry.name, pkgLeaf);
    const candidateExe = candidate + '.exe';
    if (fs.existsSync(candidateExe)) return candidateExe;
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
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
  buildMethod?: string,
): string | undefined {
  const assemblyDir = path.join(baseOutputDir, assemblyName);
  const found = scanAssemblyDirForBinary(assemblyDir, pkgLeaf, buildMethod);
  if (found) return found;

  if (!fs.existsSync(baseOutputDir)) return undefined;
  for (const entry of fs.readdirSync(baseOutputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === assemblyName) continue;
    const found = scanAssemblyDirForBinary(path.join(baseOutputDir, entry.name), pkgLeaf, buildMethod);
    if (found) return found;
  }
  return undefined;
}

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
    if (!/^(CLANG|GCC|MSC|ICC|FPC)\w*\./i.test(entry.name)) continue;
    const candidate = path.join(assemblyDir, entry.name, pkgLeaf);
    if (fs.existsSync(candidate)) {
      return path.join(assemblyDir, entry.name);
    }
  }

  const buildDirs = entries.filter(e => e.isDirectory() && /^(CLANG|GCC|MSC|ICC|FPC)\w*\./i.test(e.name));
  if (buildDirs.length > 0) {
    return path.join(assemblyDir, buildDirs[0].name);
  }

  return path.join(assemblyDir, 'Debug');
}

export function resolveBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
  buildMethod?: string,
  buildFlags?: string,
): string {
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? path.basename(activeMainPackage ?? '');
  const pkgLeaf = path.basename(activeMainPackage ?? '');

  const found = findBinaryInOutputDir(baseOutputDir, assName, pkgLeaf, buildMethod);
  if (found) return found;

  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(resolveDebugOutputDir(installation, assembly, activeMainPackage), pkgLeaf + ext);
}

/** @deprecated Use resolveBinaryPath() instead */
export function resolveDebugBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  return resolveBinaryPath(installation, assembly, activeMainPackage);
}
