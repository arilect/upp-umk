import * as vscode from 'vscode';
import * as path from 'path';
import { parseBmFile, writeBmFile, BuildMethodData } from './assemblyParser';

export function showBuildMethodPanel(filePath: string) {
  const panel = vscode.window.createWebviewPanel(
    'uppBuildMethod',
    `Build Method: ${path.basename(filePath, '.bm')}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const data = parseBmFile(filePath);
  panel.webview.html = buildHtml(data);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      const updated: BuildMethodData = { ...data, ...msg.data, filePath };
      try {
        writeBmFile(filePath, updated);
        vscode.window.showInformationMessage(`UPP: Build method "${path.basename(filePath, '.bm')}" saved.`);
        panel.title = `Build Method: ${path.basename(filePath, '.bm')}`;
      } catch (err: any) {
        vscode.window.showErrorMessage(`UPP: Failed to save ${filePath}: ${err.message}`);
      }
    } else if (msg.type === 'openFile') {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(data: BuildMethodData): string {
  const filePath = esc(data.filePath);

  const textField = (key: string, label: string, value: string, hint: string, mono = true) => `
    <div class="field">
      <label for="${key}">${esc(label)}</label>
      <input type="text" id="${key}" value="${esc(value)}" class="${mono ? 'mono' : ''}" />
      <div class="hint">${hint}</div>
    </div>`;

  const bigTextField = (key: string, label: string, value: string, hint: string) => `
    <div class="field">
      <label for="${key}">${esc(label)}</label>
      <textarea id="${key}" rows="3" class="mono">${esc(value)}</textarea>
      <div class="hint">${hint}</div>
    </div>`;

  const semicolonList = (key: string, label: string, value: string, hint: string) => `
    <div class="field">
      <label>${esc(label)}</label>
      <div class="hint" style="margin-bottom:6px">${hint}</div>
      <div id="${key}_list" class="list-container"></div>
      <div class="list-add">
        <input type="text" id="${key}_input" placeholder="Add new entry..." />
        <button class="btn-small btn-add" onclick="addItem('${key}')">+</button>
      </div>
    </div>`;

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
    display: flex; flex-direction: column; height: 100vh;
    overflow-y: auto;
  }
  h2 { margin-bottom: 4px; font-weight: normal; font-size: 1.2em; }
  .filepath { font-size: 0.8em; opacity: 0.6; margin-bottom: 16px; cursor: pointer; text-decoration: underline; }
  .filepath:hover { opacity: 1; }
  .section { font-weight: bold; font-size: 0.9em; margin: 16px 0 8px 0; padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; margin-bottom: 3px; font-size: 0.9em; }
  .field .hint { font-size: 0.8em; opacity: 0.6; margin-top: 2px; }
  input[type="text"], textarea {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  textarea { resize: vertical; min-height: 60px; }
  .list-container { display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; }
  .list-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  .list-item .item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-item .btn-remove {
    background: none; border: none; color: var(--vscode-errorForeground);
    cursor: pointer; font-size: 1.1em; padding: 0 4px; opacity: 0.6;
  }
  .list-item .btn-remove:hover { opacity: 1; }
  .list-add { display: flex; gap: 4px; margin-top: 4px; }
  .list-add input { flex: 1; }
  .btn-small {
    padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 0.9em;
  }
  .btn-add { min-width: 30px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border); }
  .buttons button { padding: 6px 20px; border: none; border-radius: 2px; cursor: pointer; font-size: 0.9em; }
  .btn-save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-open { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; padding: 0; font-size: 0.85em; }
</style>
</head>
<body>
  <h2>Build Method: ${esc(path.basename(data.filePath, '.bm'))}</h2>
  <div class="filepath" id="openFile">${filePath}</div>

  <div class="section">Compiler</div>
  ${textField('BUILDER', 'Builder', data.BUILDER, 'e.g. CLANG, GCC')}
  ${textField('COMPILER', 'Compiler', data.COMPILER, 'e.g. clang++, g++')}

  <div class="section">Common</div>
  ${textField('COMMON_OPTIONS', 'Common Options', data.COMMON_OPTIONS, 'Passed to both C and C++ compilation')}
  ${textField('COMMON_CPP_OPTIONS', 'C++ Options', data.COMMON_CPP_OPTIONS, 'C++ specific flags (e.g. -std=c++20)')}
  ${textField('COMMON_C_OPTIONS', 'C Options', data.COMMON_C_OPTIONS, 'C specific flags')}
  ${bigTextField('COMMON_LINK', 'Linker Flags', data.COMMON_LINK, 'Libraries and linker flags (e.g. -lfoo -L/path)')}
  ${textField('COMMON_FLAGS', 'Common Flags', data.COMMON_FLAGS, 'Additional common flags')}
  ${textField('PATH', 'PATH', data.PATH, 'Extra PATH entries (semicolon-separated)')}

  <div class="section">Debug</div>
  ${textField('DEBUG_INFO', 'Debug Info', data.DEBUG_INFO, 'Debug info level (e.g. 2)')}
  ${textField('DEBUG_BLITZ', 'Debug Blitz', data.DEBUG_BLITZ, '1 = enabled')}
  ${textField('DEBUG_LINKMODE', 'Debug Linkmode', data.DEBUG_LINKMODE, '1 = static, 0 = shared')}
  ${textField('DEBUG_OPTIONS', 'Debug Options', data.DEBUG_OPTIONS, 'e.g. -O0')}
  ${textField('DEBUG_FLAGS', 'Debug Flags', data.DEBUG_FLAGS, 'Additional debug flags')}
  ${textField('DEBUG_LINK', 'Debug Link', data.DEBUG_LINK, 'Debug-specific linker flags')}
  ${textField('DEBUG_CUDA', 'Debug CUDA', data.DEBUG_CUDA, 'CUDA debug flags')}

  <div class="section">Release</div>
  ${textField('RELEASE_BLITZ', 'Release Blitz', data.RELEASE_BLITZ, '1 = enabled')}
  ${textField('RELEASE_LINKMODE', 'Release Linkmode', data.RELEASE_LINKMODE, '1 = static, 0 = shared')}
  ${textField('RELEASE_OPTIONS', 'Release Options', data.RELEASE_OPTIONS, 'e.g. -O3')}
  ${textField('RELEASE_FLAGS', 'Release Flags', data.RELEASE_FLAGS, 'Additional release flags')}
  ${textField('RELEASE_LINK', 'Release Link', data.RELEASE_LINK, 'Release-specific linker flags')}
  ${textField('RELEASE_CUDA', 'Release CUDA', data.RELEASE_CUDA, 'CUDA release flags')}

  <div class="section">Misc</div>
  ${textField('DEBUGGER', 'Debugger', data.DEBUGGER, 'e.g. gdb, lldb')}
  ${textField('ALLOW_PRECOMPILED_HEADERS', 'Allow PCH', data.ALLOW_PRECOMPILED_HEADERS, '1 = enabled')}
  ${textField('DISABLE_BLITZ', 'Disable Blitz', data.DISABLE_BLITZ, '1 = disable blitz builds')}
  ${textField('LINKMODE_LOCK', 'Linkmode Lock', data.LINKMODE_LOCK, '1 = lock linkmode')}

  <div class="section">Paths</div>
  ${semicolonList('INCLUDE', 'Include Paths', data.INCLUDE, 'Semicolon-separated include directories')}
  ${semicolonList('LIB', 'Library Paths', data.LIB, 'Semicolon-separated library directories')}

  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-save" id="btnSave">Save</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function getVal(id) { return document.getElementById(id).value; }
    function setVal(id, v) { document.getElementById(id).value = v; }

    // --- Semicolon-separated lists ---
    const LISTS = {};
    function initList(key, semicolonValue) {
      const items = semicolonValue ? semicolonValue.split(';').filter(Boolean) : [];
      LISTS[key] = items;
      renderList(key);
    }
    function renderList(key) {
      const container = document.getElementById(key + '_list');
      container.innerHTML = '';
      LISTS[key].forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<span class="item-text">' + escapeHtml(item) + '</span>' +
          '<button class="btn-remove" title="Remove" onclick="removeItem(\\'' + key + '\\',' + i + ')">&times;</button>';
        container.appendChild(div);
      });
    }
    function addItem(key) {
      const input = document.getElementById(key + '_input');
      const val = input.value.trim();
      if (!val) return;
      LISTS[key].push(val);
      input.value = '';
      renderList(key);
    }
    function removeItem(key, idx) {
      LISTS[key].splice(idx, 1);
      renderList(key);
    }
    function getListValue(key) {
      return LISTS[key].join(';');
    }
    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Handle Enter key in list inputs
    document.querySelectorAll('.list-add input').forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const key = input.id.replace('_input', '');
          addItem(key);
        }
      });
    });

    // Init lists
    initList('INCLUDE', ${JSON.stringify(data.INCLUDE)});
    initList('LIB', ${JSON.stringify(data.LIB)});

    // --- Save / Cancel ---
    document.getElementById('btnSave').addEventListener('click', () => {
      const result = {};
      ['BUILDER','COMPILER','COMMON_OPTIONS','COMMON_CPP_OPTIONS','COMMON_C_OPTIONS',
       'COMMON_LINK','COMMON_FLAGS','DEBUG_INFO','DEBUG_BLITZ','DEBUG_LINKMODE',
       'DEBUG_OPTIONS','DEBUG_FLAGS','DEBUG_LINK','DEBUG_CUDA',
       'RELEASE_BLITZ','RELEASE_LINKMODE','RELEASE_OPTIONS','RELEASE_FLAGS',
       'RELEASE_LINK','RELEASE_CUDA','DEBUGGER','ALLOW_PRECOMPILED_HEADERS',
       'DISABLE_BLITZ','PATH','LINKMODE_LOCK'].forEach(k => {
        result[k] = getVal(k);
      });
      result['INCLUDE'] = getListValue('INCLUDE');
      result['LIB'] = getListValue('LIB');
      vscode.postMessage({ type: 'save', data: result });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('openFile').addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile' });
    });
  </script>
</body>
</html>`;
}
