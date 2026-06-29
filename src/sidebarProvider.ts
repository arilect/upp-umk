import * as vscode from 'vscode';
import * as path from 'path';
import { Assembly, findBuildMethods, parseBmFile } from './assemblyParser';
import { UppInstallation } from './installations';
import { computeBinaryPath } from './outputDir';

export class UppSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'upp.stateView';
  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];

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

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(vscode.extensions.getExtension('arilect.upp-umk')!.extensionUri, 'media')],
    };

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'executeCommand':
            vscode.commands.executeCommand(message.commandId, ...(message.args || []));
            break;
        }
      },
      undefined,
      this._disposables,
    );

    webviewView.onDidDispose(() => {
      this._view = undefined;
    }, null, this._disposables);

    this._updateHtml();
  }

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
    this.installation       = installation;
    this.assembly           = assembly;
    this.mainPackage        = mainPackage;
    this.running            = isRunning;
    this.packageDescription = packageDescription;
    this.packageUppFile     = packageUppFile;
    this.debugging          = isDebugging;
    this.outputDirPath      = outputDirPath;
    this.debugOutputDirPath = debugOutputDirPath;
    this.debugCmdText       = debugCmdText;
    this._updateHtml();
  }

  dispose() {
    for (const d of this._disposables) d.dispose();
  }

  private _updateHtml() {
    if (!this._view) return;
    this._view.webview.html = this._getHtml();
  }

  private _cmd(id: string, label = ''): string {
    return `vscode.postMessage({ command: 'executeCommand', commandId: '${id}' })`;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private _getHtml(): string {
    const none = '\u2014';
    const cfg  = vscode.workspace.getConfiguration('upp');

    const assemblyName  = this.assembly?.name ?? none;
    const packageName   = this.mainPackage ? path.basename(this.mainPackage) : none;
    const method        = cfg.get<string>('buildMethod', '') || none;
    const linkMode      = cfg.get<string>('linkMode', 'all-static');
    const linkModeLabel = linkMode === 'all-static' ? 'All Static' : linkMode === 'use-shared' ? 'Use Shared (-s)' : 'All Shared (-S)';
    const buildFlags    = cfg.get<string>('buildFlags', '');
    const outputLabel   = buildFlags.includes('r') ? 'Release' : 'Debug';
    const extra         = cfg.get<string>('configurationFlag', '') || none;
    const buildCmdText  = cfg.get<string>('buildCommand', '') || none;
    const cppStandard   = cfg.get<string>('cppStandard', '') || 'c++17 (default)';
    const installationLabel = this.installation?.label ?? 'click to set';

    const varDir = cfg.get<string>('varDir', '');
    const bmName = cfg.get<string>('buildMethod', '');
    const bms = findBuildMethods(varDir);
    const bm = bms.find(b => b.name === bmName || b.filePath === bmName);
    const bmPath = bm?.filePath ?? '(not found)';

    const buildFlagsVal = cfg.get<string>('buildFlags', '');
    const confFlag     = cfg.get<string>('configurationFlag', '');
    let methodVars: ReturnType<typeof parseBmFile> | undefined;
    if (bmName) {
      if (bm) methodVars = parseBmFile(bm.filePath);
    }
    const binaryPath = computeBinaryPath(this.installation, this.assembly, this.mainPackage, bmName, buildFlagsVal, confFlag, methodVars);

    const runLabel  = this.running ? '\u23F9 Stop' : '\u25B6 Run';
    const runDesc   = this.running ? 'running\u2026' : (binaryPath ?? '(not built)');
    const debugLabel = this.debugging ? '\u23F9 Stop Debug' : '\ud83d\udc28 Debug';
    const debugDesc  = this.debugging ? 'debugging\u2026' : '';

    const runCmd   = this.running ? 'upp.stopRun' : 'upp.run';
    const debugCmd = this.debugging ? 'upp.stopDebug' : 'upp.debug';

    const row = (label: string, value: string, cmd: string, cssClass = 'row') =>
      `<div class="${this._esc(cssClass)}" onclick="${this._cmd(cmd)}">
        <span class="label">${this._esc(label)}</span>
        <span class="value">${this._esc(value)}</span>
      </div>`;

    const button = (label: string, cmd: string, cssClass = 'btn-primary') =>
      `<button class="btn ${this._esc(cssClass)}" onclick="${this._cmd(cmd)}">${this._esc(label)}</button>`;

    const separator = '<div class="separator"></div>';

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<script>
const vscode = acquireVsCodeApi();
function toggleGroup(el) {
  const children = el.nextElementSibling;
  const icon = el.querySelector('.chevron');
  if (!children) return;
  const collapsed = children.style.display === 'none';
  children.style.display = collapsed ? '' : 'none';
  icon.textContent = collapsed ? '\u25BE' : '\u25B8';
  const state = vscode.getState() || {};
  state[el.dataset.groupId] = collapsed ? 'expanded' : 'collapsed';
  vscode.setState(state);
}
document.addEventListener('DOMContentLoaded', () => {
  const state = vscode.getState() || {};
  document.querySelectorAll('.group').forEach(g => {
    const header = g.querySelector('.group-header[data-group-id]');
    const children = g.querySelector('.group-children');
    const icon = header?.querySelector('.chevron');
    if (!header || !children || !icon) return;
    if (state[header.dataset.groupId] === 'collapsed') {
      children.style.display = 'none';
      icon.textContent = '\u25B8';
    }
  });
});
</script>
<style>
  :root {
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-secondary-fg: var(--vscode-button-secondaryForeground, #ffffff);
    --btn-secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
    --row-hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));
    --separator: var(--vscode-widget-border, rgba(255,255,255,0.1));
    --label-fg: var(--vscode-descriptionForeground, #999);
    --value-fg: var(--vscode-foreground, #ccc);
    --accent: var(--vscode-focusBorder, #007acc);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--value-fg);
    padding: 4px 8px;
    background: transparent;
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--label-fg);
    padding: 8px 0 4px;
    letter-spacing: 0.5px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    gap: 8px;
  }
  .row:hover { background: var(--row-hover); }
  .row .label {
    color: var(--label-fg);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .row .value {
    color: var(--value-fg);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .separator {
    height: 1px;
    background: var(--separator);
    margin: 6px 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    font-weight: 500;
    transition: background 0.15s;
  }
  .btn-primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
  }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-secondary {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
  }
  .btn-secondary:hover { background: var(--btn-secondary-hover); }
  .btn-run {
    background: var(--btn-bg);
    color: var(--btn-fg);
    font-weight: 600;
  }
  .btn-run:hover { background: var(--btn-hover); }
  .btn-run.running {
    background: #c53535;
  }
  .btn-run.running:hover { background: #d94040; }
  .btn-debug {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
  }
  .btn-debug:hover { background: var(--btn-secondary-hover); }
  .btn-debug.debugging {
    background: #c53535;
  }
  .btn-debug.debugging:hover { background: #d94040; }
  .btn-new {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    border-radius: 6px;
    padding: 5px 12px;
  }
  .btn-new:hover { filter: brightness(1.15); }
  .group {
    padding: 2px 0;
  }
  .group-header {
    display: flex;
    align-items: center;
    padding: 4px 0;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }
  .group-header:hover { background: var(--row-hover); }
  .group-header .label { color: var(--value-fg); margin-left: 0; }
  .group-header .value { color: var(--accent); font-size: 14px; font-weight: 600; margin-left: auto; }
  .group-header .chevron {
    color: var(--label-fg);
    font-size: 20px;
    margin-right: 4px;
    transition: transform 0.15s;
    user-select: none;
    flex-shrink: 0;
  }
  .group-children { padding-left: 8px; }
  .hint {
    font-size: 11px;
    color: var(--label-fg);
    padding: 2px 6px 4px;
    line-height: 1.3;
  }
</style>
</head>
<body>

  <div class="section-title">Package</div>
  <div class="group">
    <div class="group-header" data-group-id="package" onclick="toggleGroup(this)">
      <span class="chevron">\u25BE</span>
      <span class="label">Package</span>
      <span class="value">${this._esc(packageName)}</span>
    </div>
    <div class="group-children">
      <button class="btn btn-secondary" onclick="${this._cmd('upp.editInstallations')}">Installations</button>
      ${row('Installation', installationLabel, 'upp.selectInstallation')}
      <button class="btn btn-new" onclick="${this._cmd('upp.newPackage')}">New Package</button>
      ${row('Assembly', assemblyName, 'upp.selectAssembly')}
      ${row('Description', this.packageDescription || '(click to set)', 'upp.editDescription')}
    </div>
  </div>

  ${separator}

  <div class="section-title">Build</div>
  <div class="group">
    <div class="group-header" data-group-id="buildMethod" onclick="toggleGroup(this)">
      <span class="chevron">\u25BE</span>
      <span class="label">Build Method</span>
      <span class="value">${this._esc(method)}</span>
    </div>
    <div class="group-children">
      ${row('Select Method', bmPath, 'upp.selectBuildMethod')}
      ${row('Edit Method', 'settings', 'upp.editBuildMethod')}
      ${row('Link Mode', linkModeLabel, 'upp.selectLinkMode')}
      ${row('C++ Standard', cppStandard, 'workbench.action.openWorkspaceSettings')}
    </div>
  </div>

  ${row('Output Mode', outputLabel, 'upp.selectOutput')}
  ${row('Config Flags', extra !== none ? '+' + extra : none, 'upp.selectConfig')}
  ${row('Generate clang json', '', 'upp.generateClangJson')}
  ${row('Build As', buildCmdText, 'upp.build')}

  ${separator}

  ${button(runLabel, runCmd, this.running ? 'btn-run running' : 'btn-run')}
  ${row('Run Options', 'settings', 'upp.editRunOptions')}

  ${button(debugLabel, debugCmd, this.debugging ? 'btn-debug debugging' : 'btn-debug')}

  ${separator}

  ${row('Output Dir', this.outputDirPath || '(not resolved)', 'upp.openOutputDir')}
  ${row('Show Log', 'package log', 'upp.showLogs')}

  ${separator}

  <div class="hint">ctrl+shift+b build &middot; ctrl+shift+q run &middot; ctrl+shift+d debug &middot; ctrl+shift+x stop &middot; alt+l logs</div>

  ${row('Settings', '', 'workbench.action.openWorkspaceSettings')}
  ${row('Help', 'README', 'upp.openHelp')}

</body>
</html>`;
  }
}
