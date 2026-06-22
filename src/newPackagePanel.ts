import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { UptTemplate, renderBlocks } from './uptParser';
import { Assembly } from './assemblyParser';

export function showNewPackagePanel(
  assembly: Assembly | undefined,
  onCreated: (pkgName: string, pkgDir: string) => void,
) {
  const panel = vscode.window.createWebviewPanel(
    'uppNewPackage',
    'New U++ Package',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const templates = assembly ? collectTemplates(assembly) : [];
  const nests = assembly?.nests ?? [];
  const tplData = templates.map(t => ({
    name: t.name,
    sourcePath: t.sourcePath,
    options: t.options,
  }));

  panel.webview.html = buildHtml(templates, nests);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'create': {
        const { pkgName, nestIdx, templateIdx, optionValues } = msg;
        if (!pkgName || !/^[A-Za-z_]\w*$/.test(pkgName)) {
          panel.webview.postMessage({ type: 'error', text: 'Invalid package name.' });
          return;
        }
        if (nestIdx < 0 || nestIdx >= nests.length) {
          panel.webview.postMessage({ type: 'error', text: 'Invalid nest.' });
          return;
        }
        if (templateIdx < 0 || templateIdx >= templates.length) {
          panel.webview.postMessage({ type: 'error', text: 'Invalid template.' });
          return;
        }

        const nest = nests[nestIdx];
        const pkgDir = path.join(nest, pkgName);
        if (fs.existsSync(pkgDir)) {
          panel.webview.postMessage({ type: 'error', text: `Directory "${pkgDir}" already exists.` });
          return;
        }

        const tpl = templates[templateIdx];
        const files = renderBlocks(tpl, pkgName, optionValues);

        fs.mkdirSync(pkgDir, { recursive: true });
        for (const [filename, content] of files) {
          fs.writeFileSync(path.join(pkgDir, filename), content);
        }

        const uppPath = path.join(pkgDir, `${pkgName}.upp`);
        onCreated(pkgName, pkgDir);
        panel.dispose();
        break;
      }
      case 'preview': {
        const { templateIdx, optionValues } = msg;
        if (templateIdx < 0 || templateIdx >= templates.length) return;
        const tpl = templates[templateIdx];
        const files = renderBlocks(tpl, optionValues['PACKAGE'] || 'PackageName', optionValues);
        const preview: Record<string, string> = {};
        for (const [k, v] of files) preview[k] = v;
        panel.webview.postMessage({ type: 'preview', files: preview });
        break;
      }
    }
  });
}

function collectTemplates(assembly: Assembly): UptTemplate[] {
  const templates: UptTemplate[] = [];
  const seen = new Set<string>();

  for (const nest of assembly.nests) {
    if (!fs.existsSync(nest)) continue;

    const uptDir = path.join(nest, 'upt');
    if (fs.existsSync(uptDir)) {
      try {
        for (const f of fs.readdirSync(uptDir)) {
          if (!f.endsWith('.upt')) continue;
          const full = path.join(uptDir, f);
          if (seen.has(full)) continue;
          seen.add(full);
          const { parseUptFile } = require('./uptParser');
          const tpl = parseUptFile(full);
          if (tpl) templates.push(tpl);
        }
      } catch { /* ignore */ }
    }

    try {
      for (const entry of fs.readdirSync(nest, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(nest, entry.name);
        try {
          for (const f of fs.readdirSync(pkgDir)) {
            if (!f.endsWith('.upt')) continue;
            const full = path.join(pkgDir, f);
            if (seen.has(full)) continue;
            seen.add(full);
            const { parseUptFile } = require('./uptParser');
            const tpl = parseUptFile(full);
            if (tpl) templates.push(tpl);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return templates;
}

function buildHtml(templates: UptTemplate[], nests: string[]): string {
  const tplJson = JSON.stringify(templates.map(t => ({
    name: t.name,
    sourcePath: t.sourcePath,
    options: t.options,
  })));

  const nestOptions = nests.map((n, i) =>
    `<option value="${i}">${path.basename(n)} (${n})</option>`
  ).join('');

  const tplListItems = templates.map((t, i) =>
    `<div class="tpl-item" data-idx="${i}" ${i === 0 ? 'data-selected="true"' : ''}>
      <div class="tpl-name">${escHtml(t.name)}</div>
      <div class="tpl-path">${escHtml(path.basename(t.sourcePath))}</div>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; display: flex; flex-direction: column; height: 100vh; }
  .row { display: flex; gap: 12px; margin-bottom: 8px; align-items: center; }
  .row label { min-width: 90px; text-align: right; }
  .row input, .row select { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
  .main { display: flex; gap: 12px; flex: 1; min-height: 0; }
  .left { width: 25%; min-width: 200px; display: flex; flex-direction: column; }
  .tpl-list { flex: 1; overflow-y: auto; border: 1px solid var(--vscode-input-border); border-radius: 2px; }
  .tpl-item { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid var(--vscode-input-border); }
  .tpl-item:hover { background: var(--vscode-list-hoverBackground); }
  .tpl-item[data-selected] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .tpl-name { font-weight: bold; }
  .tpl-path { font-size: 0.85em; opacity: 0.7; }
  .right { width: 75%; display: flex; flex-direction: column; }
  #options { margin-bottom: 8px; }
  .opt-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .opt-row label { min-width: 140px; }
  .opt-row select, .opt-row input[type="text"] { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
  .preview { flex: 1; overflow: auto; border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: monospace; font-size: 12px; background: var(--vscode-editor-background); padding: 8px; white-space: pre; }
  .preview-file { margin-bottom: 12px; }
  .preview-filename { font-weight: bold; color: var(--vscode-textLink-foreground); margin-bottom: 2px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .buttons button { padding: 6px 16px; border: none; border-radius: 2px; cursor: pointer; }
  .btn-create { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-create:hover { background: var(--vscode-button-hoverBackground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .error { color: var(--vscode-errorForeground); margin-top: 8px; }
</style>
</head>
<body>
  <div class="row">
    <label for="pkgName">Package:</label>
    <input id="pkgName" type="text" placeholder="MyPackage" autofocus />
  </div>
  <div class="row">
    <label for="nestSel">Create in:</label>
    <select id="nestSel">${nestOptions}</select>
  </div>
  <div class="main">
    <div class="left">
      <div class="tpl-list" id="tplList">${tplListItems}</div>
    </div>
    <div class="right">
      <div id="options"></div>
      <div class="preview" id="preview">Select a template to see a preview.</div>
    </div>
  </div>
  <div class="error" id="error"></div>
  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-create" id="btnCreate">Create</button>
  </div>
  <script>
    const TEMPLATES = ${tplJson};
    let selectedTpl = 0;
    const vscode = acquireVsCodeApi();

    // Template list click
    document.getElementById('tplList').addEventListener('click', e => {
      const item = e.target.closest('.tpl-item');
      if (!item) return;
      document.querySelectorAll('.tpl-item').forEach(el => el.removeAttribute('data-selected'));
      item.setAttribute('data-selected', 'true');
      selectedTpl = parseInt(item.dataset.idx);
      renderOptions();
      sendPreview();
    });

    function renderOptions() {
      const container = document.getElementById('options');
      const tpl = TEMPLATES[selectedTpl];
      if (!tpl || !tpl.options.length) { container.innerHTML = ''; return; }
      const pkgName = document.getElementById('pkgName').value.trim() || 'PackageName';
      let html = '';
      for (const opt of tpl.options) {
        const id = 'opt_' + opt.varname;
        if (opt.type === 'bool') {
          html += '<div class="opt-row"><input type="checkbox" id="' + id + '" data-var="' + opt.varname + '"' + (opt.default ? ' checked' : '') + ' /><label for="' + id + '">' + esc(opt.label) + '</label></div>';
        } else if (opt.type === 'select') {
          html += '<div class="opt-row"><label>' + esc(opt.label) + ':</label><select id="' + id + '" data-var="' + opt.varname + '">';
          for (let i = 0; i < opt.choices.length; i++) {
            html += '<option value="' + i + '"' + (i === opt.default ? ' selected' : '') + '>' + esc(opt.choices[i]) + '</option>';
          }
          html += '</select></div>';
        } else if (opt.type === 'id') {
          // Resolve default: if it's a variable name (like PACKAGE), use the package name
          const defaultVal = (opt.default === 'PACKAGE') ? pkgName : String(opt.default);
          html += '<div class="opt-row"><label>' + esc(opt.label) + ':</label><input type="text" id="' + id + '" data-var="' + opt.varname + '" value="' + esc(defaultVal) + '" data-idref="' + esc(opt.default) + '" /></div>';
        }
      }
      container.innerHTML = html;
      // Wire up change events
      container.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('change', () => sendPreview());
        el.addEventListener('input', () => sendPreview());
      });
    }

    function getOptionValues() {
      const vals = {};
      const tpl = TEMPLATES[selectedTpl];
      if (!tpl) return vals;
      // Include PACKAGE so id variables that reference it resolve correctly
      vals['PACKAGE'] = document.getElementById('pkgName').value.trim() || 'PackageName';
      for (const opt of tpl.options) {
        const el = document.getElementById('opt_' + opt.varname);
        if (!el) continue;
        if (opt.type === 'bool') vals[opt.varname] = el.checked;
        else if (opt.type === 'select') vals[opt.varname] = parseInt(el.value);
        else if (opt.type === 'id') vals[opt.varname] = el.value;
      }
      return vals;
    }

    function sendPreview() {
      vscode.postMessage({ type: 'preview', templateIdx: selectedTpl, optionValues: getOptionValues() });
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    document.getElementById('btnCreate').addEventListener('click', () => {
      const pkgName = document.getElementById('pkgName').value.trim();
      const nestIdx = parseInt(document.getElementById('nestSel').value);
      vscode.postMessage({
        type: 'create',
        pkgName,
        nestIdx,
        templateIdx: selectedTpl,
        optionValues: getOptionValues(),
      });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'preview') {
        const preview = document.getElementById('preview');
        let html = '';
        for (const [name, content] of Object.entries(msg.files)) {
          html += '<div class="preview-file"><div class="preview-filename">' + esc(name) + '</div>' + esc(content) + '</div>';
        }
        preview.innerHTML = html || '<span style="opacity:0.5">No files generated.</span>';
      }
      if (msg.type === 'error') {
        document.getElementById('error').textContent = msg.text;
      }
    });

    // Package name changes update id inputs that reference PACKAGE and the preview
    let lastPkgName = document.getElementById('pkgName').value.trim() || 'PackageName';
    document.getElementById('pkgName').addEventListener('input', () => {
      const newPkgName = document.getElementById('pkgName').value.trim() || 'PackageName';
      // Update id inputs whose value still matches the old package name
      document.querySelectorAll('[data-idref="PACKAGE"]').forEach(el => {
        if (el.value === lastPkgName) el.value = newPkgName;
      });
      lastPkgName = newPkgName;
      sendPreview();
    });

    // Initial render
    renderOptions();
    sendPreview();
  </script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
