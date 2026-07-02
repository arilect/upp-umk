import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Assembly, resolveIncludePaths, resolveWorkspaceFolders } from './assemblyParser';
import { resolveCppStandard } from './utils';

interface CppPropertiesConfig {
  name: string;
  includePath: string[];
  defines: string[];
  compilerPath?: string;
  cStandard?: string;
  cppStandard?: string;
  intelliSenseMode?: string;
  compileCommands?: string;
}

interface CppProperties {
  version: number;
  configurations: CppPropertiesConfig[];
}

function toRelativePath(absPath: string, baseDir: string): string {
  if (!path.isAbsolute(absPath)) return absPath;
  const rel = path.relative(baseDir, absPath);
  return rel.startsWith('..') ? absPath : rel.replace(/\\/g, '/');
}

function getPlatformDefines(isRelease: boolean): string[] {
  const defines: string[] = [];
  const platform = process.platform;
  if (platform === 'linux') {
    defines.push('flagLINUX', 'flagPOSIX');
  } else if (platform === 'darwin') {
    defines.push('flagMACOS', 'flagPOSIX');
  } else if (platform === 'win32') {
    defines.push('flagWIN32');
  }
  defines.push('flagGUI');
  if (!isRelease) defines.push('_DEBUG');
  return defines;
}

function getIntelliSenseMode(buildMethod: string): string {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const compiler = buildMethod.startsWith('CLANG') ? 'clang' : 'gcc';
  return `${osName}-${compiler}-${arch}`;
}

export async function updateIntelliSense(
  assembly: Assembly,
  workspaceRoot: string,
  mainPackage?: string,
  buildFlags?: string,
  outputChannel?: vscode.OutputChannel,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('upp');
  const buildMethod: string = config.get('buildMethod', 'GCC');

  const includePaths = resolveIncludePaths(assembly);

  const vscodePath = path.join(workspaceRoot, '.vscode');
  const propertiesPath = path.join(vscodePath, 'c_cpp_properties.json');

  let properties: CppProperties = { version: 4, configurations: [] };
  if (fs.existsSync(propertiesPath)) {
    try {
      properties = JSON.parse(fs.readFileSync(propertiesPath, 'utf8'));
    } catch { /* start fresh */ }
  }

  if (!fs.existsSync(vscodePath)) {
    fs.mkdirSync(vscodePath, { recursive: true });
  }

  const intelliSenseMode = getIntelliSenseMode(buildMethod);

  // Check if compile_commands.json exists in the main package dir
  let compileCommands: string | undefined;
  if (mainPackage) {
    for (const nest of assembly.nests) {
      const pkgDir = path.join(nest, mainPackage.replace(/\//g, path.sep));
      const ccPath = path.join(pkgDir, 'compile_commands.json');
      if (fs.existsSync(ccPath)) {
        compileCommands = toRelativePath(ccPath, workspaceRoot);
        break;
      }
    }
  }

  const isRelease = buildFlags?.includes('r') ?? false;
  const defines = getPlatformDefines(isRelease);

  const relativeIncludePaths = includePaths.map(p => toRelativePath(p, workspaceRoot));

  const varDir = config.get<string>('varDir', '');
  const cppStd = resolveCppStandard(buildMethod, varDir, config);

  const newConfig: CppPropertiesConfig = {
    name: 'UPP',
    includePath: relativeIncludePaths,
    defines,
    cStandard: 'c17',
    cppStandard: cppStd,
    intelliSenseMode,
  };

  if (compileCommands) {
    newConfig.compileCommands = compileCommands;
  }

  const idx = properties.configurations.findIndex(c => c.name === 'UPP');
  if (idx >= 0) {
    properties.configurations[idx] = newConfig;
  } else {
    properties.configurations.push(newConfig);
  }

  fs.writeFileSync(propertiesPath, JSON.stringify(properties, null, 2), 'utf8');

  if (outputChannel) {
    outputChannel.appendLine('');
    outputChannel.appendLine(`IntelliSense: ${includePaths.length} include paths from ${assembly.nests.length} nests in assembly "${assembly.name}"`);
    for (const p of includePaths) {
      const nest = assembly.nests.find(n => p === n || p.startsWith(n + path.sep));
      const nestName = nest ? path.basename(nest) : '(unknown)';
      outputChannel.appendLine(`  [${nestName}] ${p}`);
    }
  }

  const ccMsg = compileCommands ? ' (compile_commands.json linked)' : '';
  const pathDetails = includePaths.map(p => {
    const nest = assembly.nests.find(n => p === n || p.startsWith(n + path.sep));
    return `${nest ? path.basename(nest) : '?'}: ${p}`;
  }).join(', ');
  vscode.window.showInformationMessage(
    `UPP: IntelliSense updated — ${includePaths.length} include paths from ${assembly.nests.length} nests in assembly "${assembly.name}"${ccMsg}\n${pathDetails}`
  );
}
