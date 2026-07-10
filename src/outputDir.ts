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

// ─── link mode helpers (mirrors buildCommand.ts; kept local to avoid cycles) ──

function getLinkModeFlag(cfg: vscode.WorkspaceConfiguration): string {
  const mode: string = cfg.get('linkMode', 'all-static');
  if (mode === 'use-shared') return 's';
  if (mode === 'all-shared') return 'S';
  return '';
}

/**
 * Effective build flags: raw buildFlags with s/S stripped (link mode is a
 * separate setting) then the link-mode flag appended. This is the string
 * actually passed to umk as -<flags>.
 */
export function effectiveBuildFlags(cfg: vscode.WorkspaceConfiguration): string {
  const raw: string = cfg.get('buildFlags', '');
  return raw.split('').filter(c => c !== 's' && c !== 'S').join('') + getLinkModeFlag(cfg);
}

/** GetFileTitle(method): basename without .bm extension (U++ OutDir uses this). */
function methodFileTitle(buildMethod: string): string {
  const base = path.basename(buildMethod);
  return base.endsWith('.bm') ? base.slice(0, -3) : base;
}

// ─── Platform flags excluded from the variant dir name ───────────────────────
// Mirrors Host::AddHostFlags / HasPlatformFlag (uppsrc/ide/Core/Host.cpp).
const PLATFORM_FLAGS = new Set([
  'WIN32', 'POSIX', 'LINUX', 'OSX', 'OSX11', 'ANDROID',
  'BSD', 'FREEBSD', 'OPENBSD', 'NETBSD', 'DRAGONFLY', 'SOLARIS',
]);

// ─── Compute variant dir name replicating MakeBuild::OutDir ──────────────────
// See uppsrc/ide/Builders/Build.cpp:244-286 and PackageConfig:22-58,
// SplitFlags (uppsrc/ide/Core/Workspace.cpp) for the canonical logic.
//
// Key umk behaviors (umake.cpp:106-111) that differ from theide:
//   - debug.def.debug = 2 (DEBUG_FULL) unless -d sets it to 0
//   - release.def.debug = 0 (no DEBUG_* in release)
//   - debug.def.blitz = release.def.blitz = 0 unless -b sets them to 1
//   - .bm DEBUG_INFO is NOT consulted by umk for the variant dir name
export function computeVariantDirName(
  buildMethod: string,
  buildFlags: string,
  configurationFlag: string,
  methodVars?: BuildMethodData,
): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const linkMode: string = cfg.get('linkMode', 'all-static');
  const useTarget: boolean = cfg.get('useTarget', false);

  // Strip s/S (controlled by linkMode, not part of -flags for variant purposes)
  const flags = buildFlags.split('').filter(c => c !== 's' && c !== 'S').join('');
  const isRelease = flags.includes('r');
  const hasD = flags.includes('d');
  const isBlitzFlag = flags.includes('b');

  const disableBlitz = methodVars?.DISABLE_BLITZ === '1';

  // Build the cfg flag set exactly like PackageConfig + SplitFlags(main=true)
  const cfgSet = new Set<string>();

  // configurationFlag tokens (+FLAG,FLAG)
  if (configurationFlag) {
    for (const f of configurationFlag.split(/[,\s]+/)) {
      const flag = f.trim().toUpperCase();
      if (flag) cfgSet.add(flag);
    }
  }

  // targetmode: -r → release (no DEBUG); else DEBUG
  if (!isRelease) {
    cfgSet.add('DEBUG');
    // def.debug = 2 → DEBUG_FULL; -d → def.debug = 0 (no debug-level bits)
    if (!hasD) cfgSet.add('DEBUG_FULL');
  }
  // release mode: def.debug = 0, no DEBUG_* bits

  // linkmode → SHARED (linkmode 1) / SO+SHARED (linkmode 2)
  if (linkMode === 'use-shared') {
    cfgSet.add('SHARED');
  } else if (linkMode === 'all-shared') {
    cfgSet.add('SO');
    cfgSet.add('SHARED');
  }

  // blitz: -b and not DISABLE_BLITZ
  if (isBlitzFlag && !disableBlitz) {
    cfgSet.add('BLITZ');
  }

  // SplitFlags(main=true) always adds MAIN
  cfgSet.add('MAIN');

  // Exclusions (OutDir builds excl set): builder name, MSC, platform flags
  const builderName = (methodVars?.BUILDER || 'GCC').toUpperCase();
  const excl = new Set<string>([builderName, 'MSC', ...PLATFORM_FLAGS]);
  if (useTarget) {
    excl.add('MAIN'); // OutDir: if(use_target) excl.Add("MAIN")
  }

  const hasDebug = cfgSet.has('DEBUG');
  const hasDebugFull = cfgSet.has('DEBUG_FULL');
  const hasDebugMinimal = cfgSet.has('DEBUG_MINIMAL');
  const dbg = hasDebugFull || hasDebugMinimal;
  const hasBlitz = cfgSet.has('BLITZ');

  const x: string[] = [];
  if (hasDebug) {
    // Debug mode: BLITZ excluded from dir name
    excl.add('BLITZ');
    if (!hasBlitz) {
      x.push('NOBLITZ');
    }
  } else if (dbg) {
    // Release mode with debug info: inject RELEASE
    x.push('RELEASE');
  }

  // Add non-excluded flags from cfg
  for (const flag of cfgSet) {
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

  return methodFileTitle(buildMethod) + '.' + (x.length ? x.join('.') : 'Default');
}

/**
 * Compute the expected output variant directory path.
 * Replicates MakeBuild::OutDir from uppsrc/ide/Builders/Build.cpp:244-286.
 *
 * Layout (mirrors OutDir):
 *   <base>/[<assembly>/][<package>/]<method>.<variant>/<binary>
 *
 *   - output_per_assembly (upp.outputPerAssembly): prepend <assembly>/
 *   - use_target=false (default): append <package>/ (the main package name)
 *   - use_target=true: omit <package>/ and exclude Main from the variant
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
  const cfg = vscode.workspace.getConfiguration('upp');
  const outputPerAssembly: boolean = cfg.get('outputPerAssembly', false);
  const useTarget: boolean = cfg.get('useTarget', false);

  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? '';
  // OutDir appends the package name (may contain '/', e.g. "App/Main")
  const pkgName = activeMainPackage ?? '';

  const variantDir = computeVariantDirName(
    buildMethod ?? '',
    buildFlags ?? '',
    configurationFlag ?? '',
    methodVars,
  );

  let v = baseOutputDir;
  if (outputPerAssembly && assName) {
    v = path.join(v, assName);
  }
  if (!useTarget && pkgName) {
    v = path.join(v, pkgName.replace(/\//g, path.sep));
  }
  v = path.join(v, variantDir);
  return v;
}

/**
 * Compute the expected binary path from the current build configuration.
 * Binary name = GetFileTitle(mainpackage) + ext (OutDir: mainfn = GetFileTitle(mainpackage) + ext).
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
  const variantDir = computeOutputVariantDir(
    installation, assembly, activeMainPackage,
    buildMethod, buildFlags, configurationFlag, methodVars,
  );
  const pkgLeaf = path.basename(activeMainPackage ?? '');
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(variantDir, pkgLeaf + ext);
}

// ─── Filesystem-scanning fallbacks (used when the computed path misses) ──────

/**
 * Scan a package output directory for builder variant subdirs containing
 * the binary. Used as a fallback when computeBinaryPath finds nothing.
 */
function scanPackageDirForBinary(
  packageDir: string,
  pkgLeaf: string,
  buildMethod?: string,
): string | undefined {
  if (!fs.existsSync(packageDir)) return undefined;
  const entries = fs.readdirSync(packageDir, { withFileTypes: true });
  const builderDirs = entries.filter(e => e.isDirectory() && /^(CLANG|GCC|MSC|ICC|FPC)\w*\./i.test(e.name));

  if (buildMethod) {
    const bm = methodFileTitle(buildMethod).toUpperCase();
    builderDirs.sort((a, b) => {
      const aUp = a.name.toUpperCase();
      const bUp = b.name.toUpperCase();
      const aMatch = aUp.startsWith(bm) ? 0 : 1;
      const bMatch = bUp.startsWith(bm) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const entry of builderDirs) {
    const candidate = path.join(packageDir, entry.name, pkgLeaf + ext);
    if (fs.existsSync(candidate)) return candidate;
    // Without extension (some targets)
    const candidateNoExt = path.join(packageDir, entry.name, pkgLeaf);
    if (fs.existsSync(candidateNoExt)) return candidateNoExt;
  }
  return undefined;
}

/**
 * Find the compiled binary by trying the computed path first, then scanning
 * the output directory. Mirrors the package-level layout of OutDir.
 */
export function findBinaryInOutputDir(
  baseOutputDir: string,
  assemblyName: string,
  pkgName: string,
  buildMethod?: string,
  outputPerAssembly?: boolean,
): string | undefined {
  const pkgLeaf = path.basename(pkgName);
  const pkgSeg = pkgName.replace(/\//g, path.sep);

  // 1. Try the most likely package dir(s)
  const candidateDirs: string[] = [];
  if (outputPerAssembly && assemblyName) {
    candidateDirs.push(path.join(baseOutputDir, assemblyName, pkgSeg));
  }
  candidateDirs.push(path.join(baseOutputDir, pkgSeg));

  for (const dir of candidateDirs) {
    const found = scanPackageDirForBinary(dir, pkgLeaf, buildMethod);
    if (found) return found;
  }

  // 2. Last resort: scan all subdirs of base for the package
  if (!fs.existsSync(baseOutputDir)) return undefined;
  for (const entry of fs.readdirSync(baseOutputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (outputPerAssembly && entry.name === assemblyName) continue; // already tried
    const found = scanPackageDirForBinary(path.join(baseOutputDir, entry.name, pkgSeg), pkgLeaf, buildMethod);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve the output variant directory for the *current* build configuration.
 * Used for the sidebar "Output Dir" row and clean-build.
 */
export function resolveOutputDir(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const buildMethod = cfg.get<string>('buildMethod', '');
  const buildFlags = effectiveBuildFlags(cfg);
  const configurationFlag = cfg.get<string>('configurationFlag', '');
  const varDir = cfg.get<string>('varDir', '');
  let methodVars: BuildMethodData | undefined;
  if (buildMethod) {
    const bms = require('./assemblyParser').findBuildMethods(varDir) as { name: string; filePath: string }[];
    const bm = bms.find(b => b.name === buildMethod || b.filePath === buildMethod);
    if (bm) methodVars = parseBmFile(bm.filePath);
  }
  return computeOutputVariantDir(installation, assembly, activeMainPackage, buildMethod, buildFlags, configurationFlag, methodVars);
}

/**
 * Resolve the debug-mode output directory (for running without building).
 * Strips release/minimal-debug flags so it always points at the full-debug
 * variant, matching the Debug action's build flags.
 */
export function resolveDebugOutputDir(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const buildMethod = cfg.get<string>('buildMethod', '');
  const configurationFlag = cfg.get<string>('configurationFlag', '');
  const varDir = cfg.get<string>('varDir', '');
  let methodVars: BuildMethodData | undefined;
  if (buildMethod) {
    const bms = require('./assemblyParser').findBuildMethods(varDir) as { name: string; filePath: string }[];
    const bm = bms.find(b => b.name === buildMethod || b.filePath === buildMethod);
    if (bm) methodVars = parseBmFile(bm.filePath);
  }
  // Debug flags: effective flags with r/d stripped (full debug, with link mode)
  const debugFlags = effectiveBuildFlags(cfg).replace(/[rd]/g, '');
  return computeOutputVariantDir(installation, assembly, activeMainPackage, buildMethod, debugFlags, configurationFlag, methodVars);
}

/**
 * Resolve the binary path. Tries the computed (OutDir-mirrored) path first;
 * falls back to a filesystem scan if not found.
 */
export function resolveBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
  buildMethod?: string,
  buildFlags?: string,
): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  const outputPerAssembly: boolean = cfg.get('outputPerAssembly', false);
  const configurationFlag = cfg.get<string>('configurationFlag', '');
  const varDir = cfg.get<string>('varDir', '');
  let methodVars: BuildMethodData | undefined;
  const bmName = buildMethod ?? cfg.get<string>('buildMethod', '');
  if (bmName) {
    const bms = require('./assemblyParser').findBuildMethods(varDir) as { name: string; filePath: string }[];
    const bm = bms.find(b => b.name === bmName || b.filePath === bmName);
    if (bm) methodVars = parseBmFile(bm.filePath);
  }

  // Use effective flags (with link mode) so the variant dir matches what umk built
  const effFlags = (buildFlags ?? '').split('').filter(c => c !== 's' && c !== 'S').join('') + getLinkModeFlag(cfg);
  const computed = computeBinaryPath(installation, assembly, activeMainPackage, bmName, effFlags, configurationFlag, methodVars);
  if (fs.existsSync(computed)) return computed;

  // Fallback: scan the output directory
  const baseOutputDir = resolveBaseOutputDir(installation, assembly);
  const assName = assembly?.name ?? '';
  const pkgName = activeMainPackage ?? '';
  const found = findBinaryInOutputDir(baseOutputDir, assName, pkgName, bmName, outputPerAssembly);
  if (found) return found;

  // Nothing found — return the computed path anyway (for error messages)
  return computed;
}

/** @deprecated Use resolveBinaryPath() instead */
export function resolveDebugBinaryPath(
  installation?: UppInstallation,
  assembly?: Assembly,
  activeMainPackage?: string,
): string {
  return resolveBinaryPath(installation, assembly, activeMainPackage);
}