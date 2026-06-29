import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { Assembly, parseAssembly } from './assemblyParser';

export interface UppInstallation {
  path: string;
  label: string;
  assemblies: Assembly[];
}

function isUppRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'uppsrc'));
}

function findUppRoots(pattern?: string): string[] {
  const cfg = vscode.workspace.getConfiguration('upp');
  const rawPaths = cfg.get<string[]>('installationsPaths', ['~']);
  const glob = pattern ?? cfg.get<string>('installationsGlob', '');
  const roots: string[] = [];

  const scanDirs: string[] = [];
  for (const p of rawPaths) {
    const resolved = p === '~' ? os.homedir() : p.replace(/^~(?=\/|\\|$)/, os.homedir());
    scanDirs.push(resolved);
  }

  const regex = glob ? new RegExp('^' + glob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;

  const check = (full: string, name: string): boolean => {
    if (regex && !regex.test(name)) return false;
    return isUppRoot(full);
  };

  for (const dir of scanDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);

      if (check(full, entry.name)) {
        roots.push(full);
        continue;
      }

      const sub = path.join(full, 'upp');
      if (check(sub, entry.name)) {
        roots.push(sub);
      }
    }
  }

  return roots;
}

function findVarFilesDeep(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  const skipDirs = new Set(['node_modules', '.git', '.cache', '__pycache__', '.svn', '.hg', 'bin', 'out']);

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.var')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function findVarFilesDeepWithProgress(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  const skipDirs = new Set(['node_modules', '.git', '.cache', '__pycache__', '.svn', '.hg', 'bin', 'out']);

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.var')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

export function resolvePath(p: string): string {
  return p === '~' ? os.homedir() : p.replace(/^~(?=\/|\\|$)/, os.homedir());
}

async function scanSinglePath(
  scanDir: string,
  glob: string,
  onFound: (inst: UppInstallation) => void,
  onProgress?: (scanDir: string, scanned: number, found: number) => void,
  token?: vscode.CancellationToken,
): Promise<{ scanned: number; found: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch {
    return { scanned: 0, found: 0 };
  }

  const regex = glob ? new RegExp('^' + glob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  let scanned = 0;
  let found = 0;

  for (const entry of entries) {
    if (token?.isCancellationRequested) break;
    if (!entry.isDirectory()) continue;

    if (regex && !regex.test(entry.name)) continue;

    const full = path.join(scanDir, entry.name);

    let rootDir: string | null = null;
    if (isUppRoot(full)) {
      rootDir = full;
    } else {
      const sub = path.join(full, 'upp');
      if (isUppRoot(sub)) {
        rootDir = sub;
      }
    }

    scanned++;
    onProgress?.(scanDir, scanned, found);

    if (rootDir) {
      const varFiles = findVarFilesDeepWithProgress(rootDir);
      const seen = new Set<string>();
      const assemblies: Assembly[] = [];
      for (const vf of varFiles) {
        const asm = parseAssembly(vf);
        if (seen.has(asm.name)) continue;
        seen.add(asm.name);
        assemblies.push(asm);
      }
      found++;
      onFound({ path: rootDir, label: entry.name, assemblies });
      onProgress?.(scanDir, scanned, found);
    }
  }

  return { scanned, found };
}

export async function scanInstallationsAsync(
  scanDirs: string[],
  glob: string,
  onFound: (inst: UppInstallation) => void,
  onProgress?: (scanDir: string, scanned: number, found: number) => void,
  token?: vscode.CancellationToken,
): Promise<{ totalScanned: number; totalFound: number }> {
  let totalScanned = 0;
  let totalFound = 0;

  const promises = scanDirs.map(async (scanDir) => {
    if (token?.isCancellationRequested) return;
    const result = await scanSinglePath(scanDir, glob, onFound, onProgress, token);
    totalScanned += result.scanned;
    totalFound += result.found;
  });

  await Promise.allSettled(promises);

  return { totalScanned, totalFound };
}

export function scanInstallations(pattern?: string): UppInstallation[] {
  const roots = findUppRoots(pattern);
  const cfg = vscode.workspace.getConfiguration('upp');
  const manualPaths = cfg.get<string[]>('installationsManual', []);

  for (const raw of manualPaths) {
    const dir = resolvePath(raw);
    if (fs.existsSync(path.join(dir, 'uppsrc')) && !roots.includes(dir)) {
      roots.push(dir);
    }
  }

  const installations: UppInstallation[] = [];

  for (const root of roots) {
    const varFiles = findVarFilesDeep(root);

    const seen = new Set<string>();
    const assemblies: Assembly[] = [];
    for (const vf of varFiles) {
      const asm = parseAssembly(vf);
      if (seen.has(asm.name)) continue;
      seen.add(asm.name);
      assemblies.push(asm);
    }

    const label = path.basename(path.dirname(root));
    installations.push({ path: root, label, assemblies });
  }

  return installations;
}
