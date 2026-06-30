import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findAssemblies, parseMainConfigs } from './assemblyParser';
import {
  activeAssembly, activeMainPackage, activeInstallation,
  activePackageDescription, activePackageUppFile,
  setActiveAssembly, setActiveMainPackage, setActivePackageDescription, setActivePackageUppFile,
  outputChannel, updateStatusBar,
} from './state';
import { syncBuildCommand } from './buildCommand';
import { switchWorkspace } from './workspace';
import { updateIntelliSense } from './intelliSense';
import { syncCompileCommandsCommand, updateCompileCommandsWatcher } from './compileCommands';
import { showNewPackagePanel } from './newPackagePanel';
import { showNewAssemblyPanel } from './newAssemblyPanel';
import { showSelectPackagePanel } from './selectPackagePanel';

// ─── Assembly / Package Selection (TheIDE-style panel) ────────────────────────

export async function selectAssembly() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const varDir: string = cfg.get('varDir', '');
  const enabledAssemblies = cfg.get<string[]>('enabledAssemblies', []);
  const allAssemblies = activeInstallation?.assemblies?.length
    ? activeInstallation.assemblies
    : findAssemblies(varDir);

  const assemblies = enabledAssemblies.length > 0
    ? allAssemblies.filter(a => enabledAssemblies.includes(a.filePath))
    : allAssemblies;

  if (assemblies.length === 0) {
    vscode.window.showWarningMessage(
      'UPP: No .var assembly files found. ' +
      'Set "upp.varDir" in settings, or create an assembly in TheIDE first.'
    );
    return;
  }

  showSelectPackagePanel(
    assemblies,
    activeAssembly?.name,
    activeMainPackage,
    async (assembly, pkgName, pkgDir, uppFile, description) => {
      try {
        console.log(`[UPP] selectAssembly callback START pkg=${pkgName} assembly=${assembly.name}`);
        setActiveAssembly(assembly);
        setActiveMainPackage(pkgName);
        setActivePackageDescription(description);
        setActivePackageUppFile(uppFile);

        updateStatusBar();

        console.log(`[UPP] selectAssembly: calling syncBuildCommand`);
        await syncBuildCommand();
        console.log(`[UPP] selectAssembly: calling switchWorkspace`);
        await switchWorkspace(assembly, pkgName, pkgDir, uppFile, undefined);
        console.log(`[UPP] selectAssembly: switchWorkspace done`);

        const cfgInner = vscode.workspace.getConfiguration('upp');
        await syncCompileCommandsCommand(assembly, pkgName, cfgInner);
        updateCompileCommandsWatcher(assembly, pkgName, outputChannel);
        console.log(`[UPP] selectAssembly callback END pkg=${pkgName}`);
      } catch (err: any) {
        console.error(`[UPP] selectAssembly callback ERROR:`, err);
        vscode.window.showErrorMessage(`UPP: Failed to activate package: ${err.message}`);
      }
    },
    () => newAssembly(),
  );
}

// ─── Package Selection (assembly-scoped) ─────────────────────────────────────

export async function selectPackage() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const varDir: string = cfg.get('varDir', '');
  const enabledAssemblies = cfg.get<string[]>('enabledAssemblies', []);
  const allAssemblies = activeInstallation?.assemblies?.length
    ? activeInstallation.assemblies
    : findAssemblies(varDir);

  const assemblies = enabledAssemblies.length > 0
    ? allAssemblies.filter(a => enabledAssemblies.includes(a.filePath))
    : allAssemblies;

  if (assemblies.length === 0) {
    vscode.window.showWarningMessage(
      'UPP: No .var assembly files found. ' +
      'Set "upp.varDir" in settings, or create an assembly in TheIDE first.'
    );
    return;
  }

  showSelectPackagePanel(
    assemblies,
    activeAssembly?.name,
    activeMainPackage,
    async (assembly, pkgName, pkgDir, uppFile, description) => {
      try {
        setActiveAssembly(assembly);
        setActiveMainPackage(pkgName);
        setActivePackageDescription(description);
        setActivePackageUppFile(uppFile);

        updateStatusBar();

        await syncBuildCommand();
        await switchWorkspace(assembly, pkgName, pkgDir, uppFile, undefined);

        await syncCompileCommandsCommand(assembly, pkgName, cfg);
        updateCompileCommandsWatcher(assembly, pkgName, outputChannel);
      } catch (err: any) {
        vscode.window.showErrorMessage(`UPP: Failed to activate package: ${err.message}`);
      }
    },
    () => newAssembly(),
  );
}

// ─── Config Selection (mainconfig flags from .upp) ────────────────────────────

export async function selectConfig() {
  if (!activeAssembly || !activeMainPackage) {
    vscode.window.showWarningMessage('UPP: No active assembly/package selected.');
    return;
  }

  if (activeAssembly.nests.length === 0) {
    vscode.window.showWarningMessage('UPP: No nest directories found in assembly.');
    return;
  }

  const pkgDir = path.join(
    activeAssembly.nests.find(n =>
      fs.existsSync(path.join(n, activeMainPackage!.replace(/\//g, path.sep)))
    ) ?? activeAssembly.nests[0],
    activeMainPackage.replace(/\//g, path.sep)
  );

  const cfg = vscode.workspace.getConfiguration('upp');
  const pkgLeaf = path.basename(pkgDir);
  const uppFile = path.join(pkgDir, `${pkgLeaf}.upp`);
  const configs = parseMainConfigs(uppFile);
  const current: string = cfg.get('configurationFlag', '');

  let chosenConfig: string | undefined;

  if (configs.length === 0) {
    chosenConfig = await vscode.window.showInputBox({
      prompt: 'Compilation flags (no mainconfig found in .upp)',
      placeHolder: 'e.g. GUI MT',
      value: current,
    });
    if (chosenConfig === undefined) return;
    chosenConfig = chosenConfig.trim();
  } else {
    const picked = await vscode.window.showQuickPick(
      configs.map(c => ({ label: c, picked: c === current })),
      { placeHolder: 'Select main configuration' }
    );
    if (!picked) return;
    chosenConfig = picked.label;
  }

  const configurationFlag = chosenConfig.replace(/\s+/g, ',').replace(/,+/g, ',');
  await cfg.update('configurationFlag', configurationFlag, vscode.ConfigurationTarget.Workspace);
}

export async function setConfig(value: string) {
  const cfg = vscode.workspace.getConfiguration('upp');
  const configurationFlag = value.replace(/\s+/g, ',').replace(/,+/g, ',');
  await cfg.update('configurationFlag', configurationFlag, vscode.ConfigurationTarget.Workspace);
}

// ─── Edit Description ────────────────────────────────────────────────────────

export async function editDescription() {
  if (!activeAssembly || !activeMainPackage || !activePackageUppFile) {
    vscode.window.showWarningMessage('UPP: No active package.');
    return;
  }

  const current = activePackageDescription ?? '';

  const newDesc = await vscode.window.showInputBox({
    prompt: 'Package description',
    placeHolder: 'Enter a description for this package',
    value: current,
  });
  if (newDesc === undefined) return;

  try {
    let content = fs.readFileSync(activePackageUppFile, 'utf8');
    const escaped = newDesc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const replacement = `description "${escaped}\\377";`;

    if (/description\s+"[^"]*\\377[^"]*";/.test(content)) {
      content = content.replace(/description\s+"[^"]*\\377[^"]*";/, replacement);
    } else if (/description\s+"[^"]*";/.test(content)) {
      content = content.replace(/description\s+"[^"]*";/, replacement);
    } else {
      content = replacement + '\n' + content;
    }

    fs.writeFileSync(activePackageUppFile, content, 'utf8');
  } catch (err: any) {
    vscode.window.showErrorMessage(`UPP: Failed to update description: ${err.message}`);
    return;
  }

  setActivePackageDescription(newDesc || undefined);
  updateStatusBar();
  vscode.window.showInformationMessage(`UPP: Description updated.`);
}

// ─── New Package ─────────────────────────────────────────────────────────────

export function newPackage() {
  if (!activeAssembly) {
    vscode.window.showWarningMessage('UPP: Select an assembly first.');
    return;
  }
  showNewPackagePanel(activeAssembly, async (pkgName, pkgDir) => {
    const relativePkg = path.relative(activeAssembly!.nests[0], pkgDir).replace(/\\/g, '/');
    setActiveMainPackage(relativePkg);
    setActivePackageUppFile(path.join(pkgDir, `${pkgName}.upp`));
    try {
      const { parseUppFile } = await import('./assemblyParser');
      const uppMeta = parseUppFile(activePackageUppFile!);
      setActivePackageDescription(uppMeta.description);
    } catch {
      setActivePackageDescription(undefined);
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const buildFlags = vscode.workspace.getConfiguration('upp').get('buildFlags', '') as string;
    if (root) {
      await updateIntelliSense(activeAssembly!, root, relativePkg, buildFlags);
    }
    updateStatusBar();
    vscode.window.showInformationMessage(`UPP: Package "${pkgName}" created and activated.`);
  });
}

export function newAssembly() {
  const cfg = vscode.workspace.getConfiguration('upp');
  const varDir: string = cfg.get('varDir', '');
  const currentAssemblies = findAssemblies(varDir);

  showNewAssemblyPanel(currentAssemblies, async (assembly) => {
    setActiveAssembly(assembly);
    setActiveMainPackage(undefined);
    setActivePackageDescription(undefined);
    setActivePackageUppFile(undefined);
    updateStatusBar();
    vscode.window.showInformationMessage(`UPP: Assembly "${assembly.name}" created and activated.`);
  });
}
