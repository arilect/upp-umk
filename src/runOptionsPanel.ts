import * as vscode from 'vscode';
import { getDefaultTerminal } from './actions';

interface RunOptions {
  outputConsole: string;
  runArgs: string;
  runCwd: string;
  runEnv: string;
  terminalApp: string;
  useIntegratedTerminal: boolean;
}

function readRunOptions(): RunOptions {
  const cfg = vscode.workspace.getConfiguration('upp');
  const custom: string = cfg.get('terminalApp', '');
  return {
    outputConsole: cfg.get('outputConsole', 'auto'),
    runArgs: cfg.get('runArgs', ''),
    runCwd: cfg.get('runCwd', ''),
    runEnv: cfg.get('runEnv', ''),
    terminalApp: custom || getDefaultTerminal(),
    useIntegratedTerminal: cfg.get('useIntegratedTerminal', false),
  };
}

async function saveRunOptions(opts: RunOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('upp');
  await cfg.update('outputConsole', opts.outputConsole, vscode.ConfigurationTarget.Workspace);
  await cfg.update('runArgs', opts.runArgs, vscode.ConfigurationTarget.Workspace);
  await cfg.update('runCwd', opts.runCwd, vscode.ConfigurationTarget.Workspace);
  await cfg.update('runEnv', opts.runEnv, vscode.ConfigurationTarget.Workspace);
  await cfg.update('terminalApp', opts.terminalApp || '', vscode.ConfigurationTarget.Workspace);
  await cfg.update('useIntegratedTerminal', opts.useIntegratedTerminal, vscode.ConfigurationTarget.Global);
}

export function showRunOptionsPanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppRunOptions',
    'Run Options',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const opts = readRunOptions();
  panel.webview.html = buildHtml(opts);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      await saveRunOptions(msg.data as RunOptions);
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(opts: RunOptions): string {
  const envPairs: { key: string; value: string }[] = [];
  if (opts.runEnv.trim()) {
    for (const line of opts.runEnv.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        envPairs.push({ key: trimmed.substring(0, eq), value: trimmed.substring(eq + 1) });
      } else {
        envPairs.push({ key: trimmed, value: '' });
      }
    }
  }

  const isCustom = opts.terminalApp !== getDefaultTerminal();

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
    overflow-y: auto;
  }
  h2 { margin-bottom: 16px; font-weight: normal; font-size: 1.2em; }
  .field { margin-bottom: 14px; }
  .field label { display: block; margin-bottom: 3px; font-size: 0.9em; font-weight: bold; }
  .field .hint { font-size: 0.8em; opacity: 0.6; margin-top: 2px; }
  input[type="text"], textarea, select {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  select { width: auto; min-width: 140px; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  textarea { resize: vertical; min-height: 60px; }
  .section { font-weight: bold; font-size: 0.9em; margin: 18px 0 8px 0; padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
  .env-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
  .env-item {
    display: flex; align-items: center; gap: 6px;
  }
  .env-item input { font-family: var(--vscode-editor-font-family, monospace); }
  .env-item .env-key { width: 160px; flex-shrink: 0; }
  .env-item .env-val { flex: 1; }
  .env-item .btn-remove {
    background: none; border: none; color: var(--vscode-errorForeground);
    cursor: pointer; font-size: 1.1em; padding: 0 4px; opacity: 0.6;
  }
  .env-item .btn-remove:hover { opacity: 1; }
  .env-add { display: flex; gap: 4px; margin-top: 6px; }
  .env-add input { flex: 1; }
  .btn-small {
    padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 0.9em;
  }
  .btn-add { min-width: 30px; }
</style>
</head>
<body>
  <h2>Run Options</h2>

  <div class="section">Terminal</div>
  <div class="field">
    <label style="display:flex;align-items:center;gap:6px;font-weight:normal;">
      <input type="checkbox" id="useIntegrated" ${opts.useIntegratedTerminal ? 'checked' : ''} />
      Use VS Code integrated terminal
    </label>
    <div class="hint">Run programs inside VS Code's terminal instead of an external emulator. Recommended for remote / headless (code-server, VPS). Auto-enabled when no display server is available.</div>
  </div>
  <div class="field">
    <label for="terminalAppInput">Terminal Emulator</label>
    <input type="text" id="terminalAppInput" value="${isCustom ? esc(opts.terminalApp) : ''}" class="mono" placeholder="auto: ${esc(opts.terminalApp)}" ${opts.useIntegratedTerminal ? 'disabled' : ''} />
    <div class="hint">Leave empty to auto-detect (${esc(opts.terminalApp)}). Enter a name to override (e.g. kitty, alacritty, foot; on Windows: wt, pwsh, powershell). Ignored when the integrated terminal is used.</div>
  </div>
  <div class="field">
    <label for="outputConsole">Open Terminal</label>
    <select id="outputConsole">
      <option value="always" ${opts.outputConsole === 'always' ? 'selected' : ''}>Always</option>
      <option value="auto" ${opts.outputConsole === 'auto' ? 'selected' : ''}>Auto (on failure)</option>
      <option value="never" ${opts.outputConsole === 'never' ? 'selected' : ''}>Never</option>
    </select>
    <div class="hint">When to open the terminal during run.</div>
  </div>

  <div class="section">Program</div>
  <div class="field">
    <label for="runArgs">Program Arguments</label>
    <input type="text" id="runArgs" value="${esc(opts.runArgs)}" class="mono" />
    <div class="hint">Extra arguments passed to the binary after execution.</div>
  </div>

  <div class="section">Working Directory</div>
  <div class="field">
    <label for="runCwd">Working Directory</label>
    <input type="text" id="runCwd" value="${esc(opts.runCwd)}" placeholder="build output dir (default)" />
    <div class="hint">Leave empty to use the build output directory (auto-detected from the U++ source tree).</div>
  </div>

  <div class="section">Environment Variables</div>
  <div class="field">
    <div class="env-list" id="envList"></div>
    <div class="env-add">
      <input type="text" id="envKeyInput" placeholder="KEY" style="width:160px;flex-shrink:0" />
      <input type="text" id="envValInput" placeholder="VALUE" style="flex:1" />
      <button class="btn-small btn-add" onclick="addEnv()">+</button>
    </div>
    <div class="hint">One variable per row. KEY=VALUE format.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const envPairs = ${JSON.stringify(envPairs)};

    function save() {
      const useIntegrated = document.getElementById('useIntegrated').checked;
      vscode.postMessage({
        type: 'save',
        data: {
          outputConsole: document.getElementById('outputConsole').value,
          runArgs: document.getElementById('runArgs').value,
          runCwd: document.getElementById('runCwd').value,
          runEnv: getEnvString(),
          terminalApp: useIntegrated ? '' : document.getElementById('terminalAppInput').value,
          useIntegratedTerminal: useIntegrated,
        }
      });
    }

    function renderEnv() {
      const list = document.getElementById('envList');
      list.innerHTML = '';
      envPairs.forEach((pair, i) => {
        const div = document.createElement('div');
        div.className = 'env-item';
        div.innerHTML =
          '<input type="text" class="env-key" value="' + escapeAttr(pair.key) + '" oninput="updateEnv(' + i + ', \'key\', this.value); save()" />' +
          '<span>=</span>' +
          '<input type="text" class="env-val" value="' + escapeAttr(pair.value) + '" oninput="updateEnv(' + i + ', \'val\', this.value); save()" />' +
          '<button class="btn-remove" title="Remove" onclick="removeEnv(' + i + '); save()">&times;</button>';
        list.appendChild(div);
      });
    }

    function addEnv() {
      const keyInput = document.getElementById('envKeyInput');
      const valInput = document.getElementById('envValInput');
      const key = keyInput.value.trim();
      if (!key) return;
      envPairs.push({ key: key, value: valInput.value });
      keyInput.value = '';
      valInput.value = '';
      renderEnv();
      save();
    }

    function removeEnv(idx) {
      envPairs.splice(idx, 1);
      renderEnv();
    }

    function updateEnv(idx, field, val) {
      if (field === 'key') envPairs[idx].key = val;
      else envPairs[idx].value = val;
    }

    function escapeAttr(s) {
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function getEnvString() {
      return envPairs.map(p => p.key + '=' + p.value).join('\\n');
    }

    renderEnv();

    document.getElementById('useIntegrated').addEventListener('change', e => {
      const input = document.getElementById('terminalAppInput');
      input.disabled = (e.target as HTMLInputElement).checked;
      save();
    });
    document.getElementById('terminalAppInput').addEventListener('input', save);
    document.getElementById('outputConsole').addEventListener('change', save);
    document.getElementById('runArgs').addEventListener('input', save);
    document.getElementById('runCwd').addEventListener('input', save);

    document.getElementById('envKeyInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') addEnv();
    });
    document.getElementById('envValInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') addEnv();
    });
  </script>
</body>
</html>`;
}
