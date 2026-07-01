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
  setStateProvider,
  activeInstallation,
  activeAssembly, activeMainPackage, setIsRunning,
  setIsDebugging, debugTerminal, setDebugTerminal,
  activeRunProcess, setActiveRunProcess, activeRunTerminal, setActiveRunTerminal, killProcess,
  setActiveAssembly, setActiveMainPackage,
  setActivePackageDescription, setActivePackageUppFile,
  activePackageDescription, activePackageUppFile,
  setActiveInstallation,
  restoreState, updateStatusBar, getActiveState,
} from './state';
import { UppSidebarProvider } from './sidebarProvider';
import { resolveDebugOutputDir, resolveBinaryPath } from './outputDir';
import { syncBuildCommand, selectBuildParams, selectBuildMethod, selectOutput, selectLinkMode, setOutput, setLinkMode } from './buildCommand';
import { syncWorkspaces, getWorkspaceFilePath, ensureWorkspaceFile } from './workspace';
import { doAction, ensureActiveAssembly, cleanBuildOutput } from './actions';
import { resolveUmkPath } from './utils';
import {
  selectAssembly, selectPackage, selectConfig, setConfig,
  editDescription, newPackage, newAssembly,
} from './panels';
import { showRunOptionsPanel } from './runOptionsPanel';
import { showInstallationsPanel } from './installationsPanel';
import { showConfigFlagsPanel } from './configFlagsPanel';
import { showCppStandardPanel } from './cppStandardPanel';
import { showBuildEditPanel } from './buildEditPanel';
import { showBuildMethodPanel, refreshBuildMethodPanel } from './buildMethodPanel';
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

  const sp = new UppSidebarProvider();
  setStateProvider(sp);
  const tv = vscode.window.registerWebviewViewProvider(UppSidebarProvider.viewType, sp, { webviewOptions: { retainContextWhenHidden: true } });
  context.subscriptions.push(tv);

  restoreState();
  updateStatusBar();

  // Check if workspace file name matches active package
  const wsFile = vscode.workspace.workspaceFile;
  if (wsFile?.scheme === 'file' && activeMainPackage && activeAssembly) {
    const wsBaseName = path.basename(wsFile.fsPath, '.code-workspace');
    const pkgBaseName = path.basename(activeMainPackage);
    if (wsBaseName !== pkgBaseName) {
      const correctWsPath = getWorkspaceFilePath(activeAssembly, activeMainPackage);
      const correctWsExists = fs.existsSync(correctWsPath);

      const panel = vscode.window.createWebviewPanel(
        'uppMismatch', 'UPP: Workspace/Package Mismatch',
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      panel.webview.html = `<!DOCTYPE html><html><head><style>
        body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:20px;}
        h2{color:#f44;}
        .ws{background:var(--vscode-input-background);padding:8px 12px;border-radius:4px;margin:8px 0;}
        button{padding:6px 16px;border:none;border-radius:2px;cursor:pointer;font-size:0.9em;margin:4px 4px 4px 0;}
        .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
        .btn-danger{background:var(--vscode-errorForeground);color:#fff;}
      </style></head><body>
        <h2>Workspace / Package Mismatch</h2>
        <p>The workspace file and active package do not match:</p>
        <div class="ws"><b>Workspace:</b> ${escHtml(wsBaseName)}</div>
        <div class="ws"><b>Package:</b> ${escHtml(pkgBaseName)}</div>
        <p>This means that AI (artificial idiot) was not able to fix the bug in the switch workspace chain. Delete workspace file, start again and pray.</p>
        <br/>
        <button class="btn-primary" id="btnRecreate">Recreate workspace from ${escHtml(pkgBaseName)}.upp</button>
        <div id="status" style="margin-top:12px;opacity:0.8;"></div>
        <script>
          const vscode = acquireVsCodeApi();
          document.getElementById('btnRecreate').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Working...';
            vscode.postMessage({ type: 'recreate' });
          });
          window.addEventListener('message', (e) => {
            if (e.data.type === 'status') {
              document.getElementById('status').textContent = e.data.text;
            }
          });
        </script>
      </body></html>`;

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'recreate') {
          try {
            const pkgDir = activeAssembly!.nests
              .map(n => path.join(n, activeMainPackage!.replace(/\//g, path.sep)))
              .find(d => fs.existsSync(d));

            if (!pkgDir) {
              panel.webview.postMessage({ type: 'status', text: 'Package directory not found.' });
              return;
            }

            const leaf = path.basename(pkgDir);
            const uppFile = path.join(pkgDir, `${leaf}.upp`);

            if (correctWsExists) {
              const choice = await vscode.window.showWarningMessage(
                `Workspace "${pkgBaseName}.code-workspace" already exists. Switch to it?`,
                'Switch', 'Delete & Recreate', 'Cancel'
              );
              if (choice === 'Switch') {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(correctWsPath), false);
                return;
              }
              if (choice === 'Delete & Recreate') {
                try { fs.unlinkSync(correctWsPath); } catch { /* ignore */ }
              } else {
                return;
              }
            }

            const wsCreated = ensureWorkspaceFile(activeAssembly!, activeMainPackage!, pkgDir, uppFile);
            if (wsCreated) {
              panel.webview.postMessage({ type: 'status', text: `Created: ${path.basename(wsCreated)}` });
              await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsCreated), false);
            } else {
              panel.webview.postMessage({ type: 'status', text: 'Failed to create workspace file.' });
            }
          } catch (err: any) {
            panel.webview.postMessage({ type: 'status', text: `Error: ${err.message}` });
          }
        }
      });
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      console.log(`[UPP] onDidChangeWorkspaceFolders: updateStatusBar only (no restoreState)`);
      updateStatusBar();
    })
  );

  if (activeAssembly) {
    setTimeout(() => {
      sp.refresh(activeInstallation, activeAssembly, activeMainPackage, false, activePackageDescription, activePackageUppFile, false, undefined, undefined, undefined);
    }, 500);
  }

  const cfg = vscode.workspace.getConfiguration('upp');
  const workspacesDir = cfg.get<string>('workspacesDir', '');

  if (!workspacesDir && !cfg.get<boolean>('workspacesDirPrompted')) {
    const choice = await vscode.window.showInformationMessage(
      'UPP: You can optionally configure a workspace directory for advanced workspace management.',
      'Got it', 'Open Settings', 'Later'
    );
    if (choice === 'Got it') {
      await cfg.update('workspacesDirPrompted', true, vscode.ConfigurationTarget.Global);
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
      const umkPath = process.platform === 'win32' ? path.join(activeInstallPath, 'umk.exe') : 'umk';
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
    } else if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map(inst => ({
          label: inst.label,
          description: inst.path,
          detail: `${inst.assemblies.length} assembly(ies)`,
          installation: inst,
        })),
        { placeHolder: 'Multiple U++ source trees found. Select one:' }
      );
      if (picked) {
        setActiveInstallation(picked.installation);
        await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
        const umkPath = process.platform === 'win32' ? path.join(picked.installation.path, 'umk.exe') : 'umk';
        await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      }
    }
  }

  // On non-Windows, override build method default if still at Windows default
  if (process.platform !== 'win32') {
    const bm = cfg.get<string>('buildMethod', '');
    if (bm === 'CLANGx64') {
      await cfg.update('buildMethod', 'CLANG', vscode.ConfigurationTarget.Global);
    }
    const lm = cfg.get<string>('linkMode', '');
    if (lm === 'all-static') {
      await cfg.update('linkMode', 'use-shared', vscode.ConfigurationTarget.Global);
    }
  }

  // Fix stale umkPath on non-Windows: if it contains a slash, it's a full path from a previous session
  if (process.platform !== 'win32') {
    const umkPathVal = cfg.get<string>('umkPath', '');
    if (umkPathVal && umkPathVal.includes('/')) {
      console.log(`[UPP] activation: fixing stale umkPath "${umkPathVal}" → "umk"`);
      await cfg.update('umkPath', 'umk', vscode.ConfigurationTarget.Workspace);
    }
    const buildCmd = cfg.get<string>('buildCommand', '');
    if (buildCmd) {
      const umkPrefix = buildCmd.split(/\s/)[0];
      if (umkPrefix && umkPrefix.includes('/')) {
        const fixed = 'umk' + buildCmd.slice(umkPrefix.length);
        console.log(`[UPP] activation: fixing stale buildCommand "${buildCmd}" → "${fixed}"`);
        await cfg.update('buildCommand', fixed, vscode.ConfigurationTarget.Workspace);
        await cfg.update('debugCommand', (cfg.get<string>('debugCommand', '') || '').replace(umkPrefix, 'umk'), vscode.ConfigurationTarget.Workspace);
        await cfg.update('releaseCommand', (cfg.get<string>('releaseCommand', '') || '').replace(umkPrefix, 'umk'), vscode.ConfigurationTarget.Workspace);
      }
    }
  }

  syncBuildCommand().catch(err => console.warn('UPP: syncBuildCommand failed:', err));

  // Cleanup stale compile_commands.json from previous sessions
  // so the C++ extension doesn't show compiler path errors on unrelated actions.
  if (activeAssembly?.nests) {
    for (const nest of activeAssembly.nests) {
      if (!fs.existsSync(nest)) continue;
      const rootCc = path.join(nest, 'compile_commands.json');
      if (fs.existsSync(rootCc)) try { fs.unlinkSync(rootCc); } catch {}
      for (const entry of fs.readdirSync(nest, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ccPath = path.join(nest, entry.name, 'compile_commands.json');
        if (fs.existsSync(ccPath)) try { fs.unlinkSync(ccPath); } catch {}
      }
    }
  }

  // Regenerate IntelliSense config to reflect current file state
  // (removes stale compileCommands references if the file was just deleted)
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (activeAssembly && wsRoot) {
    updateIntelliSense(activeAssembly, wsRoot, activeMainPackage, cfg.get('buildFlags', ''))
      .catch(err => console.warn('UPP: updateIntelliSense failed:', err));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('upp.selectInstallation', async () => {
      const found = scanInstallations();
      if (found.length === 0) {
        vscode.window.showWarningMessage('UPP: No U++ source trees found. Install U++ or check upp.installationsPaths setting.');
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
        { placeHolder: 'Select U++ source tree' }
      );
      if (!picked) return;
      setActiveInstallation(picked.installation);
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
      const umkPath = process.platform === 'win32' ? path.join(picked.installation.path, 'umk.exe') : 'umk';
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Switched to "${picked.installation.label}"`);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.selectAssembly',     () => selectAssembly()),
    vscode.commands.registerCommand('upp.selectPackage',      () => selectPackage()),
    vscode.commands.registerCommand('upp.selectConfig',       () => selectConfig()),
    vscode.commands.registerCommand('upp.setConfig',          (value: string) => setConfig(value)),
    vscode.commands.registerCommand('upp.selectBuildMethod',  () => selectBuildMethod()),
    vscode.commands.registerCommand('upp.selectLinkMode',     () => selectLinkMode()),
    vscode.commands.registerCommand('upp.setLinkMode',        (value: string) => setLinkMode(value as 'all-static' | 'use-shared' | 'all-shared')),
    vscode.commands.registerCommand('upp.selectOutput',       () => selectOutput()),
    vscode.commands.registerCommand('upp.setOutput',          (value: string) => setOutput(value as 'Debug' | 'Release')),
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
    vscode.commands.registerCommand('upp.copyRunPath', () => {
      const cfg = vscode.workspace.getConfiguration('upp');
      const binaryPath = resolveBinaryPath(activeInstallation, activeAssembly, activeMainPackage, cfg.get('buildMethod', ''), cfg.get('buildFlags', ''));
      if (binaryPath) {
        vscode.env.clipboard.writeText(binaryPath);
        vscode.window.showInformationMessage(`UPP: Copied to clipboard: ${binaryPath}`);
      }
    }),
    vscode.commands.registerCommand('upp.rebuild',            () => doAction('rebuild')),
    vscode.commands.registerCommand('upp.cleanBuild',        () => cleanBuildOutput()),
    vscode.commands.registerCommand('upp.editBuildOptions',  () => showBuildEditPanel()),
    vscode.commands.registerCommand('upp.toggleStopOnErrors', async () => {
      const cfg = vscode.workspace.getConfiguration('upp');
      const current = cfg.get<boolean>('stopOnErrors', false);
      await cfg.update('stopOnErrors', !current, vscode.ConfigurationTarget.Workspace);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.syncAndRefresh', () => {
      syncBuildCommand().catch(err => console.warn('UPP: syncBuildCommand failed:', err));
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.stopRun', () => {
      killProcess(activeRunProcess);
      setActiveRunProcess(undefined);
      if (activeRunTerminal && activeRunTerminal.exitStatus === undefined) {
        activeRunTerminal.dispose();
        setActiveRunTerminal(undefined);
      }
      setIsRunning(false);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('upp.debug', async () => {
      if (!(await ensureActiveAssembly())) return;

      const cfg = vscode.workspace.getConfiguration('upp');
      const umkPath = resolveUmkPath(cfg, activeInstallation);
      const assemblyName = activeAssembly!.name;
      const mainPackage  = activeMainPackage!;
      const buildMethod  = cfg.get('buildMethod', 'CLANG');
      let   configurationFlag = cfg.get('configurationFlag', '');
      const outPath      = cfg.get('outPath', '');
      const runArgs: string = cfg.get('runArgs', '');
      const guiMode      = cfg.get<'auto' | 'gui' | 'console'>('guiMode', 'auto');

      const buildFlagsRaw = cfg.get('buildFlags', '').split('').filter((c: string) => c !== 's' && c !== 'S').join('');
      const linkMode: string = cfg.get('linkMode', 'all-static');
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

      const binaryPath = resolveBinaryPath(activeInstallation, activeAssembly, activeMainPackage, cfg.get('buildMethod', ''), cfg.get('buildFlags', ''));
      if (!fs.existsSync(binaryPath)) {
        vscode.window.showErrorMessage(`UPP: Debug binary not found at "${binaryPath}". Build the project first and verify the output path.`);
        return;
      }
      const debuggerPath = (() => {
        // First check user setting
        const custom = cfg.get<string>('debuggerPath', '');
        if (custom) return custom;

        // Read DEBUGGER and PATH from the .bm file
        const { parseBmFile } = require('./assemblyParser') as typeof import('./assemblyParser');
        const varDir = cfg.get<string>('varDir', '');
        const { findBuildMethods } = require('./assemblyParser') as typeof import('./assemblyParser');
        const bms = findBuildMethods(varDir);
        const bm = bms.find((b: any) => b.name === buildMethod || b.filePath === buildMethod);
        if (bm) {
          const data = parseBmFile(bm.filePath);
          const dbgName = data.DEBUGGER || 'gdb';
          // If it's already a full path, use it
          if (path.isAbsolute(dbgName) && fs.existsSync(dbgName)) return dbgName;
          // Search PATH directories from the .bm file
          const bmDir = path.dirname(bm.filePath);
          const searchPaths = [bmDir];
          if (data.PATH) {
            data.PATH.split(';').filter(Boolean).forEach((p: string) => searchPaths.push(p));
          }
          // Also search the U++ installation bin dirs
          if (activeInstallation?.path) {
            searchPaths.push(path.join(activeInstallation.path, 'bin', 'clang', 'bin'));
            searchPaths.push(path.join(activeInstallation.path, 'bin', 'clang', 'x86_64-w64-mingw32', 'bin'));
          }
          for (const dir of searchPaths) {
            const exe = path.join(dir, dbgName + (process.platform === 'win32' ? '.exe' : ''));
            if (fs.existsSync(exe)) return exe;
            // Also try lldb-mi as fallback on Windows
            if (process.platform === 'win32') {
              const lldbMi = path.join(dir, 'lldb-mi.exe');
              if (fs.existsSync(lldbMi)) return lldbMi;
            }
          }
        }
        return process.platform === 'win32' ? 'lldb-mi' : 'gdb';
      })();
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
      const outputDir = path.dirname(resolveBinaryPath(activeInstallation, activeAssembly, activeMainPackage, cfg.get('buildMethod', ''), cfg.get('buildFlags', '')));
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
      const debugDir = resolveDebugOutputDir(activeInstallation, activeAssembly, activeMainPackage);
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
    vscode.commands.registerCommand('upp.openKeybindings', () => {
      vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'UPP:');
    }),
    vscode.commands.registerCommand('upp.showExtensionLogs', () => {
      vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
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
    vscode.commands.registerCommand('upp.editRunOptions', () => showRunOptionsPanel()),
    vscode.commands.registerCommand('upp.editConfigFlags', () => showConfigFlagsPanel()),
    vscode.commands.registerCommand('upp.editCppStandard', () => showCppStandardPanel()),
    vscode.commands.registerCommand('upp.setCppStandard', async (value: string) => {
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('cppStandard', value, vscode.ConfigurationTarget.Workspace);
    }),
    vscode.commands.registerCommand('upp.setBuildMethod', async (value: string) => {
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('buildMethod', value, vscode.ConfigurationTarget.Workspace);
      await syncBuildCommand();
      updateStatusBar();
      const varDir = cfg.get<string>('varDir', '');
      refreshBuildMethodPanel(value, varDir);
    }),
    vscode.commands.registerCommand('upp.editBuildCmd', async () => {
      const cfg = vscode.workspace.getConfiguration('upp');
      const current = cfg.get<string>('buildCommand', '');
      const edited = await vscode.window.showInputBox({
        prompt: 'Edit build command',
        value: current,
        placeHolder: 'umk assembly package method -flags +config',
      });
      if (edited !== undefined && edited !== current) {
        console.log(`[UPP] editBuildCmd → buildCommand = "${edited}"`);
        await cfg.update('buildCommand', edited, vscode.ConfigurationTarget.Workspace);
        updateStatusBar();
      }
    }),
    vscode.commands.registerCommand('upp.editBuildMethod', (filePath?: string) => {
      if (filePath) {
        showBuildMethodPanel(filePath);
        return;
      }
      const cfg = vscode.workspace.getConfiguration('upp');
      const bmName = cfg.get<string>('buildMethod', '');
      if (!bmName) {
        vscode.window.showWarningMessage('UPP: No build method selected.');
        return;
      }
      const varDir = cfg.get<string>('varDir', '');
      const bms = findBuildMethods(varDir);
      const bm = bms.find(b => b.name === bmName || b.filePath === bmName);
      if (!bm) {
        vscode.window.showWarningMessage(`UPP: Build method "${bmName}" not found.`);
        return;
      }
      showBuildMethodPanel(bm.filePath);
    }),
    vscode.commands.registerCommand('upp.editInstallations', () => showInstallationsPanel()),
    vscode.commands.registerCommand('upp.scanInstallations', async () => {
      const found = scanInstallations();
      if (found.length === 0) {
        vscode.window.showWarningMessage('UPP: No U++ source trees found. Check upp.installationsPaths setting.');
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
        { placeHolder: 'Select a U++ source tree' }
      );
      if (!picked) return;
      setActiveInstallation(picked.installation);
      const cfg = vscode.workspace.getConfiguration('upp');
      await cfg.update('activeInstallation', picked.installation.path, vscode.ConfigurationTarget.Global);
      const umkPath = process.platform === 'win32' ? path.join(picked.installation.path, 'umk.exe') : 'umk';
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      updateStatusBar();
      vscode.window.showInformationMessage(`UPP: Source tree "${picked.installation.label}" selected with ${picked.installation.assemblies.length} assembly(ies).`);
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
      if (t === activeRunTerminal) {
        setActiveRunTerminal(undefined);
        setIsRunning(false);
        updateStatusBar();
      }
      if (t === debugTerminal) {
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

}

export function deactivate() {
  disposeCompileCommandsWatcher();
  killProcess(activeRunProcess);
  setActiveRunProcess(undefined);
  if (activeRunTerminal && activeRunTerminal.exitStatus === undefined) {
    activeRunTerminal.dispose();
    setActiveRunTerminal(undefined);
  }
  if (debugTerminal && debugTerminal.exitStatus === undefined) {
    debugTerminal.dispose();
    setDebugTerminal(undefined);
  }
  outputChannel?.dispose();
  statusBarItem?.dispose();
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
