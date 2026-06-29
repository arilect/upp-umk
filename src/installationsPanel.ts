import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanInstallationsAsync, scanInstallations, resolvePath, UppInstallation } from './installations';

export function showInstallationsPanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppInstallations',
    'U++ Installations',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const cfg = vscode.workspace.getConfiguration('upp');
  const currentPaths = cfg.get<string[]>('installationsPaths', ['~']);
  const currentGlob = cfg.get<string>('installationsGlob', '');
  const currentManual = cfg.get<string[]>('installationsManual', []);

  const allKnown = scanInstallations();
  const knownPaths = allKnown.map(i => i.path);
  const mergedManual = [...new Set([...currentManual, ...knownPaths])];
  if (mergedManual.length !== currentManual.length) {
    cfg.update('installationsManual', mergedManual, vscode.ConfigurationTarget.Global);
  }

  panel.webview.html = buildHtml(currentPaths, currentGlob, mergedManual);

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
        const currentManual = cfg.get<string[]>('installationsManual', []);
        const merged = [...new Set([...currentManual, ...foundPaths])];
        await cfg.update('installationsManual', merged, vscode.ConfigurationTarget.Global);
      }

      panel.webview.postMessage({ type: 'scanDone', totalFound: foundMap.size });
      const updatedManual = cfg.get<string[]>('installationsManual', []);
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
      const manual: string[] = msg.manual || [];
      const found: string[] = msg.found || [];
      const glob: string = msg.glob || '';
      const all = [...new Set([...manual, ...found])];
      await cfg.update('installationsPaths', paths, vscode.ConfigurationTarget.Global);
      await cfg.update('installationsGlob', glob, vscode.ConfigurationTarget.Global);
      await cfg.update('installationsManual', all, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Saved ${paths.length} scan path(s), ${all.length} installation(s).`);

    } else if (msg.type === 'selectInstallation') {
      const instPath: string = msg.path;
      const label: string = msg.label;
      await cfg.update('activeInstallation', instPath, vscode.ConfigurationTarget.Global);
      const umkPath = path.join(instPath, process.platform === 'win32' ? 'umk.exe' : 'umk');
      await cfg.update('umkPath', umkPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`UPP: Switched to "${label}".`);
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(paths: string[], glob: string, manual: string[]): string {
  const pathsJson = JSON.stringify(paths);
  const manualJson = JSON.stringify(manual);

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
  <h2>U++ Installations</h2>
  <div class="subtitle">Configure directories and pattern to scan for U++ installations.</div>

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

  <div class="section">Installations</div>
  <div id="manual_list" class="list-container"></div>
  <div class="list-add">
    <input type="text" id="manual_input" placeholder="Add installation path directly (e.g. /opt/upp, ~/upp-24.1/upp)..." />
    <button class="btn-small" onclick="addManual()">+</button>
  </div>
  <div class="hint">Add U++ installation directories directly. Must contain uppsrc/.</div>

  <div class="search-info">
    <div class="info-title">What will be scanned</div>
    <div style="opacity:0.6; margin-bottom:4px;">Scanning for directories${glob ? ' matching <b>' + esc(glob) + '</b>' : ''} that contain uppsrc/:</div>
    ${paths.map((p, i) => {
      const r = resolvePath(p);
      return `<div class="search-path"><span class="path-input">${esc(p)}</span><span class="path-arrow"> \u2192 </span><span class="path-resolved">${esc(r)}</span><span class="path-stats" id="ps-${i}"></span></div>`;
    }).join('')}
  </div>

  <button class="btn-scan" id="btnScan">Scan for Installations</button>

  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-save" id="btnSave">Save</button>
  </div>

  <script>
    try {
    const vscode = acquireVsCodeApi();
    const homeDir = ${JSON.stringify(os.homedir())};
    let PATHS = ${pathsJson};
    let MANUAL = ${manualJson};
    let FOUND = [];
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
      MANUAL.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(p) + '</span>' +
          '<button class="btn-activate" onclick="activateInstall(\\'' + escapeHtml(p).replace(/'/g, "\\'") + '\\',\\'' + escapeHtml(p).replace(/'/g, "\\'") + '\\')">Activate</button>' +
          '<button class="btn-remove" title="Remove" onclick="removeManual(' + i + ')">&times;</button>';
        container.appendChild(div);
      });
      FOUND.forEach((inst, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(inst.label) + ' <span style="opacity:0.5">' + escapeHtml(inst.path) + '</span></span>' +
          '<span class="item-assemblies">' + inst.assemblies.length + ' asm</span>' +
          '<button class="btn-activate" onclick="activateInstall(\\'' + escapeHtml(inst.path).replace(/'/g, "\\'") + '\\',\\'' + escapeHtml(inst.label).replace(/'/g, "\\'") + '\\')">Activate</button>' +
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
      btn.textContent = 'Scan for Installations';
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
        const exists = FOUND.some(f => f.path === inst.path) || MANUAL.includes(inst.path);
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
          if (!MANUAL.includes(msg.resolved)) {
            MANUAL.push(msg.resolved);
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
        MANUAL = msg.manual || [];
        FOUND = [];
        renderManual();
      }
    });

    renderPaths();
    renderManual();
    } catch(e) {
      document.body.innerHTML = '<div style="padding:20px;color:var(--vscode-errorForeground);font-size:16px;">Script error: ' + e.message + ' | ' + e.stack + '</div>';
    }
  </script>
</body>
</html>`;
}
