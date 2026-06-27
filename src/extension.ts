import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runUmk } from './umkRunner';
import { updateIntelliSense } from './intelliSense';
import { UppTaskProvider } from './taskProvider';
import { syncCompileCommandsCommand, updateCompileCommandsWatcher, doCompileCommandsGeneration, disposeCompileCommandsWatcher } from './compileCommands';
import {
  outputChannel, setOutputChannel, statusBarItem, setStatusBarItem,
  setStateProvider, setStateTreeView,
  activeInstallation,
  activeAssembly, activeMainPackage, setIsRunning,
  setIsDebugging, debugTerminal, setDebugTerminal,
  activeRunProcess, setActiveRunProcess,
  setActiveAssembly, setActiveMainPackage,
  setActivePackageDescription, setActivePackageUppFile,
  setActiveInstallation,
  restoreState, updateStatusBar, getActiveState,
} from './state';
import { UppStateProvider } from './sidebarProvider';
import { resolveOutputDir, resolveDebugOutputDir, resolveDebugBinaryPath } from './outputDir';
import { syncBuildCommand, selectBuildParams, selectBuildMethod, selectOutput, selectLinkMode } from './buildCommand';
import { syncWorkspaces } from './workspace';
import { doAction, ensureActiveAssembly } from './actions';
import {
  selectAssembly, selectPackage, selectConfig,
  editDescription, newPackage, newAssembly,
} from './panels';
import { showBuildMethodPanel } from './buildMethodPanel';
import { showRunOptionsPanel } from './runOptionsPanel';
import { findBuildMethods } from './assemblyParser';
import { scanInstallations, UppInstallation } from './installations';

// ─── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  const ch = vscode.window.createOutputChannel('UPP Build');
  setOutputChannel(ch);
  context.subscriptions.push(ch);

  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sb.command = 'upp.selectAssembly';
  setStatusBarItem(sb);
  context.subscriptions.push(sb);

  const sp = new UppStateProvider();
  setStateProvider(sp);
  const tv = vscode.window.createTreeView('upp.stateView', { treeDataProvider: sp });
  setStateTreeView(tv);
  context.subscriptions.push(tv);

  restoreState();
  updateStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      restoreState();
      updateStatusBar();
    })
  );

  if (activeAssembly) {
    setTimeout(() => {
      const items = sp.getChildren();
      if (items.length > 0) {
        tv.reveal(items[0], { select: false, focus: true }).then(() => {}, () => {});
      }
    }, 500);
  }

  const cfg = vscode.workspace.getConfiguration('upp');
  const workspacesDir = cfg.get<string>('workspacesDir', '');

  if (!workspacesDir) {
    const choice = await vscode.window.showInformationMessage(
      'UPP: Configure workspace directory to enable workspace management.\n' +
      'You can change the location later in settings, but it will be set automatically to: ~/.vscode/workspaces/',
      'Set Automatically', 'Open Settings', 'Later'
    );
    if (choice === 'Set Automatically') {
      const dir = path.join(os.homedir(), '.vscode', 'workspaces');
      await cfg.update('workspacesDir', dir, vscode.ConfigurationTarget.Global);
    } else if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:arilect.upp-umk');
    }
  }

  if (!activeInstallation) {
    const found = scanInstallations();
    if (found.length === 1) {
      setActiveInstallation(found[0]);
      const activeInstallPath = found[0].path;
      await cfg.update('activeInstallation', activeInstallPath, vscode.ConfigurationTarget.Global);
      const umkPath = path.join(activeInstallPath, process.platform === 'win32' ? 'umk.exe' : 'umk');
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
    } else if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map(inst => ({
          label: inst.label,
          description: inst.path,
          detail: `${inst.assemblies.length} assembly(ies)`,
          installation: inst,
        })),
        { placeHolder: 'Multiple U++ installations found. Select one:' }
      );
      if (picked) {
        setActiveInstallation(picked.installation);
        await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
        const umkPath = path.join(picked.installation.path, process.platform === 'win32' ? 'umk.exe' : 'umk');
        await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      }
    }
  }

  syncBuildCommand().catch(err => console.warn('UPP: syncBuildCommand failed:', err));

  context.subscriptions.push(
    vscode.commands.registerCommand('upp.selectInstallation', async () => {
      const found = scanInstallations();
      if (found.length === 0) {
        vscode.window.showWarningMessage('UPP: No U++ installations found. Install U++ or check upp.installationsPaths setting.');
        return;
      }
      const currentPath = activeInstallation?.path;
      const picked = await vscode.window.showQuickPick(
        found.map(inst => ({
          label: inst.label,
          description: inst.path === currentPath ? '$(check) active' : '',
          detail: `${inst.assemblies.length} assembly(ies)`,
          installation: inst,
        })),
        { placeHolder: 'Select U++ installation' }
      );
      if (!picked) return;
      setActiveInstallation(picked.installation);
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
      const umkPath = path.join(picked.installation.path, process.platform === 'win32' ? 'umk.exe' : 'umk');
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Switched to "${picked.installation.label}"`);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.selectAssembly',     () => selectAssembly()),
    vscode.commands.registerCommand('upp.selectPackage',      () => selectPackage()),
    vscode.commands.registerCommand('upp.selectConfig',       () => selectConfig()),
    vscode.commands.registerCommand('upp.selectBuildMethod',  () => selectBuildMethod()),
    vscode.commands.registerCommand('upp.selectLinkMode',     () => selectLinkMode()),
    vscode.commands.registerCommand('upp.selectOutput',       () => selectOutput()),
    vscode.commands.registerCommand('upp.editDescription',    () => editDescription()),
    vscode.commands.registerCommand('upp.selectBuildParams',  async () => {
      if (!(await ensureActiveAssembly())) return;
      if (!activeAssembly!.nests.length) {
        vscode.window.showWarningMessage('UPP: No nest directories found in assembly.');
        return;
      }
      const pkgDir = activeMainPackage
        ? path.join(
            activeAssembly!.nests.find(n =>
              fs.existsSync(path.join(n, activeMainPackage!.replace(/\//g, path.sep)))
            ) ?? activeAssembly!.nests[0],
            activeMainPackage!.replace(/\//g, path.sep)
          )
        : activeAssembly!.nests[0];
      await selectBuildParams(pkgDir);
    }),
    vscode.commands.registerCommand('upp.build',              () => doAction('build')),
    vscode.commands.registerCommand('upp.run',                () => doAction('run')),
    vscode.commands.registerCommand('upp.rebuild',            () => doAction('rebuild')),
    vscode.commands.registerCommand('upp.stopRun', () => {
      const proc = activeRunProcess;
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      }
      setActiveRunProcess(undefined);
      setIsRunning(false);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.debug', async () => {
      if (!(await ensureActiveAssembly())) return;

      const cfg = vscode.workspace.getConfiguration('upp');
      const configuredUmk = cfg.get<string>('umkPath', '');
      const umkPath: string = configuredUmk || (activeInstallation
        ? path.join(activeInstallation.path, process.platform === 'win32' ? 'umk.exe' : 'umk')
        : 'umk');
      const assemblyName = activeAssembly!.name;
      const mainPackage  = activeMainPackage!;
      const buildMethod  = cfg.get('buildMethod', 'CLANG');
      let   configurationFlag = cfg.get('configurationFlag', '');
      const outPath      = cfg.get('outPath', '');
      const runArgs: string = cfg.get('runArgs', '');
      const guiMode      = cfg.get<'auto' | 'gui' | 'console'>('guiMode', 'auto');

      const buildFlagsRaw = cfg.get('buildFlags', '').split('').filter((c: string) => c !== 's' && c !== 'S').join('');
      const linkMode: string = cfg.get('linkMode', 'use-shared');
      let linkFlag = '';
      if (linkMode === 'use-shared') linkFlag = 's';
      else if (linkMode === 'all-shared') linkFlag = 'S';
      const buildFlags = buildFlagsRaw.replace(/[dr]/g, '') + linkFlag;

      if (guiMode === 'gui') {
        const flags = new Set(configurationFlag.split(',').filter(Boolean));
        flags.add('GUI');
        configurationFlag = [...flags].join(',');
      } else if (guiMode === 'console') {
        const flags = new Set(configurationFlag.split(',').filter(Boolean));
        flags.delete('GUI');
        configurationFlag = [...flags].join(',');
      }

      try {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'UPP: Building for debug...',
          cancellable: false,
        }, async (progress) => {
          progress.report({ message: 'Running umk build...' });
          await runUmk({
            umkPath,
            assemblyName,
            mainPackage,
            buildMethod,
            buildFlags,
            configurationFlag,
            outPath,
            action: 'build',
            outputChannel,
            showOutput: 'auto',
            uppEnv: activeInstallation?.path,
          });
          progress.report({ increment: 100, message: 'Build done' });
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(`UPP debug build failed: ${err.message}`);
        return;
      }

      const binaryPath = resolveDebugBinaryPath(activeAssembly?.name, activeMainPackage);
      const debuggerPath = cfg.get('debuggerPath', 'gdb');
      const folder = vscode.workspace.workspaceFolders?.[0];
      const cwd = folder?.uri.fsPath ?? path.dirname(binaryPath);

      const nativeDebug = vscode.extensions.getExtension('webfreak.debug');
      const cpptools = vscode.extensions.getExtension('ms-vscode.cpptools');

      if (nativeDebug || cpptools) {
        try {
          const args = runArgs ? runArgs.split(/\s+/).filter(Boolean) : [];

          let launchConfig: any;
          if (nativeDebug) {
            launchConfig = {
              name: 'UPP: Debug',
              type: 'gdb',
              request: 'launch',
              target: binaryPath,
              cwd,
              arguments: runArgs || undefined,
              gdbpath: debuggerPath,
            };
          } else {
            launchConfig = {
              name: 'UPP: Debug',
              type: 'cppdbg',
              request: 'launch',
              program: binaryPath,
              args,
              stopAtEntry: false,
              cwd,
              environment: [],
              externalConsole: false,
              MIMode: 'gdb',
              miDebuggerPath: debuggerPath,
              setupCommands: [
                { text: '-enable-pretty-printing', description: 'Enable pretty printing', ignoreFailures: true },
              ],
            };
          }

          const vscodeDir = path.join(cwd, '.vscode');
          const launchJsonPath = path.join(vscodeDir, 'launch.json');
          const launchJson = {
            version: '0.2.0',
            configurations: [launchConfig],
          };

          if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
          }
          fs.writeFileSync(launchJsonPath, JSON.stringify(launchJson, null, 4) + '\n', 'utf8');

          setIsDebugging(true);
          updateStatusBar();
          await vscode.debug.startDebugging(folder, launchConfig);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP debug failed: ${err.message}`);
          setIsDebugging(false);
          updateStatusBar();
        }
      } else {
        let terminal = debugTerminal;
        if (terminal && terminal.exitStatus !== undefined) {
          terminal.dispose();
          terminal = undefined;
          setDebugTerminal(undefined);
        }
        if (!terminal) {
          terminal = vscode.window.createTerminal({ name: 'UPP: Debug' });
          setDebugTerminal(terminal);
        }
        terminal.show(false);
        terminal.sendText(`${debuggerPath} "${binaryPath}"`);
        setIsDebugging(true);
        updateStatusBar();

        vscode.window.showInformationMessage(
          'UPP: Opening gdb in terminal. For breakpoints/stepping in VS Code, install "Native Debug" (webfreak.debug).'
        );
      }
    }),
    vscode.commands.registerCommand('upp.stopDebug', () => {
      const activeDebugSession = vscode.debug.activeDebugSession;
      if (activeDebugSession) {
        vscode.debug.stopDebugging(activeDebugSession);
      }
      let terminal = debugTerminal;
      if (terminal && terminal.exitStatus === undefined) {
        terminal.sendText('\x03', false);
      }
      setIsDebugging(false);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.showLogs', async () => {
      const pkgLeaf = path.basename(activeMainPackage ?? '');
      const logPath = path.join(os.homedir(), '.local', 'state', 'u++', 'log', `${pkgLeaf}.log`);
      if (fs.existsSync(logPath)) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage(`UPP: No log file found for package "${pkgLeaf}". Run the package first.`);
      }
    }),
    vscode.commands.registerCommand('upp.openOutputDir', () => {
      if (!activeAssembly || !activeMainPackage) {
        vscode.window.showWarningMessage('UPP: No active assembly/package selected.');
        return;
      }
      const outputDir = resolveOutputDir(activeMainPackage);
      if (fs.existsSync(outputDir)) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
      } else {
        vscode.window.showWarningMessage(`UPP: Output directory not found: ${outputDir}. Build the project first.`);
      }
    }),
    vscode.commands.registerCommand('upp.openDebugOutputDir', () => {
      if (!activeAssembly || !activeMainPackage) {
        vscode.window.showWarningMessage('UPP: No active assembly/package selected.');
        return;
      }
      const debugDir = resolveDebugOutputDir(activeAssembly.name, activeMainPackage);
      if (fs.existsSync(debugDir)) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(debugDir));
      } else {
        vscode.window.showWarningMessage(`UPP: Debug output directory not found: ${debugDir}. Build the project first.`);
      }
    }),
    vscode.commands.registerCommand('upp.openHelp', () => {
      const readmeUri = vscode.Uri.joinPath(context.extensionUri, 'README.md');
      vscode.commands.executeCommand('markdown.showPreview', readmeUri);
    }),
    vscode.commands.registerCommand('upp.updateIntelliSense', async () => {
      if (!(await ensureActiveAssembly())) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!root) return;
      const cfg = vscode.workspace.getConfiguration('upp');
      const buildFlags = cfg.get('buildFlags', '');
      await updateIntelliSense(activeAssembly!, root, activeMainPackage, buildFlags);
    }),
    vscode.commands.registerCommand('upp.generateCompileCommands', async () => {
      if (!(await ensureActiveAssembly())) return;
      const cfg = vscode.workspace.getConfiguration('upp');
      const mode: string = cfg.get('compileCommandsMode', 'off');
      if (mode === 'off') {
        vscode.window.showInformationMessage(
          'UPP: compile_commands.json generation is off. ' +
          'Set "upp.compileCommandsMode" to "manual" or "auto" in settings.'
        );
        return;
      }
      await doCompileCommandsGeneration(activeAssembly!, activeMainPackage!, outputChannel);
    }),
    vscode.commands.registerCommand('upp.generateClangJson', async () => {
      if (!(await ensureActiveAssembly())) return;
      await doCompileCommandsGeneration(activeAssembly!, activeMainPackage!, outputChannel);
    }),
    vscode.commands.registerCommand('upp.syncWorkspaces', async () => {
      await syncWorkspaces();
    }),
    vscode.commands.registerCommand('upp.newPackage', () => newPackage()),
    vscode.commands.registerCommand('upp.newAssembly', () => newAssembly()),
    vscode.commands.registerCommand('upp.editBuildMethod', async () => {
      const cfg = vscode.workspace.getConfiguration('upp');
      const varDir: string = cfg.get('varDir', '');
      const currentMethod: string = cfg.get('buildMethod', 'CLANG');
      const bms = findBuildMethods(varDir);
      const bm = bms.find(b => b.name === currentMethod || b.filePath === currentMethod);
      if (!bm) {
        vscode.window.showWarningMessage(`UPP: Build method "${currentMethod}" not found.`);
        return;
      }
      showBuildMethodPanel(bm.filePath);
    }),
    vscode.commands.registerCommand('upp.editRunOptions', () => showRunOptionsPanel()),
    vscode.commands.registerCommand('upp.scanInstallations', async () => {
      const found = scanInstallations();
      if (found.length === 0) {
        vscode.window.showWarningMessage('UPP: No U++ installations found. Check upp.installationsPaths setting.');
        return;
      }
      const currentPath = activeInstallation?.path;
      const picked = await vscode.window.showQuickPick(
        found.map(inst => ({
          label: inst.label,
          description: inst.path === currentPath ? '$(check) active' : '',
          detail: `${inst.assemblies.length} assembly(ies): ${inst.assemblies.map(a => a.name).join(', ')}`,
          installation: inst,
        })),
        { placeHolder: 'Select a U++ installation to activate' }
      );
      if (!picked) return;
      setActiveInstallation(picked.installation);
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
      const umkPath = path.join(picked.installation.path, process.platform === 'win32' ? 'umk.exe' : 'umk');
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      updateStatusBar();
      vscode.window.showInformationMessage(`UPP: Installation "${picked.installation.label}" activated with ${picked.installation.assemblies.length} assembly(ies).`);
    })
  );

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      UppTaskProvider.taskType,
      new UppTaskProvider(getActiveState)
    )
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(t => {
      let dbgTerm = debugTerminal;
      if (t === dbgTerm) {
        setDebugTerminal(undefined);
        setIsDebugging(false);
        updateStatusBar();
      }
    })
  );

  // Detect when a debug session ends
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      setIsDebugging(false);
      updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('upp')) {
        restoreState();
        updateStatusBar();
        if (
          e.affectsConfiguration('upp.buildMethod') ||
          e.affectsConfiguration('upp.buildFlags')  ||
          e.affectsConfiguration('upp.linkMode')  ||
          e.affectsConfiguration('upp.configurationFlag')  ||
          e.affectsConfiguration('upp.outPath')
        ) {
          syncBuildCommand().catch(err => console.warn('UPP: syncBuildCommand failed:', err));
        }
        if (
          (e.affectsConfiguration('upp.buildMethod') ||
           e.affectsConfiguration('upp.configurationFlag')) &&
          activeAssembly && activeMainPackage
        ) {
          syncCompileCommandsCommand(activeAssembly, activeMainPackage, vscode.workspace.getConfiguration('upp'))
            .catch(err => console.warn('UPP: syncCompileCommandsCommand failed:', err));
        }
        if (e.affectsConfiguration('upp.compileCommandsMode')) {
          updateCompileCommandsWatcher(activeAssembly, activeMainPackage, outputChannel);
        }
      }
    })
  );

  if (activeAssembly && activeMainPackage) {
    const cfg = vscode.workspace.getConfiguration('upp');
    const mode: string = cfg.get('compileCommandsMode', 'off');
    if (mode === 'auto') {
      updateCompileCommandsWatcher(activeAssembly, activeMainPackage, outputChannel);
    }
    syncCompileCommandsCommand(activeAssembly, activeMainPackage, cfg);
  }
}

export function deactivate() {
  disposeCompileCommandsWatcher();
  const proc = activeRunProcess;
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    setActiveRunProcess(undefined);
  }
  let dt = debugTerminal;
  if (dt) {
    dt.dispose();
    setDebugTerminal(undefined);
  }
  outputChannel?.dispose();
  statusBarItem?.dispose();
}
