import * as vscode from 'vscode';
import * as path from 'path';
import { Assembly, findBuildMethods, parseBmFile } from './assemblyParser';
import { UppInstallation } from './installations';
import { computeBinaryPath } from './outputDir';

class UppItem extends vscode.TreeItem {
  children?: UppItem[];
  constructor(label: string, description: string, command?: vscode.Command, collapsible = vscode.TreeItemCollapsibleState.None, contextValue?: string) {
    super(label, collapsible);
    this.description = description;
    if (command) this.command = command;
    if (contextValue) this.contextValue = contextValue;
  }
}

export class UppStateProvider implements vscode.TreeDataProvider<UppItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private installation: UppInstallation | undefined;
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
    installation: UppInstallation | undefined,
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
    this.installation      = installation;
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

  getChildren(element?: UppItem): UppItem[] {
    if (element?.children) return element.children;
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
      arguments: ['@ext:arilect.upp-umk'],
    };
    const selectConfigCmd: vscode.Command = {
      command: 'upp.selectConfig',
      title:   'Select Config',
    };

    const assemblyName  = this.assembly?.name ?? none;
    const packageName   = this.mainPackage ? path.basename(this.mainPackage) : none;
    const method        = cfg.get<string>('buildMethod', '') || none;
    const linkMode      = cfg.get<string>('linkMode', 'all-static');
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
    const scanInstallationsCmd: vscode.Command = { command: 'upp.scanInstallations', title: 'Scan for U++ Installations' };
    const selectInstallationCmd: vscode.Command = { command: 'upp.selectInstallation', title: 'Select U++ Installation' };
    const cppStandardCmd: vscode.Command = {
      command:   'workbench.action.openWorkspaceSettings',
      title:     'Edit cppStandard',
      arguments: ['@ext:arilect.upp-umk upp.cppStandard'],
    };
    const keybindingsCmd: vscode.Command = {
      command: 'workbench.action.openGlobalKeybindings',
      title:   'Open Keybindings',
    };

    const packageParent = new UppItem('Package', packageName, undefined, vscode.TreeItemCollapsibleState.Expanded);
    packageParent.children = [
      new UppItem('Scan for U++ Installations', '', scanInstallationsCmd),
      new UppItem('U++ Installation', this.installation?.label ?? '$(plus) click to set', selectInstallationCmd),
      new UppItem('New Package', '', newProjectCmd),
      new UppItem('Select from Assembly', assemblyName,  selectCmd),
      new UppItem('Description', this.packageDescription || '(click to set)', {
        command: 'upp.editDescription',
        title: 'Edit Description',
      }),
    ];

    const items: UppItem[] = [
      packageParent,
    ];

    const makeSeparator = () => {
      const s = new UppItem('──────────────────────', '', undefined);
      s.iconPath = new vscode.ThemeIcon('blank');
      return s;
    };

    items.push(
      makeSeparator(),
      (() => {
        const varDir = cfg.get<string>('varDir', '');
        const bmName = cfg.get<string>('buildMethod', '');
        const bms = findBuildMethods(varDir);
        const bm = bms.find(b => b.name === bmName || b.filePath === bmName);
        const bmPath = bm?.filePath ?? '(not found)';

        const selectMethodItem = new UppItem('Select Build Method', method, selectMethodCmd);
        const editMethodItem = new UppItem('Edit Build Method', 'settings', { command: 'upp.editBuildMethod', title: 'Edit Build Method' });
        const linkModeItem = new UppItem('Link Mode', linkModeLabel, selectLinkModeCmd);
        const cppStandardItem = new UppItem('C++ Standard', cppStandard, cppStandardCmd);

        const parent = new UppItem('Full Build Method', bmPath, undefined, vscode.TreeItemCollapsibleState.Expanded);
        parent.children = [selectMethodItem, editMethodItem, linkModeItem, cppStandardItem];
        return parent;
      })(),
      new UppItem('Output',   outputLabel,   selectOutputCmd),
      new UppItem('Config',   extra !== none ? `+${extra}` : none, selectConfigCmd),
      new UppItem('Generate clang json', '', generateClangJsonCmd),
      new UppItem('Build As', buildCmdText,  buildAction),
      (() => {
        const varDir = cfg.get<string>('varDir', '');
        const bmName = cfg.get<string>('buildMethod', '');
        const buildFlagsVal = cfg.get<string>('buildFlags', '');
        const confFlag = cfg.get<string>('configurationFlag', '');
        let methodVars = undefined;
        if (bmName) {
          const bms = findBuildMethods(varDir);
          const bm = bms.find(b => b.name === bmName || b.filePath === bmName);
          if (bm) methodVars = parseBmFile(bm.filePath);
        }
        const binaryPath = computeBinaryPath(this.installation, this.assembly, this.mainPackage, bmName, buildFlagsVal, confFlag, methodVars);
        const runLabel = this.running ? '⏹ Stop' : '▶ Run';
        const runDesc  = this.running ? 'running…' : (binaryPath ?? '(not built)');
        const item = new UppItem(runLabel, runDesc, runStopCmd, vscode.TreeItemCollapsibleState.None, 'runItem');
        return item;
      })(),
      new UppItem('Run Options', 'settings', runOptionsCmd),
      new UppItem(this.debugging ? '⏹ Stop Debug' : '🐞 Debug', this.debugging ? 'debugging…' : '', debugStopCmd),
      new UppItem('Output Dir', this.outputDirPath || '(not resolved)', openOutputDirCmd),
      new UppItem('Show Log', 'package log', showLogCmd),
      makeSeparator(),
      new UppItem('Keybindings', 'ctrl+shift+b build · ctrl+shift+q run · ctrl+shift+d debug · ctrl+shift+x stop · alt+l logs', keybindingsCmd),
      new UppItem('Settings', 'open extension settings', settingsCmd),
      new UppItem('Help',     'README',      helpCmd),
    );

    return items;
  }
}
