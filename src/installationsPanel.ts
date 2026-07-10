import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanInstallationsAsync, scanInstallations, resolvePath, UppInstallation } from './installations';
import { scanVarFiles } from './assemblyParser';

interface ManualEntry { path: string; addedManually: boolean; }

function normPath(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir()).replace(/\\/g, '/').replace(/\/+$/, '');
}

export function showInstallationsPanel() {
  const isWindows = process.platform === 'win32';
  const panelTitle = isWindows ? 'U++ Installations' : 'U++ Source Trees';
  const panel = vscode.window.createWebviewPanel(
    'uppInstallations',
    panelTitle,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const cfg = vscode.workspace.getConfiguration('upp');
  const currentPaths = cfg.get<string[]>('installationsPaths', ['~']);
  const currentGlob = cfg.get<string>('installationsGlob', '');
  const currentManualRaw = cfg.get<ManualEntry[]>('installationsManual', []);
  const currentManual = Array.isArray(currentManualRaw)
    ? currentManualRaw.map(e => typeof e === 'string' ? { path: e, addedManually: false } : e)
    : [];

  const allKnown = scanInstallations();
  const knownPaths = allKnown.map(i => i.path);
  let mergedManual = [...currentManual];
  for (const kp of knownPaths) {
    if (!mergedManual.some(e => e.path === kp)) {
      mergedManual.push({ path: kp, addedManually: false });
    }
  }
  if (mergedManual.length !== currentManual.length) {
    cfg.update('installationsManual', mergedManual, vscode.ConfigurationTarget.Global);
  }

  const currentScanDirs = cfg.get<string[]>('scanDirs', ['~']);
  const currentEnabledAssemblies = cfg.get<string[]>('enabledAssemblies', []);
  const currentScannedAssemblies = cfg.get<string[]>('scannedAssemblies', []);

  // Resolve workspaces dir and list existing workspace files
  const rawWorkspacesDir = cfg.get<string>('workspacesDir') ?? '~/.config/u++/vscode';
  const resolvedWorkspacesDir = rawWorkspacesDir.replace(/^~(?=\/|$)/, os.homedir());
  let existingWorkspaceFiles: string[] = [];
  if (resolvedWorkspacesDir && fs.existsSync(resolvedWorkspacesDir)) {
    try {
      existingWorkspaceFiles = fs.readdirSync(resolvedWorkspacesDir)
        .filter(f => f.endsWith('.code-workspace'))
        .sort();
    } catch { /* ignore */ }
  }

  panel.webview.html = buildHtml(currentPaths, currentGlob, mergedManual, currentScanDirs, currentEnabledAssemblies, isWindows, rawWorkspacesDir, existingWorkspaceFiles);

  // Auto-scan on open: if scanDirs are set, run scan and send results to webview
  // Use setTimeout to ensure the webview's message listener is ready
  if (currentScanDirs.length > 0) {
    setTimeout(() => {
      const assemblies = scanVarFiles(currentScanDirs);
      const enabledSet = new Set(currentEnabledAssemblies.map(normPath));
      const hasEnabled = currentEnabledAssemblies.length > 0;
      const results = assemblies.map(a => ({
        name: a.name,
        filePath: a.filePath,
        nests: a.nests,
        enabled: hasEnabled ? enabledSet.has(normPath(a.filePath)) : true,
      }));
      panel.webview.postMessage({ type: 'varscanResult', assemblies: results });
    }, 200);
  }

  let scanTokenSource: vscode.CancellationTokenSource | undefined;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'scan') {
      const paths: string[] = msg.paths || [];
      const glob: string = msg.glob || '';
      await cfg.update('installationsGlob', glob, vscode.ConfigurationTarget.Global);
      scanTokenSource = new vscode.CancellationTokenSource();

      panel.webview.postMessage({ type: 'scanStart' });
      vscode.window.showInformationMessage('UPP: Scanning for installations...');

      const resolvedPaths = paths.map(p => resolvePath(p));
      panel.webview.postMessage({ type: 'scanDirs', dirs: resolvedPaths });

      const foundMap = new Map<string, UppInstallation>();

      await scanInstallationsAsync(
        resolvedPaths,
        glob,
        (inst) => {
          if (!foundMap.has(inst.path)) {
            foundMap.set(inst.path, inst);
            panel.webview.postMessage({ type: 'scanFound', installation: inst });
          }
        },
        (scanPath, scanned, found) => {
          panel.webview.postMessage({ type: 'scanDirProgress', scanPath, scanned, found });
        },
        scanTokenSource.token,
      );

      const foundPaths = [...foundMap.keys()];
      if (foundPaths.length > 0) {
        const currentManual = cfg.get<ManualEntry[]>('installationsManual', []);
        const migrated = Array.isArray(currentManual)
          ? currentManual.map(e => typeof e === 'string' ? { path: e, addedManually: false } as ManualEntry : e)
          : [];
        const existingManualPaths = new Set(migrated.filter(e => e.addedManually).map(e => e.path));
        const merged: ManualEntry[] = [...migrated.filter(e => e.addedManually)];
        for (const fp of foundPaths) {
          if (!existingManualPaths.has(fp)) {
            merged.push({ path: fp, addedManually: false });
          }
        }
        await cfg.update('installationsManual', merged, vscode.ConfigurationTarget.Global);
      }

      panel.webview.postMessage({ type: 'scanDone', totalFound: foundMap.size });
      const updatedManual = cfg.get<ManualEntry[]>('installationsManual', []);
      panel.webview.postMessage({ type: 'updateManual', manual: updatedManual });
      scanTokenSource.dispose();
      scanTokenSource = undefined;

    } else if (msg.type === 'cancelScan') {
      scanTokenSource?.cancel();
      scanTokenSource?.dispose();
      scanTokenSource = undefined;
      panel.webview.postMessage({ type: 'scanCancelled' });

    } else if (msg.type === 'validateManual') {
      const raw: string = msg.dir || '';
      const dir = resolvePath(raw);
      const hasUppsrc = fs.existsSync(path.join(dir, 'uppsrc'));
      panel.webview.postMessage({ type: 'manualValidation', dir: raw, resolved: dir, valid: hasUppsrc });

    } else if (msg.type === 'save') {
      const paths: string[] = msg.paths || [];
      const manual: ManualEntry[] = msg.manual || [];
      const found: string[] = msg.found || [];
      const glob: string = msg.glob || '';
      const merged: ManualEntry[] = [...manual];
      for (const fp of found) {
        if (!merged.some(e => e.path === fp)) {
          merged.push({ path: fp, addedManually: false });
        }
      }
      await cfg.update('installationsPaths', paths, vscode.ConfigurationTarget.Global);
      await cfg.update('installationsGlob', glob, vscode.ConfigurationTarget.Global);
      await cfg.update('installationsManual', merged, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Saved ${paths.length} scan path(s), ${merged.length} installation(s).`);

    } else if (msg.type === 'selectInstallation') {
      const instPath: string = msg.path;
      const label: string = msg.label;
      await cfg.update('activeInstallation', instPath, vscode.ConfigurationTarget.Global);
      const umkPath = process.platform === 'win32' ? path.join(instPath, 'umk.exe') : 'umk';
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Switched to "${label}".`);
      vscode.commands.executeCommand('workbench.action.reloadWindow');

    } else if (msg.type === 'varscan') {
      const dirs: string[] = msg.dirs || [];
      await cfg.update('scanDirs', dirs, vscode.ConfigurationTarget.Global);
      const assemblies = scanVarFiles(dirs);
      const enabledRaw = cfg.get<string[]>('enabledAssemblies', []);
      const enabledSet = new Set(enabledRaw.map(normPath));
      const results = assemblies.map(a => ({
        name: a.name,
        filePath: a.filePath,
        nests: a.nests,
        enabled: enabledSet.has(normPath(a.filePath)) || enabledRaw.length === 0,
      }));
      // Persist the full list of found assemblies
      const allPaths = assemblies.map(a => a.filePath);
      await cfg.update('scannedAssemblies', allPaths, vscode.ConfigurationTarget.Global);
      // If enabledAssemblies was empty (first scan), persist all found assemblies as enabled
      if (enabledRaw.length === 0 && assemblies.length > 0) {
        await cfg.update('enabledAssemblies', allPaths, vscode.ConfigurationTarget.Global);
      }
      panel.webview.postMessage({ type: 'varscanResult', assemblies: results });

    } else if (msg.type === 'toggleAssembly') {
      const filePath: string = msg.filePath;
      const enabled: boolean = msg.enabled;
      const current = cfg.get<string[]>('enabledAssemblies', []);
      let updated: string[];
      if (enabled) {
        updated = current.includes(filePath) ? current : [...current, filePath];
      } else {
        updated = current.filter(p => p !== filePath);
      }
      await cfg.update('enabledAssemblies', updated, vscode.ConfigurationTarget.Global);

    } else if (msg.type === 'changeWorkspacesDir') {
      const oldDir: string = (msg.oldDir || '').replace(/^~(?=\/|$)/, os.homedir());
      const newDirRaw: string = msg.newDir || '';
      const newDir = newDirRaw.replace(/^~(?=\/|$)/, os.homedir());
      const existingFiles: string[] = msg.existingFiles || [];

      if (!newDir) {
        vscode.window.showWarningMessage('UPP: Workspace directory cannot be empty.');
        return;
      }

      // Ensure new directory exists
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
      }

      // If there are existing files in the old directory, offer to copy/move
      if (existingFiles.length > 0 && oldDir && oldDir !== newDir && fs.existsSync(oldDir)) {
        const choice = await vscode.window.showInformationMessage(
          `UPP: ${existingFiles.length} workspace file(s) exist in the old location. What should happen to them?`,
          'Move', 'Copy', 'Leave'
        );

        if (choice === 'Move' || choice === 'Copy') {
          let moved = 0;
          for (const f of existingFiles) {
            const src = path.join(oldDir, f);
            const dst = path.join(newDir, f);
            try {
              if (choice === 'Move') {
                fs.renameSync(src, dst);
              } else {
                fs.copyFileSync(src, dst);
              }
              moved++;
            } catch (err: any) {
              console.warn(`UPP: Failed to ${choice.toLowerCase()} ${f}: ${err.message}`);
            }
          }
          vscode.window.showInformationMessage(`UPP: ${choice === 'Move' ? 'Moved' : 'Copied'} ${moved}/${existingFiles.length} workspace file(s).`);
        }
      }

      // Save the new directory
      await cfg.update('workspacesDir', newDirRaw, vscode.ConfigurationTarget.Global);

      // Refresh the workspace list
      let newFiles: string[] = [];
      if (fs.existsSync(newDir)) {
        try {
          newFiles = fs.readdirSync(newDir)
            .filter(f => f.endsWith('.code-workspace'))
            .sort();
        } catch { /* ignore */ }
      }
      panel.webview.postMessage({ type: 'workspacesDirUpdated', dir: newDirRaw, files: newFiles });
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(paths: string[], glob: string, manual: ManualEntry[], scanDirs: string[], enabledAssemblies: string[], isWindows: boolean, workspacesDir: string, workspaceFiles: string[]): string {
  const pathsJson = JSON.stringify(paths);
  const manualJson = JSON.stringify(manual);
  const scanDirsJson = JSON.stringify(scanDirs);
  const enabledJson = JSON.stringify(enabledAssemblies);
  const workspaceFilesJson = JSON.stringify(workspaceFiles);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 16px 20px;
  }
  h2 { margin-bottom: 4px; font-weight: normal; font-size: 1.2em; }
  .subtitle { font-size: 0.85em; opacity: 0.6; margin-bottom: 16px; }
  .section {
    font-weight: bold; font-size: 0.9em;
    margin: 16px 0 8px 0; padding: 6px 0;
    border-bottom: 1px solid var(--vscode-widget-border);
    opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .field { margin-bottom: 12px; }
  .field label { display: block; margin-bottom: 3px; font-size: 0.9em; }
  .field .hint { font-size: 0.8em; opacity: 0.6; margin-top: 2px; }
  input[type="text"] {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .list-container {
    display: flex; flex-direction: column; gap: 3px;
    max-height: 200px; overflow-y: auto;
  }
  .list-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 0.9em;
  }
  .list-item .item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-item .item-assemblies { opacity: 0.5; font-size: 0.8em; flex-shrink: 0; }
  .list-item .btn-remove {
    background: none; border: none; color: var(--vscode-errorForeground);
    cursor: pointer; font-size: 1.1em; padding: 0 4px; opacity: 0.6;
  }
  .list-item .btn-remove:hover { opacity: 1; }
  .list-item .btn-activate {
    padding: 2px 8px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 0.8em; flex-shrink: 0;
  }
  .list-item .btn-activate:hover { background: var(--vscode-button-hoverBackground); }
  .list-add { display: flex; gap: 4px; margin-top: 4px; }
  .list-add input { flex: 1; }
  .btn-small {
    padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 0.9em;
  }
  .btn-scan {
    padding: 8px 20px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 0.95em; font-weight: bold; margin-top: 12px; align-self: flex-start;
  }
  .btn-scan:hover { background: var(--vscode-button-hoverBackground); }
  .btn-scan:disabled { opacity: 0.5; cursor: default; }
  .btn-cancel-scan {
    background: var(--vscode-errorForeground) !important;
    color: #fff !important;
  }
  .buttons {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 20px; padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border);
  }
  .buttons button {
    padding: 6px 20px; border: none; border-radius: 2px;
    cursor: pointer; font-size: 0.9em;
  }
  .btn-save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .search-info {
    margin: 8px 0; padding: 8px 10px;
    background: transparent;
    border-left: 3px solid var(--vscode-textLink-foreground);
    border-radius: 2px; font-size: 0.85em;
  }
  .search-info .info-title { font-weight: bold; margin-bottom: 6px; }
  .search-path {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  .search-path .path-input { color: var(--vscode-descriptionForeground); }
  .search-path .path-arrow { color: var(--vscode-descriptionForeground); opacity: 0.5; }
  .search-path .path-resolved { color: var(--vscode-textLink-foreground); }
  .search-path .path-stats {
    flex-shrink: 0; font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap; margin-left: auto;
  }

  .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: var(--vscode-textLink-foreground);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hint { font-size: 0.8em; opacity: 0.6; margin-top: 2px; }
</style>
</head>
<body>
  <h2>${isWindows ? 'U++ Installations' : 'U++ Source Trees'}</h2>
  <div class="subtitle">Configure directories and pattern to scan for U++ source trees.</div>

  <div class="field">
    <label for="globInput">Directory Pattern</label>
    <input type="text" id="globInput" value="${esc(glob)}" />
    <div class="hint">Optional glob pattern to filter directories (e.g. upp-*, upp*, ultimatepp*). Leave empty to match any directory containing uppsrc/.</div>
  </div>

  <div class="section">Scan Paths</div>
  <div id="paths_list" class="list-container"></div>
  <div class="list-add">
    <input type="text" id="paths_input" placeholder="Add path (e.g. /opt, ~/upp)..." />
    <button class="btn-small" onclick="addItem()">+</button>
  </div>
  <div class="hint">Use ~ for home directory. Each path is scanned for directories matching the pattern.</div>

  <div class="section">Source Trees</div>
  <div id="manual_list" class="list-container"></div>
  <div class="list-add">
    <input type="text" id="manual_input" placeholder="Add source tree path directly (e.g. /opt/upp, ~/upp-24.1/upp)..." />
    <button class="btn-small" onclick="addManual()">+</button>
  </div>
  <div class="hint">Add U++ source tree directories directly. Must contain uppsrc/.</div>

  <div class="search-info">
    <div class="info-title">What will be scanned</div>
    <div style="opacity:0.6; margin-bottom:4px;">Scanning for directories${glob ? ' matching <b>' + esc(glob) + '</b>' : ''} that contain uppsrc/:</div>
    ${paths.map((p, i) => {
      const r = resolvePath(p);
      return `<div class="search-path"><span class="path-input">${esc(p)}</span><span class="path-arrow"> \u2192 </span><span class="path-resolved">${esc(r)}</span><span class="path-stats" id="ps-${i}"></span></div>`;
    }).join('')}
  </div>

  <button class="btn-scan" id="btnScan">Scan for Source Trees</button>

  <div class="section">Scan for .var Files</div>
  <div id="varscan_dirs_list" class="list-container"></div>
  <div class="list-add">
    <input type="text" id="varscan_dirs_input" placeholder="Add directory to scan for .var files (e.g. ~/.config/u++/theide)..." />
    <button class="btn-small" onclick="addVarScanDir()">+</button>
  </div>
  <div class="hint">Directories are scanned recursively for *.var assembly files.</div>

  <div id="varscan_results" class="list-container" style="margin-top:8px"></div>

  <button class="btn-scan" id="btnVarScan">Scan for .var Files</button>

  <div class="section">Workspaces</div>
  <div class="field">
    <label for="workspacesDirInput">Workspace Directory</label>
    <input type="text" id="workspacesDirInput" value="${esc(workspacesDir)}" />
    <div class="hint">Directory where .code-workspace files are stored. The ~ prefix is expanded to the home directory automatically.</div>
  </div>
  <div id="workspaces_list" class="list-container" style="margin-top:8px"></div>
  <div id="workspaces_empty" style="font-size:0.85em;opacity:0.5;margin-top:4px;display:${workspaceFiles.length === 0 ? 'block' : 'none'}">No workspace files found.</div>

  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-save" id="btnSave">Save</button>
  </div>

  <script>
    try {
    const vscode = acquireVsCodeApi();
    const homeDir = ${JSON.stringify(os.homedir())};
    const IS_WINDOWS = ${isWindows ? 'true' : 'false'};
    let PATHS = ${pathsJson};
    let MANUAL = ${manualJson};
    let FOUND = [];
    let VARSCAN_DIRS = ${scanDirsJson};
    let VARSCAN_RESULTS = [];
    let WORKSPACE_FILES = ${workspaceFilesJson};
    let WORKSPACES_DIR = ${JSON.stringify(workspacesDir)};
    let scanningActive = false;
    let dirProgress = {};

    function renderPaths() {
      const container = document.getElementById('paths_list');
      container.innerHTML = '';
      PATHS.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(p) + '</span>' +
          '<button class="btn-remove" title="Remove" onclick="removeItem(' + i + ')">&times;</button>';
        container.appendChild(div);
      });
    }

    function renderManual() {
      const container = document.getElementById('manual_list');
      container.innerHTML = '';
      MANUAL.forEach((entry, i) => {
        const p = entry.path;
        const tag = entry.addedManually ? ' <span style="opacity:0.4;font-size:0.75em">[manual]</span>' : '';
        const activateBtn = IS_WINDOWS
          ? '<button class="btn-activate" onclick="activateInstall(\\'' + escapeHtml(p).replace(/'/g, "\\'") + '\\',\\'' + escapeHtml(p).replace(/'/g, "\\'") + '\\')">Activate</button>'
          : '';
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(p) + tag + '</span>' +
          activateBtn +
          '<button class="btn-remove" title="Remove" onclick="removeManual(' + i + ')">&times;</button>';
        container.appendChild(div);
      });
      FOUND.forEach((inst, i) => {
        const activateBtn = IS_WINDOWS
          ? '<button class="btn-activate" onclick="activateInstall(\\'' + escapeHtml(inst.path).replace(/'/g, "\\'") + '\\',\\'' + escapeHtml(inst.label).replace(/'/g, "\\'") + '\\')">Activate</button>'
          : '';
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(inst.label) + ' <span style="opacity:0.5">' + escapeHtml(inst.path) + '</span></span>' +
          '<span class="item-assemblies">' + inst.assemblies.length + ' asm</span>' +
          activateBtn +
          '<button class="btn-remove" title="Remove" onclick="removeFound(' + i + ')">&times;</button>';
        container.appendChild(div);
      });
    }

    function renderScanProgress() {
      PATHS.forEach((p, i) => {
        const resolved = resolvePath(p);
        const el = document.getElementById('ps-' + i);
        if (!el) return;
        const st = dirProgress[resolved];
        if (!st) {
          el.textContent = '';
          return;
        }
        const spinnerHtml = st.done ? '' : '<span class="spinner"></span> ';
        el.innerHTML = spinnerHtml + 'scanned ' + st.scanned + ' &middot; found ' + st.found;
      });
    }

    function addItem() {
      const input = document.getElementById('paths_input');
      const val = input.value.trim();
      if (!val) return;
      PATHS.push(val);
      input.value = '';
      renderPaths();
    }

    function removeItem(idx) { PATHS.splice(idx, 1); renderPaths(); }

    function addManual() {
      const input = document.getElementById('manual_input');
      const val = input.value.trim();
      if (!val) return;
      vscode.postMessage({ type: 'validateManual', dir: val });
    }

    function removeManual(idx) { MANUAL.splice(idx, 1); renderManual(); }
    function removeFound(idx) { FOUND.splice(idx, 1); renderManual(); }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function getGlob() {
      return document.getElementById('globInput').value.trim() || '';
    }

    function activateInstall(instPath, label) {
      vscode.postMessage({ type: 'selectInstallation', path: instPath, label: label });
    }

    document.getElementById('paths_input').addEventListener('keydown', e => { if (e.key === 'Enter') addItem(); });
    document.getElementById('manual_input').addEventListener('keydown', e => { if (e.key === 'Enter') addManual(); });

    function resolvePath(p) {
      if (p === '~') return homeDir;
      if (p.length > 1 && p[1] === '/') return homeDir + p.substring(1);
      return p;
    }

    function renderVarScanDirs() {
      const container = document.getElementById('varscan_dirs_list');
      container.innerHTML = '';
      VARSCAN_DIRS.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(p) + '</span>' +
          '<button class="btn-remove" title="Remove" onclick="removeVarScanDir(' + i + ')">&times;</button>';
        container.appendChild(div);
      });
    }

    function addVarScanDir() {
      const input = document.getElementById('varscan_dirs_input');
      const val = input.value.trim();
      if (!val) return;
      if (!VARSCAN_DIRS.includes(val)) {
        VARSCAN_DIRS.push(val);
        renderVarScanDirs();
      }
      input.value = '';
    }

    function removeVarScanDir(idx) {
      VARSCAN_DIRS.splice(idx, 1);
      renderVarScanDirs();
    }

    function renderVarScanResults() {
      const container = document.getElementById('varscan_results');
      container.innerHTML = '';
      if (VARSCAN_RESULTS.length === 0) return;
      const header = document.createElement('div');
      header.className = 'section';
      header.textContent = 'Found Assemblies';
      container.appendChild(header);
      VARSCAN_RESULTS.forEach((a, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        const nestPreview = a.nests.length > 0 ? ' <span style="opacity:0.4;font-size:0.8em">' + escapeHtml(a.nests[0]) + (a.nests.length > 1 ? ' +' + (a.nests.length - 1) : '') + '</span>' : '';
        div.innerHTML = '<input type="checkbox" ' + (a.enabled ? 'checked' : '') + ' onchange="toggleAssembly(\\'' + escapeHtml(a.filePath).replace(/'/g, "\\'") + '\\', this.checked)" />' +
          '<span class="item-text">' + escapeHtml(a.name) + ' <span style="opacity:0.5">' + escapeHtml(a.filePath) + '</span>' + nestPreview + '</span>';
        container.appendChild(div);
      });
    }

    function onVarScanClick() {
      if (VARSCAN_DIRS.length === 0) return;
      vscode.postMessage({ type: 'varscan', dirs: VARSCAN_DIRS });
    }

    function toggleAssembly(filePath, enabled) {
      const idx = VARSCAN_RESULTS.findIndex(a => a.filePath === filePath);
      if (idx >= 0) VARSCAN_RESULTS[idx].enabled = enabled;
      vscode.postMessage({ type: 'toggleAssembly', filePath: filePath, enabled: enabled });
    }

    document.getElementById('btnVarScan').addEventListener('click', onVarScanClick);
    document.getElementById('varscan_dirs_input').addEventListener('keydown', e => { if (e.key === 'Enter') addVarScanDir(); });

    function onScanClick() {
      if (scanningActive) {
        vscode.postMessage({ type: 'cancelScan' });
        return;
      }
      scanningActive = true;
      FOUND = [];
      dirProgress = {};
      PATHS.forEach(p => {
        const resolved = resolvePath(p);
        dirProgress[resolved] = { scanned: 0, found: 0, done: false };
      });
      renderScanProgress();
      const btn = document.getElementById('btnScan');
      btn.textContent = 'Cancel Scan';
      btn.classList.add('btn-cancel-scan');
      renderManual();
      vscode.postMessage({ type: 'scan', paths: PATHS, glob: getGlob() });
    }

    document.getElementById('btnScan').addEventListener('click', onScanClick);

    document.getElementById('btnSave').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', paths: PATHS, manual: MANUAL, found: FOUND.map(f => f.path), glob: getGlob() });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    function resetScanBtn() {
      scanningActive = false;
      const btn = document.getElementById('btnScan');
      btn.textContent = 'Scan for Source Trees';
      btn.classList.remove('btn-cancel-scan');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'scanDirs') {
        if (msg.dirs) {
          msg.dirs.forEach(d => {
            if (!dirProgress[d]) {
              dirProgress[d] = { scanned: 0, found: 0, done: false };
            }
          });
        }
        renderScanProgress();

      } else if (msg.type === 'scanDirProgress') {
        if (dirProgress[msg.scanPath]) {
          dirProgress[msg.scanPath].scanned = msg.scanned;
          dirProgress[msg.scanPath].found = msg.found;
        } else {
          dirProgress[msg.scanPath] = { scanned: msg.scanned, found: msg.found, done: false };
        }
        renderScanProgress();

      } else if (msg.type === 'scanFound') {
        const inst = msg.installation;
        const exists = FOUND.some(f => f.path === inst.path) || MANUAL.some(e => e.path === inst.path);
        if (!exists) {
          FOUND.push(inst);
          renderManual();
        }
        renderScanProgress();

      } else if (msg.type === 'scanDone') {
        resetScanBtn();
        Object.keys(dirProgress).forEach(k => { dirProgress[k].done = true; });
        renderScanProgress();

      } else if (msg.type === 'scanCancelled') {
        resetScanBtn();
        Object.keys(dirProgress).forEach(k => { dirProgress[k].done = true; });
        renderScanProgress();

      } else if (msg.type === 'manualValidation') {
        const input = document.getElementById('manual_input');
        if (msg.valid) {
          if (!MANUAL.some(e => e.path === msg.resolved)) {
            MANUAL.push({ path: msg.resolved, addedManually: true });
            renderManual();
          }
          input.value = '';
          input.style.borderColor = '';
        } else {
          input.style.borderColor = 'var(--vscode-errorForeground)';
          input.title = 'Directory does not contain uppsrc/';
          setTimeout(() => { input.style.borderColor = ''; input.title = ''; }, 2000);
        }
      } else if (msg.type === 'updateManual') {
        const incoming = msg.manual || [];
        const incomingMigrated = incoming.map(e => typeof e === 'string' ? { path: e, addedManually: false } : e);
        const manualPaths = new Set(MANUAL.filter(e => e.addedManually).map(e => e.path));
        MANUAL = MANUAL.filter(e => e.addedManually);
        for (const e of incomingMigrated) {
          if (!manualPaths.has(e.path)) {
            MANUAL.push(e);
          }
        }
        FOUND = [];
        renderManual();
      } else if (msg.type === 'varscanResult') {
        VARSCAN_RESULTS = msg.assemblies || [];
        renderVarScanResults();
      } else if (msg.type === 'workspacesDirUpdated') {
        WORKSPACES_DIR = msg.dir;
        WORKSPACE_FILES = msg.files || [];
        document.getElementById('workspacesDirInput').value = msg.dir;
        renderWorkspaces();
      }
    });

    renderPaths();
    renderManual();
    renderVarScanDirs();
    renderVarScanResults();
    renderWorkspaces();

    function renderWorkspaces() {
      const container = document.getElementById('workspaces_list');
      const emptyEl = document.getElementById('workspaces_empty');
      container.innerHTML = '';
      if (WORKSPACE_FILES.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';
      WORKSPACE_FILES.forEach((f) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(f) + '</span>';
        container.appendChild(div);
      });
    }

    function onWorkspacesDirChange() {
      const newDir = document.getElementById('workspacesDirInput').value.trim();
      if (!newDir) return;
      const oldDir = WORKSPACES_DIR;
      if (newDir === oldDir) return;
      vscode.postMessage({ type: 'changeWorkspacesDir', oldDir: oldDir, newDir: newDir, existingFiles: WORKSPACE_FILES });
    }

    document.getElementById('workspacesDirInput').addEventListener('change', onWorkspacesDirChange);
    } catch(e) {
      document.body.innerHTML = '<div style="padding:20px;color:var(--vscode-errorForeground);font-size:16px;">Script error: ' + e.message + ' | ' + e.stack + '</div>';
    }
  </script>
</body>
</html>`;
}
