import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Assembly, getDefaultVarDirs } from './assemblyParser';

export function showNewAssemblyPanel(
  existingAssemblies: Assembly[],
  onCreated: (assembly: Assembly) => void,
) {
  const panel = vscode.window.createWebviewPanel(
    'uppNewAssembly',
    'New U++ Assembly',
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const defaultOutputBase = path.join(os.homedir(), '.cache', 'upp.out');

  panel.webview.html = buildHtml(existingAssemblies.map(a => a.name), defaultOutputBase);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'create') {
      const name: string = (msg.name ?? '').trim();
      const nests: string = (msg.nests ?? '').trim();
      const outputDir: string = (msg.outputDir ?? '').trim();
      const uppHub: string = (msg.uppHub ?? '').trim();

      // Validate name
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) {
        panel.webview.postMessage({ type: 'error', message: 'Invalid assembly name. Use letters, digits, underscores (start with letter or _).' });
        return;
      }

      // Check duplicate
      if (existingAssemblies.some(a => a.name === name)) {
        panel.webview.postMessage({ type: 'error', message: `Assembly "${name}" already exists.` });
        return;
      }

      // Parse nests
      const nestList = nests.split('\n').map(s => s.trim()).filter(Boolean);
      if (nestList.length === 0) {
        panel.webview.postMessage({ type: 'error', message: 'At least one nest directory is required.' });
        return;
      }

      // Ensure uppsrc is in the nest list (as second entry)
      let uppsrc = '';
      const candidates = [
        path.join(os.homedir(), 'upp-stable'),
        path.join(os.homedir(), 'upp'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'uppsrc'))) {
          uppsrc = path.join(candidate, 'uppsrc');
          break;
        }
      }
      if (uppsrc) {
        const normalizedUp = uppsrc.replace(/\\/g, '/').replace(/\/+$/, '');
        const hasUp = nestList.some(n => n.replace(/\\/g, '/').replace(/\/+$/, '') === normalizedUp);
        if (!hasUp) {
          nestList.splice(1, 0, uppsrc);
        }
      }

      // Resolve .var file path
      const cfg = vscode.workspace.getConfiguration('upp');
      const varDir: string = cfg.get('varDir', '') || getDefaultVarDirs()[0];
      const varPath = path.join(varDir, `${name}.var`);

      if (fs.existsSync(varPath)) {
        panel.webview.postMessage({ type: 'error', message: `File already exists: ${varPath}` });
        return;
      }

      // Build .var content
      const uppValue = nestList.map(n => n.replace(/\\/g, '/')).join(';') + ';';
      const outputValue = outputDir || path.join(defaultOutputBase, name);
      const uppHubValue = uppHub || '';

      const lines = [
        `UPP = "${uppValue}";`,
        `OUTPUT = "${outputValue}";`,
      ];
      if (uppHubValue) {
        lines.push(`UPPHUB = "${uppHubValue}";`);
      }
      lines.push(`_all = "0";`);
      lines.push('');

      // Ensure directory exists
      if (!fs.existsSync(varDir)) {
        fs.mkdirSync(varDir, { recursive: true });
      }

      // Write .var file
      try {
        fs.writeFileSync(varPath, lines.join('\n'), 'utf8');
      } catch (err: any) {
        panel.webview.postMessage({ type: 'error', message: `Failed to write ${varPath}: ${err.message}` });
        return;
      }

      // Parse and return the new assembly
      const { parseAssembly } = await import('./assemblyParser');
      const assembly = parseAssembly(varPath);
      onCreated(assembly);
      panel.dispose();
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(existingNames: string[], defaultOutputBase: string): string {
  const existingJson = JSON.stringify(existingNames);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; display: flex; flex-direction: column; height: 100vh; }
  h2 { margin-bottom: 16px; font-weight: normal; }
  .field { margin-bottom: 14px; }
  .field label { display: block; margin-bottom: 4px; font-weight: bold; }
  .field .hint { font-size: 0.85em; opacity: 0.7; margin-top: 2px; }
  input, textarea { width: 100%; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  textarea { resize: vertical; min-height: 80px; }
  .error { color: var(--vscode-errorForeground); margin-bottom: 12px; display: none; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .buttons button { padding: 6px 16px; border: none; border-radius: 2px; cursor: pointer; }
  .btn-create { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
  <h2>Create New U++ Assembly</h2>
  <div class="error" id="error"></div>
  <div class="field">
    <label for="name">Assembly Name</label>
    <input type="text" id="name" placeholder="e.g. myproject" />
    <div class="hint">Used as the assembly argument for umk. Letters, digits, underscores.</div>
  </div>
  <div class="field">
    <label for="nests">Nest Directories</label>
    <textarea id="nests" placeholder="/path/to/nest1&#10;/path/to/nest2"></textarea>
    <div class="hint">One directory per line. These are the U++ source trees.</div>
  </div>
  <div class="field">
    <label for="outputDir">Output Directory</label>
    <input type="text" id="outputDir" placeholder="${esc(defaultOutputBase + '/<name>')}" />
    <div class="hint">Build output directory. Defaults to ~/.cache/upp.out/&lt;name&gt;</div>
  </div>
  <div class="field">
    <label for="uppHub">UppHub Directory (optional)</label>
    <input type="text" id="uppHub" placeholder="" />
    <div class="hint">Path to UppHub clone. Leave empty if not using UppHub.</div>
  </div>
  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-create" id="btnCreate">Create</button>
  </div>
  <script>
    const EXISTING = ${existingJson};
    const vscode = acquireVsCodeApi();
    const errorEl = document.getElementById('error');

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    document.getElementById('btnCreate').addEventListener('click', () => {
      const name = document.getElementById('name').value.trim();
      const nests = document.getElementById('nests').value;
      const outputDir = document.getElementById('outputDir').value;
      const uppHub = document.getElementById('uppHub').value;

      if (!name) { showError('Assembly name is required.'); return; }
      if (!/^[A-Za-z_]\\w*$/.test(name)) { showError('Invalid name. Use letters, digits, underscores.'); return; }
      if (EXISTING.includes(name)) { showError('Assembly "' + name + '" already exists.'); return; }
      if (!nests.trim()) { showError('At least one nest directory is required.'); return; }

      errorEl.style.display = 'none';
      vscode.postMessage({ type: 'create', name, nests, outputDir, uppHub });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    window.addEventListener('message', e => {
      if (e.data.type === 'error') {
        showError(e.data.message);
      }
    });

    document.getElementById('name').focus();
  </script>
</body>
</html>`;
}
