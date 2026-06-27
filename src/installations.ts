import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Assembly, parseAssembly } from './assemblyParser';

export interface UppInstallation {
  path: string;
  label: string;
  assemblies: Assembly[];
}

function findUppRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return roots;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('upp-')) continue;
    const candidate = path.join(home, entry.name, 'upp');
    if (!fs.existsSync(path.join(candidate, 'uppsrc'))) continue;
    if (!fs.existsSync(path.join(candidate, 'umk.exe')) && !fs.existsSync(path.join(candidate, 'umk'))) continue;
    roots.push(candidate);
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

export function scanInstallations(): UppInstallation[] {
  const roots = findUppRoots();
  const installations: UppInstallation[] = [];

  for (const root of roots) {
    const varFiles = findVarFilesDeep(root);
    if (varFiles.length === 0) continue;

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
