import * as vscode from 'vscode';
import * as path from 'path';
import { Assembly } from './assemblyParser';

class UppItem extends vscode.TreeItem {
  constructor(label: string, description: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (command) this.command = command;
  }
}

export class UppStateProvider implements vscode.TreeDataProvider<UppItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private assembly: Assembly | undefined;
  private mainPackage: string | undefined;
  private packageDescription: string | undefined;
  private packageUppFile: string | undefined;
  private running = false;
  private debugging = false;
  private outputDirPath: string | undefined;
  private debugOutputDirPath: string | undefined;
  private debugCmdText: string | undefined;

  refresh(
    assembly: Assembly | undefined,
    mainPackage: string | undefined,
    isRunning = false,
    packageDescription?: string,
    packageUppFile?: string,
    isDebugging = false,
    outputDirPath?: string,
    debugOutputDirPath?: string,
    debugCmdText?: string,
  ) {
    this.assembly          = assembly;
    this.mainPackage       = mainPackage;
    this.running           = isRunning;
    this.packageDescription = packageDescription;
    this.packageUppFile    = packageUppFile;
    this.debugging         = isDebugging;
    this.outputDirPath     = outputDirPath;
    this.debugOutputDirPath = debugOutputDirPath;
    this.debugCmdText      = debugCmdText;
    this._onDidChangeTreeData.fire();
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(item: UppItem): vscode.TreeItem { return item; }

  getChildren(): UppItem[] {
    const cfg  = vscode.workspace.getConfiguration('upp');
    const none = '—';

    const selectCmd: vscode.Command = {
      command: 'upp.selectAssembly',
      title:   'Select Assembly',
    };
    const selectPkgCmd: vscode.Command = {
      command: 'upp.selectPackage',
      title:   'Select Package',
    };
    const selectMethodCmd: vscode.Command = {
      command: 'upp.selectBuildMethod',
      title:   'Select Build Method',
    };
    const selectLinkModeCmd: vscode.Command = {
      command: 'upp.selectLinkMode',
      title:   'Select Link Mode',
    };
    const selectOutputCmd: vscode.Command = {
      command: 'upp.selectOutput',
      title:   'Select Output Type',
    };
    const settingsCmd: vscode.Command = {
      command:   'workbench.action.openWorkspaceSettings',
      title:     'Open Workspace Settings',
      arguments: ['@ext:aris.upp-umk'],
    };
    const selectConfigCmd: vscode.Command = {
      command: 'upp.selectConfig',
      title:   'Select Config',
    };

    const assemblyName  = this.assembly?.name ?? none;
    const packageName   = this.mainPackage ? path.basename(this.mainPackage) : none;
    const method        = cfg.get<string>('buildMethod', '') || none;
    const linkMode      = cfg.get<string>('linkMode', 'use-shared');
    const linkModeLabel = linkMode === 'all-static' ? 'All Static' : linkMode === 'use-shared' ? 'Use Shared (-s)' : 'All Shared (-S)';
    const buildFlags    = cfg.get<string>('buildFlags',  '');
    const outputLabel   = buildFlags.includes('r') ? 'Release' : 'Debug';
    const extra         = cfg.get<string>('configurationFlag',  '') || none;
    const buildCmdText  = cfg.get<string>('buildCommand', '') || none;
    const buildAction: vscode.Command  = { command: 'upp.build',    title: 'Build Package' };
    const generateClangJsonCmd: vscode.Command = { command: 'upp.generateClangJson', title: 'Generate clang json' };
    const helpCmd: vscode.Command      = { command: 'upp.openHelp', title: 'Help' };

    const runStopCmd: vscode.Command = this.running
      ? { command: 'upp.stopRun', title: 'Stop' }
      : { command: 'upp.run',     title: 'Run'  };
    const runOptionsCmd: vscode.Command = { command: 'upp.editRunOptions', title: 'Run Options' };

    const debugStopCmd: vscode.Command = this.debugging
      ? { command: 'upp.stopDebug', title: 'Stop Debug' }
      : { command: 'upp.debug',     title: 'Debug'  };

    const showLogCmd: vscode.Command = { command: 'upp.showLogs', title: 'Show Package Log' };
    const openOutputDirCmd: vscode.Command = { command: 'upp.openOutputDir', title: 'Open Output Directory' };
    const openDebugOutputDirCmd: vscode.Command = { command: 'upp.openDebugOutputDir', title: 'Open Debug Output Directory' };

    const cppStandard: string = cfg.get('cppStandard', '') || 'c++17 (default)';
    const newProjectCmd: vscode.Command = { command: 'upp.newPackage', title: 'New Package' };
    const scanVarFilesCmd: vscode.Command = { command: 'upp.scanVarFiles', title: 'Scan for Assemblies' };
    const cppStandardCmd: vscode.Command = {
      command:   'workbench.action.openWorkspaceSettings',
      title:     'Edit cppStandard',
      arguments: ['@ext:aris.upp-umk upp.cppStandard'],
    };
    const keybindingsCmd: vscode.Command = {
      command: 'workbench.action.openGlobalKeybindings',
      title:   'Open Keybindings',
    };

    const items: UppItem[] = [
      new UppItem('New Package', '', newProjectCmd),
      new UppItem('Scan for Assemblies', '$(search)', scanVarFilesCmd),
      new UppItem('Assembly', assemblyName,  selectCmd),
      new UppItem('Package',  packageName,   selectPkgCmd),
      new UppItem('Description', this.packageDescription || '(click to set)', {
        command: 'upp.editDescription',
        title: 'Edit Description',
      }),
    ];

    items.push(
      new UppItem('Method',   method,        selectMethodCmd),
      new UppItem('Link Mode', linkModeLabel, selectLinkModeCmd),
      new UppItem('Edit Method', 'settings', { command: 'upp.editBuildMethod', title: 'Edit Build Method' }),
      new UppItem('Output',   outputLabel,   selectOutputCmd),
      new UppItem('Config',   extra !== none ? `+${extra}` : none, selectConfigCmd),
      new UppItem('C++ Standard', cppStandard, cppStandardCmd),
      new UppItem('Generate clang json', '', generateClangJsonCmd),
      new UppItem('Build As', buildCmdText,  buildAction),
      new UppItem(this.running ? '⏹ Stop' : '▶ Run', this.running ? 'running…' : '', runStopCmd),
      new UppItem('Run Options', 'settings', runOptionsCmd),
      new UppItem(this.debugging ? '⏹ Stop Debug' : '🐞 Debug', this.debugging ? 'debugging…' : '', debugStopCmd),
      new UppItem('Debug Cmd', this.debugCmdText || '(not resolved)', debugStopCmd),
      new UppItem('Debug Output Dir', this.debugOutputDirPath || '(not resolved)', openDebugOutputDirCmd),
      new UppItem('Output Dir', this.outputDirPath || '(not resolved)', openOutputDirCmd),
      new UppItem('Show Log', 'package log', showLogCmd),
      new UppItem('Keybindings', 'ctrl+shift+b build · ctrl+shift+q run · ctrl+shift+d debug · ctrl+shift+x stop · alt+l logs', keybindingsCmd),
      new UppItem('Settings', 'open extension settings', settingsCmd),
      new UppItem('Help',     'README',      helpCmd),
    );

    return items;
  }
}
