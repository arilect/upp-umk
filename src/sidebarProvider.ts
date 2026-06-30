import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Assembly, findBuildMethods, parseBmFile, parseMainConfigs } from './assemblyParser';
import { UppInstallation } from './installations';
import { computeBinaryPath } from './outputDir';
import { resolveUmkPath } from './utils';

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
          case 'setOutput':
            vscode.commands.executeCommand('upp.setOutput', message.value);
            break;
          case 'setLinkMode':
            vscode.commands.executeCommand('upp.setLinkMode', message.value);
            break;
          case 'setConfig':
            vscode.commands.executeCommand('upp.setConfig', message.value);
            break;
          case 'setCppStandard':
            vscode.commands.executeCommand('upp.setCppStandard', message.value);
            break;
          case 'setBuildMethod':
            vscode.commands.executeCommand('upp.setBuildMethod', message.value);
            break;
          case 'toggleStopOnErrors':
            vscode.commands.executeCommand('upp.toggleStopOnErrors');
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
    const linkModeFlag  = linkMode === 'use-shared' ? 's' : linkMode === 'all-shared' ? 'S' : '';
    const effectiveFlags = buildFlags.split('').filter(c => c !== 's' && c !== 'S').join('') + linkModeFlag;
    const outputLabel   = buildFlags.includes('r') ? 'Release' : 'Debug';
    const extra         = cfg.get<string>('configurationFlag', '') || none;
    const umkPathDisplay = resolveUmkPath(cfg, this.installation);
    const buildCmdText  = (this.assembly && this.mainPackage)
      ? [umkPathDisplay, this.assembly.name, path.basename(this.mainPackage), method, effectiveFlags ? `-${effectiveFlags}` : '', extra !== none ? `+${extra}` : ''].filter(Boolean).join(' ')
      : cfg.get<string>('buildCommand', '') || none;
    const cppStandardOptions = cfg.get<string[]>('cppStandardOptions', ['c++23', 'c++20', 'c++17', 'c++14', 'c++11', 'c++98']);
    const installationLabel = this.installation?.label ?? 'click to set';
    const isWindows = process.platform === 'win32';
    const stopOnErrors = cfg.get<boolean>('stopOnErrors', false);

    // Config flags from .upp file
    const configCurrent = cfg.get<string>('configurationFlag', '');
    const configAliases: Record<string, string> = cfg.get('configAliases', {});
    let configOptions: string[] = [];
    if (this.assembly && this.mainPackage && this.assembly.nests.length > 0) {
      const pkgDir = path.join(
        this.assembly.nests.find(n =>
          fs.existsSync(path.join(n, this.mainPackage!.replace(/\//g, path.sep)))
        ) ?? this.assembly.nests[0],
        this.mainPackage.replace(/\//g, path.sep)
      );
      const pkgLeaf = path.basename(pkgDir);
      const uppFile = path.join(pkgDir, `${pkgLeaf}.upp`);
      configOptions = parseMainConfigs(uppFile);
    }

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

    // Extract C++ standard from .bm file's COMMON_CPP_OPTIONS (-std=c++XX)
    const bmStdMatch = methodVars?.COMMON_CPP_OPTIONS?.match(/-std=(c\+\+\S+)/);
    const cppStandard = bmStdMatch ? bmStdMatch[1] : (cfg.get<string>('cppStandard', '') || 'c++17 (default)');
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
function toggleDropdown(id) {
  const container = document.getElementById(id)?.closest('.dropdown-container');
  if (!container) return;
  const wasOpen = container.classList.contains('open');
  closeAllDropdowns();
  if (!wasOpen) container.classList.add('open');
}
function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-container.open').forEach(d => d.classList.remove('open'));
}
function selectOutput(value) {
  closeAllDropdowns();
  vscode.postMessage({ command: 'setOutput', value: value });
}
function selectLinkMode(value) {
  closeAllDropdowns();
  vscode.postMessage({ command: 'setLinkMode', value: value });
}
function selectConfig(value) {
  closeAllDropdowns();
  vscode.postMessage({ command: 'setConfig', value: value });
}
function selectCppStandard(value) {
  closeAllDropdowns();
  vscode.postMessage({ command: 'setCppStandard', value: value });
}
function selectBuildMethod(value) {
  closeAllDropdowns();
  vscode.postMessage({ command: 'setBuildMethod', value: value });
}
function toggleStopOnErrors() {
  vscode.postMessage({ command: 'toggleStopOnErrors' });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-container')) closeAllDropdowns();
});
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
  .group-header .edit-icon {
    font-size: 1.2em;
    flex-shrink: 0;
    cursor: pointer;
    padding: 0 2px;
    border-radius: 2px;
    opacity: 0.6;
    margin-left: 12px;
    margin-right: 4px;
  }
  .group-header .edit-icon:hover { opacity: 1; background: var(--row-hover); }
  .group-header .build-icon {
    font-size: 16px;
    flex-shrink: 0;
    cursor: pointer;
    padding: 0 2px;
    border-radius: 2px;
    opacity: 0.8;
    margin: 0 3px;
  }
  .group-header .build-icon:hover { opacity: 1; background: var(--row-hover); }
  .group-header .build-go { font-size: 18px; }
  .group-header .build-rebuild { color: #c53535; }
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
    color: var(--label-fg, #999);
    padding: 4px 6px;
    line-height: 1.5;
    word-wrap: break-word;
    opacity: 0.8;
    cursor: pointer;
    border-radius: 4px;
  }
  .hint:hover { background: var(--row-hover); }
  .dropdown-container {
    position: relative;
    margin: 2px 0;
  }
  .dropdown-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 6px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
    color: var(--value-fg);
    font-family: inherit;
    font-size: inherit;
    gap: 8px;
  }
  .dropdown-btn:hover { background: var(--row-hover); }
  .dropdown-btn .label-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .dropdown-btn .label-group .label {
    color: var(--label-fg);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .dropdown-btn .value {
    color: #000;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    background: var(--vscode-button-background, #0e639c);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .dropdown-btn .chevron {
    color: var(--label-fg);
    font-size: 14px;
    flex-shrink: 0;
    transition: transform 0.15s;
  }
  .dropdown-container.open .dropdown-btn .chevron {
    transform: rotate(180deg);
  }
  .dropdown-options {
    display: none;
    position: absolute;
    left: 0;
    width: max-content;
    min-width: 100%;
    top: 100%;
    z-index: 1000;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--separator);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    overflow: hidden;
    margin-top: 2px;
  }
  .dropdown-container.open .dropdown-options {
    display: block;
  }
  .dropdown-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    cursor: pointer;
    color: var(--value-fg);
    font-size: inherit;
  }
  .dropdown-option:hover {
    background: var(--row-hover);
  }
  .dropdown-option.selected {
    color: var(--accent);
    font-weight: 500;
  }
  .dropdown-option .check {
    color: var(--accent);
    font-size: 13px;
    flex-shrink: 0;
  }
  .dropdown-btn .edit-icon {
    color: var(--label-fg);
    font-size: inherit;
    flex-shrink: 0;
    padding: 0;
    margin-right: 2px;
    opacity: 0.6;
    cursor: pointer;
    border-radius: 2px;
    align-self: center;
  }
  .dropdown-btn .edit-icon:hover {
    opacity: 1;
    background: var(--row-hover);
  }
  .output-btn {
    justify-content: space-between;
    position: relative;
  }
  .output-btn .value {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }
</style>
</head>
<body>

  <div class="group">
    <div class="group-header" data-group-id="package" onclick="toggleGroup(this)">
      <span class="chevron">\u25BE</span>
      <span class="label">Package</span>
      <span class="value">${this._esc(packageName)}</span>
    </div>
    <div class="group-children">
      <button class="btn btn-secondary" onclick="${this._cmd('upp.editInstallations')}">Source Trees</button>
      ${isWindows ? row('Source Tree', installationLabel, 'upp.selectInstallation') : ''}
      <button class="btn btn-new" onclick="${this._cmd('upp.newPackage')}">New Package</button>
      ${row('Select from Assembly', assemblyName, 'upp.selectAssembly')}
      ${row('Description', this.packageDescription || '(click to set)', 'upp.editDescription')}
    </div>
  </div>

  ${separator}

  <div class="group">
    <div class="group-header" data-group-id="buildMethod" onclick="toggleGroup(this)">
      <span class="chevron">\u25BE</span>
      <span class="label">Build Method</span>
      <span class="value">${this._esc(method)}</span>
    </div>
    <div class="group-children">
      <div class="dropdown-container">
        <button class="dropdown-btn" onclick="toggleDropdown('bm-dropdown')">
          <span class="label-group">
            <span class="edit-icon" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.editBuildMethod' })" title="Edit build method">\u270E</span>
            <span class="label">Build Method</span>
          </span>
          <span class="value">${this._esc(bmName || none)}</span>
          <span class="chevron">\u25BE</span>
        </button>
        <div id="bm-dropdown" class="dropdown-options">
          ${bms.length > 0 ? bms.map(b => {
            const isSelected = b.name === bmName || b.filePath === bmName;
            return `<div class="dropdown-option ${isSelected ? 'selected' : ''}" onclick="selectBuildMethod('${this._esc(b.name)}')">
              <span>${this._esc(b.name)}</span>
              ${isSelected ? '<span class="check">\u2713</span>' : ''}
            </div>`;
          }).join('') : '<div class="dropdown-option disabled"><span>No build methods found</span></div>'}
        </div>
      </div>
      <div class="dropdown-container">
        <button class="dropdown-btn" onclick="toggleDropdown('linkmode-dropdown')">
          <span class="label">Link Mode</span>
          <span class="value">${this._esc(linkModeLabel)}</span>
          <span class="chevron">\u25BE</span>
        </button>
        <div id="linkmode-dropdown" class="dropdown-options">
          <div class="dropdown-option ${linkMode === 'all-static' ? 'selected' : ''}" onclick="selectLinkMode('all-static')">
            <span>All Static</span>
            ${linkMode === 'all-static' ? '<span class="check">\u2713</span>' : ''}
          </div>
          <div class="dropdown-option ${linkMode === 'use-shared' ? 'selected' : ''}" onclick="selectLinkMode('use-shared')">
            <span>Use Shared (-s)</span>
            ${linkMode === 'use-shared' ? '<span class="check">\u2713</span>' : ''}
          </div>
          <div class="dropdown-option ${linkMode === 'all-shared' ? 'selected' : ''}" onclick="selectLinkMode('all-shared')">
            <span>All Shared (-S)</span>
            ${linkMode === 'all-shared' ? '<span class="check">\u2713</span>' : ''}
          </div>
        </div>
      </div>
      <div class="dropdown-container">
        <button class="dropdown-btn" onclick="toggleDropdown('cppstd-dropdown')">
          <span class="label-group">
            <span class="edit-icon" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.editCppStandard' })" title="Edit C++ standards">\u270E</span>
            <span class="label">C++ Standard</span>
          </span>
          <span class="value">${this._esc(cppStandard || 'default')}</span>
          <span class="chevron">\u25BE</span>
        </button>
        <div id="cppstd-dropdown" class="dropdown-options">
          <div class="dropdown-option ${!cppStandard ? 'selected' : ''}" onclick="selectCppStandard('')">
            <span>default (c++17)</span>
            ${!cppStandard ? '<span class="check">\u2713</span>' : ''}
          </div>
          ${cppStandardOptions.map(s => {
            const isSelected = s === cppStandard;
            return `<div class="dropdown-option ${isSelected ? 'selected' : ''}" onclick="selectCppStandard('${this._esc(s)}')">
              <span>${this._esc(s)}</span>
              ${isSelected ? '<span class="check">\u2713</span>' : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>
  </div>

  ${configOptions.length > 0
    ? (() => {
        const currentNormalized = configCurrent.replace(/\s+/g, ',').replace(/,+/g, ',');
        const currentAlias = configAliases[currentNormalized] || '';
        const displayValue = currentAlias ? currentAlias : (configCurrent ? '+' + configCurrent : none);
        return `<div class="dropdown-container">
        <button class="dropdown-btn" onclick="toggleDropdown('config-dropdown')">
          <span class="label-group">
            <span class="edit-icon" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.editConfigFlags' })" title="Edit config flags">\u270E</span>
            <span class="label">Config Flags</span>
          </span>
          <span class="value">${this._esc(displayValue)}</span>
          <span class="chevron">\u25BE</span>
        </button>
        <div id="config-dropdown" class="dropdown-options">
          ${configOptions.map(c => {
            const val = c.replace(/\s+/g, ',').replace(/,+/g, ',');
            const isSelected = val === configCurrent;
            const alias = configAliases[val] || '';
            const label = alias ? alias + ' (' + c + ')' : c;
            return `<div class="dropdown-option ${isSelected ? 'selected' : ''}" onclick="selectConfig('${this._esc(val)}')">
              <span>${this._esc(label)}</span>
              ${isSelected ? '<span class="check">\u2713</span>' : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
      })()
    : row('Config Flags', extra !== none ? '+' + extra : none, 'upp.selectConfig')
  }
  <button class="dropdown-btn output-btn" onclick="selectOutput('${outputLabel === 'Debug' ? 'Release' : 'Debug'}')">
    <span class="label">Output Mode</span>
    <span class="value">${this._esc(outputLabel)}</span>
  </button>
  <div class="group">
    <div class="group-header" data-group-id="buildMode" onclick="toggleGroup(this)">
      <span class="chevron">\u25BE</span>
      <span class="label">Build</span>
      <span class="edit-icon" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.editBuildOptions' })" title="Edit build options">\u270E</span>
      <span class="build-icon build-go" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.build' })" title="Build">\u26A1</span>
      <span class="build-icon build-rebuild" onclick="event.stopPropagation(); vscode.postMessage({ command: 'executeCommand', commandId: 'upp.rebuild' })" title="Rebuild All">\u25B6</span>
      <span class="value">${this._esc((effectiveFlags ? '-' + effectiveFlags : '') + (configCurrent ? ' +' + configCurrent : '') || none)}</span>
    </div>
    <div class="group-children">
      <div class="row" onclick="vscode.postMessage({ command: 'executeCommand', commandId: 'upp.cleanBuild' })" style="cursor: pointer;">
        <span class="label">Clean the build</span>
      </div>
      <div class="stop-on-errors" onclick="toggleStopOnErrors()" style="cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground, #ccc);">
        <input type="checkbox" id="stop-on-errors-cb" ${stopOnErrors ? 'checked' : ''} onclick="event.stopPropagation(); toggleStopOnErrors()" style="width: 16px; height: 16px; margin: 0; cursor: pointer;" />
        <span style="cursor: pointer;">Stop on errors</span>
      </div>
    </div>
  </div>

  ${separator}

  ${button(runLabel, runCmd, this.running ? 'btn-run running' : 'btn-run')}
  ${button(debugLabel, debugCmd, this.debugging ? 'btn-debug debugging' : 'btn-debug')}

  ${row('Run Options', 'settings', 'upp.editRunOptions')}

  ${separator}

  ${row('Output Dir', this.outputDirPath || '(not resolved)', 'upp.openOutputDir')}
  ${row('Show Log', 'package log', 'upp.showLogs')}

  ${separator}

  ${row('Generate clang json', '', 'upp.generateClangJson')}

  ${row('Keybindings', 'ctrl+shift+b build \u00B7 ctrl+shift+q run \u00B7 ctrl+shift+d debug \u00B7 ctrl+shift+x stop \u00B7 alt+l logs', 'upp.openKeybindings')}

  <div class="row" onclick="vscode.postMessage({ command: 'executeCommand', commandId: 'workbench.action.openSettings', args: ['@ext:arilect.upp-umk'] })">
    <span class="label">Settings</span>
  </div>
  ${row('Extension Logs', '', 'upp.showExtensionLogs')}
  ${row('Help', 'README', 'upp.openHelp')}

</body>
</html>`;
  }
}
