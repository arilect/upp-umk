import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Assembly (.var file) ─────────────────────────────────────────────────────

export interface Assembly {
  name: string;       // assembly name — the argument passed to umk
  filePath: string;   // full path to the .var file (~/.upp/theide/myapp.var)
  nests: string[];    // nest directories from the UPP = "..." line
  output: string;     // OUTPUT = "..." value (build output directory)
}

/**
 * Parse a .var assembly file.
 *
 * Actual format:
 *   UPP = "/path/nest1;/path/nest2;/path/nest3;";
 *   OUTPUT = "/home/user/.cache/myapp.out";
 *   UPPHUB = "";
 *   _all = "0";
 *
 * The UPP key holds semicolon-separated nest directories.
 * The assembly name passed to umk is the .var filename without extension.
 */
export function parseAssembly(varPath: string): Assembly {
  const name = path.basename(varPath, '.var');
  const nests: string[] = [];
  let output = '';

  if (!fs.existsSync(varPath)) {
    return { name, filePath: varPath, nests, output };
  }

  const content = fs.readFileSync(varPath, 'utf8');

  // Parse key = "value"; lines
  const kvPattern = /^(\w+)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = kvPattern.exec(content)) !== null) {
    const key = m[1];
    const value = m[2];
    if (key === 'UPP') {
      nests.push(
        ...value.split(';').map(s => s.trim()).filter(Boolean)
      );
    } else if (key === 'OUTPUT') {
      output = value.trim();
    }
  }

  return { name, filePath: varPath, nests, output };
}

/**
 * Find all .var assembly files.
 * Checks upp.varDir setting first, then standard locations.
 */
export function findAssemblies(varDir?: string): Assembly[] {
  const searchDirs = varDir?.trim()
    ? [varDir.trim()]
    : [
        path.join(os.homedir(), '.config', 'u++', 'theide'), // XDG (modern U++)
        path.join(os.homedir(), '.upp', 'theide'),            // legacy
        path.join(os.homedir(), '.upp', 'umk'),               // legacy
      ];

  const results: Assembly[] = [];
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.var')) continue;
      const name = path.basename(entry.name, '.var');
      if (seen.has(name)) continue;
      seen.add(name);
      results.push(parseAssembly(path.join(dir, entry.name)));
    }
  }

  return results;
}

// ─── Package (.upp file) ──────────────────────────────────────────────────────

export interface PackageMeta {
  uses: string[];
  defines: string[];
  keywords: string[];
  hasMainConfig: boolean;
  description?: string;
}

/**
 * Strip C-style line and block comments from source content.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse a .upp package definition file.
 * Ref: https://www.ultimatepp.org/app$ide$upp$en-us.html
 */
export function parseUppFile(uppFilePath: string): PackageMeta {
  const meta: PackageMeta = { uses: [], defines: [], keywords: [], hasMainConfig: false };
  if (!fs.existsSync(uppFilePath)) return meta;

  const content = stripComments(fs.readFileSync(uppFilePath, 'utf8'));

  // description "text\377R,G,B"; — extract text before \377 color code
  const descMatch = content.match(/description\s+"(.+?)\\377[^"]*";/);
  if (descMatch) {
    meta.description = descMatch[1];
  }

  const usesMatch = content.match(/\buses\b([\s\S]*?);/);
  if (usesMatch) {
    meta.uses.push(
      ...usesMatch[1]
        .split(/[\s,]+/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0 && !s.startsWith('//'))
    );
  }

  const optionsMatch = content.match(/\boptions\b([\s\S]*?);/);
  if (optionsMatch) {
    meta.defines.push(
      ...optionsMatch[1]
        .split(/[\s,]+/)
        .map((s: string) => s.trim())
        .filter(Boolean)
    );
  }

  const kwMatch = content.match(/\bkeyword\b([\s\S]*?);/);
  if (kwMatch) {
    meta.keywords.push(
      ...kwMatch[1]
        .split(/[\s,]+/)
        .map((s: string) => s.trim().replace(/"/g, ''))
        .filter((s: string) => s.length > 0)
    );
  }

  meta.hasMainConfig = /\bmainconfig\b/.test(content);

  return meta;
}

// ─── IntelliSense include path resolution ────────────────────────────────────

/**
 * Resolve include paths by walking the nest directories from the .var file
 * and recursively following .upp `uses` dependencies.
 */
export function resolveIncludePaths(assembly: Assembly): string[] {
  const includePaths = new Set<string>();
  const visited = new Set<string>();

  function resolvePackage(pkgName: string) {
    if (visited.has(pkgName)) return;
    visited.add(pkgName);

    for (const nest of assembly.nests) {
      const candidate = path.join(nest, pkgName.replace(/\//g, path.sep));
      if (fs.existsSync(candidate)) {
        includePaths.add(nest);
        const leaf = path.basename(candidate);
        const meta = parseUppFile(path.join(candidate, `${leaf}.upp`));
        for (const dep of meta.uses) resolvePackage(dep);
        break;
      }
    }
  }

  for (const nest of assembly.nests) {
    if (!fs.existsSync(nest)) continue;
    try {
      for (const entry of fs.readdirSync(nest, { withFileTypes: true })) {
        if (entry.isDirectory()) resolvePackage(entry.name);
      }
    } catch { /* ignore unreadable dirs */ }
  }

  return Array.from(includePaths);
}

// ─── Package discovery ────────────────────────────────────────────────────────

export interface PackageInfo {
  name: string;     // e.g. "MyApp/Main" — relative to the nest root
  nestDir: string;  // the nest this package lives in
  uppFile: string;  // full path to the .upp file
  description?: string; // from description "text\377..." in .upp
  isMain: boolean;  // keyword "main" present in .upp
}

/**
 * Scan all nest directories in an assembly and return every valid package.
 * A valid package is a directory that contains a .upp file with the same
 * name as the directory (e.g. MyApp/Main.upp inside nest/MyApp/Main/).
 *
 * Searches one level deep (direct children of nest) and two levels deep
 * (org/package style, e.g. uppsrc/Core/Core.upp).
 */
export function findPackagesInAssembly(assembly: Assembly): PackageInfo[] {
  const results: PackageInfo[] = [];

  for (const nest of assembly.nests) {
    if (!fs.existsSync(nest)) continue;

    let topEntries: fs.Dirent[];
    try { topEntries = fs.readdirSync(nest, { withFileTypes: true }); }
    catch { continue; }

    for (const top of topEntries) {
      if (!top.isDirectory()) continue;
      const topPath = path.join(nest, top.name);

      // One level: nest/PkgName/PkgName.upp
      const directUpp = path.join(topPath, `${top.name}.upp`);
      if (fs.existsSync(directUpp)) {
        const meta = parseUppFile(directUpp);
        results.push({ name: top.name, nestDir: nest, uppFile: directUpp, description: meta.description, isMain: meta.hasMainConfig });
        continue;
      }

      // Two levels: nest/Org/PkgName/PkgName.upp
      let subEntries: fs.Dirent[];
      try { subEntries = fs.readdirSync(topPath, { withFileTypes: true }); }
      catch { continue; }

      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subUpp = path.join(topPath, sub.name, `${sub.name}.upp`);
        if (fs.existsSync(subUpp)) {
          const meta = parseUppFile(subUpp);
          results.push({
            name: `${top.name}/${sub.name}`,
            nestDir: nest,
            uppFile: subUpp,
            description: meta.description,
            isMain: meta.hasMainConfig,
          });
        }
      }
    }
  }

  return results;
}

// ─── Workspace folder resolution ─────────────────────────────────────────────

/**
 * Resolve the ordered list of package directories to use as VSCode workspace
 * folders for a given package.
 *
 * Algorithm:
 *   1. Start with the selected package itself
 *   2. Parse its .upp file for `uses` — in the order they appear
 *   3. For each used package, find it in nests (nests are searched in .var order)
 *   4. Recurse into each dependency's .upp file in the same way
 *   5. Return deduplicated dirs in dependency-first traversal order
 *      (the selected package's own dir is always first)
 *
 * Nest priority from .var is preserved: if a package exists in multiple nests,
 * the first nest in the UPP = "..." list wins.
 */
export function resolveWorkspaceFolders(
  uppFile: string,
  nests: string[]
): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>(); // keyed by full directory path to avoid false dedup

  function findPkgDir(pkgName: string): string | undefined {
    for (const nest of nests) {
      const candidate = path.join(nest, pkgName.replace(/\//g, path.sep));
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  function visit(pkgUppFile: string, pkgName: string) {
    const pkgDir = path.dirname(pkgUppFile);
    const dirKey = path.resolve(pkgDir);
    if (visited.has(dirKey)) return;
    visited.add(dirKey);

    // Parse uses in order — order in the .upp file is preserved
    const meta = parseUppFile(pkgUppFile);

    // Recurse into dependencies first (depth-first, uses-order)
    for (const dep of meta.uses) {
      const depDir = findPkgDir(dep);
      if (!depDir) continue;
      const leaf = path.basename(depDir);
      const depUpp = path.join(depDir, `${leaf}.upp`);
      visit(depUpp, dep);
    }

    // Add this package after its own dependencies
    ordered.push(pkgDir);
  }

  visit(uppFile, path.basename(uppFile, '.upp'));

  // Selected package dir moves to front
  const selectedDir = path.dirname(uppFile);
  const rest = ordered.filter(d => d !== selectedDir);
  return [selectedDir, ...rest];
}

// ─── Build Method (.bm file) ──────────────────────────────────────────────────

export interface BuildMethodData {
  BUILDER: string;
  COMPILER: string;
  COMMON_OPTIONS: string;
  COMMON_CPP_OPTIONS: string;
  COMMON_C_OPTIONS: string;
  COMMON_LINK: string;
  COMMON_FLAGS: string;
  DEBUG_INFO: string;
  DEBUG_BLITZ: string;
  DEBUG_LINKMODE: string;
  DEBUG_OPTIONS: string;
  DEBUG_FLAGS: string;
  DEBUG_LINK: string;
  DEBUG_CUDA: string;
  RELEASE_BLITZ: string;
  RELEASE_LINKMODE: string;
  RELEASE_OPTIONS: string;
  RELEASE_FLAGS: string;
  RELEASE_LINK: string;
  RELEASE_CUDA: string;
  DEBUGGER: string;
  ALLOW_PRECOMPILED_HEADERS: string;
  DISABLE_BLITZ: string;
  PATH: string;
  INCLUDE: string;
  LIB: string;
  LINKMODE_LOCK: string;
  filePath: string;
}

const BM_KEYS: (keyof BuildMethodData)[] = [
  'BUILDER', 'COMPILER', 'COMMON_OPTIONS', 'COMMON_CPP_OPTIONS', 'COMMON_C_OPTIONS',
  'COMMON_LINK', 'COMMON_FLAGS', 'DEBUG_INFO', 'DEBUG_BLITZ', 'DEBUG_LINKMODE',
  'DEBUG_OPTIONS', 'DEBUG_FLAGS', 'DEBUG_LINK', 'DEBUG_CUDA',
  'RELEASE_BLITZ', 'RELEASE_LINKMODE', 'RELEASE_OPTIONS', 'RELEASE_FLAGS',
  'RELEASE_LINK', 'RELEASE_CUDA', 'DEBUGGER', 'ALLOW_PRECOMPILED_HEADERS',
  'DISABLE_BLITZ', 'PATH', 'INCLUDE', 'LIB', 'LINKMODE_LOCK',
];

export function parseBmFile(filePath: string): BuildMethodData {
  const data: any = {
    BUILDER: '', COMPILER: '', COMMON_OPTIONS: '', COMMON_CPP_OPTIONS: '',
    COMMON_C_OPTIONS: '', COMMON_LINK: '', COMMON_FLAGS: '', DEBUG_INFO: '',
    DEBUG_BLITZ: '', DEBUG_LINKMODE: '', DEBUG_OPTIONS: '', DEBUG_FLAGS: '',
    DEBUG_LINK: '', DEBUG_CUDA: '', RELEASE_BLITZ: '', RELEASE_LINKMODE: '',
    RELEASE_OPTIONS: '', RELEASE_FLAGS: '', RELEASE_LINK: '', RELEASE_CUDA: '',
    DEBUGGER: '', ALLOW_PRECOMPILED_HEADERS: '', DISABLE_BLITZ: '', PATH: '',
    INCLUDE: '', LIB: '', LINKMODE_LOCK: '', filePath,
  };

  if (!fs.existsSync(filePath)) return data as BuildMethodData;

  const content = fs.readFileSync(filePath, 'utf8');
  const kvPattern = /^(\w+)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = kvPattern.exec(content)) !== null) {
    const key = m[1];
    if ((BM_KEYS as string[]).includes(key)) {
      data[key] = m[2];
    }
  }

  return data as BuildMethodData;
}

export function writeBmFile(filePath: string, data: BuildMethodData): void {
  const lines: string[] = [];
  for (const key of BM_KEYS) {
    const val = data[key] ?? '';
    lines.push(`${key} = "${val}";`);
  }
  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

// ─── Build params ─────────────────────────────────────────────────────────────

/**
 * Parse mainconfig entries from a .upp file.
 *
 * Format:
 *   mainconfig
 *       "" = "GUI NOGTK MT",
 *       "" = "GUI",
 *       "" = "GUI X11";
 *
 * Returns the flag strings in order, e.g. ["GUI NOGTK MT", "GUI", "GUI X11"]
 */
export function parseMainConfigs(uppFilePath: string): string[] {
  if (!fs.existsSync(uppFilePath)) return [];
  const content = stripComments(fs.readFileSync(uppFilePath, 'utf8'));

  const block = content.match(/\bmainconfig\b([\s\S]*?);/);
  if (!block) return [];

  const configs: string[] = [];
  // Each entry: "" = "FLAG1 FLAG2 FLAG3"
  const entryPattern = /"[^"]*"\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = entryPattern.exec(block[1])) !== null) {
    const flags = m[1].trim();
    if (flags) configs.push(flags);
  }
  return configs;
}

/**
 * Find all .bm build method files in the standard U++ config locations.
 * Returns { name, filePath } objects.
 */
export function findBuildMethods(varDir?: string): { name: string; filePath: string }[] {
  const searchDirs = varDir?.trim()
    ? [varDir.trim()]
    : [
        path.join(os.homedir(), '.config', 'u++', 'theide'),
        path.join(os.homedir(), '.config', 'u++', 'umk'),
        path.join(os.homedir(), '.upp', 'theide'),
      ];

  const results: { name: string; filePath: string }[] = [];
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.bm')) continue;
      const name = path.basename(entry.name, '.bm');
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, filePath: path.join(dir, entry.name) });
    }
  }
  return results;
}

// ─── Nest → Assembly mapping ──────────────────────────────────────────────────

/**
 * Build a mapping from nest directory to assembly name.
 * This allows us to determine which assembly a package belongs to
 * based on which nest directory contains it.
 *
 * Returns: Map<normalizedNestPath, assemblyName>
 *
 * Example:
 *   "/home/user/uppsrc" → "uppsrc"
 *   "/home/user/UppHub" → "UppHub"
 */
export function buildNestToAssemblyMap(assemblies: Assembly[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const assembly of assemblies) {
    for (const nest of assembly.nests) {
      // Normalize the path to ensure consistent lookup
      const normalized = path.resolve(nest);
      // First assembly wins if nests overlap (shouldn't happen, but be safe)
      if (!map.has(normalized)) {
        map.set(normalized, assembly.name);
      }
    }
  }

  return map;
}

/**
 * Find which nest directory contains a given package directory.
 * Returns the nest path or undefined if not found.
 */
export function findNestForPackage(pkgDir: string, nests: string[]): string | undefined {
  const normalizedPkgDir = path.resolve(pkgDir);

  for (const nest of nests) {
    const normalizedNest = path.resolve(nest);
    // Check if package dir is inside this nest
    if (normalizedPkgDir === normalizedNest ||
        normalizedPkgDir.startsWith(normalizedNest + path.sep)) {
      return normalizedNest;
    }
  }

  return undefined;
}

/**
 * Find which assembly a package belongs to based on its directory.
 * Returns the assembly name or the provided fallback if not found.
 */
export function resolveAssemblyForPackage(
  pkgDir: string,
  nestToAssembly: Map<string, string>,
  fallback: string
): string {
  const nest = findNestForPackage(pkgDir, Array.from(nestToAssembly.keys()));
  return nest ? (nestToAssembly.get(nest) ?? fallback) : fallback;
}