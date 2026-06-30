import * as vscode from 'vscode';

function getOptions(): string[] {
  const cfg = vscode.workspace.getConfiguration('upp');
  return cfg.get<string[]>('cppStandardOptions', ['c++23', 'c++20', 'c++17', 'c++14', 'c++11', 'c++98']);
}

function getCurrent(): string {
  const cfg = vscode.workspace.getConfiguration('upp');
  return cfg.get<string>('cppStandard', '');
}

function saveOptions(options: string[], current: string) {
  const cfg = vscode.workspace.getConfiguration('upp');
  cfg.update('cppStandardOptions', options, vscode.ConfigurationTarget.Workspace);
  cfg.update('cppStandard', current, vscode.ConfigurationTarget.Workspace);
}

export function showCppStandardPanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppCppStandard',
    'C++ Standard',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const options = getOptions();
  const current = getCurrent();
  panel.webview.html = buildHtml(options, current);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      saveOptions(msg.options as string[], msg.current as string);
      vscode.window.showInformationMessage('UPP: C++ standard options saved.');
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(options: string[], current: string): string {
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
  .hint { font-size: 0.8em; opacity: 0.6; margin-bottom: 12px; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  th {
    text-align: left;
    padding: 6px 8px;
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.7;
    border-bottom: 1px solid var(--vscode-widget-border);
  }
  td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-widget-border);
    vertical-align: middle;
  }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.active td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  td input[type="text"] {
    width: 100%;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  td input[type="text"]:focus {
    border-color: var(--vscode-focusBorder);
    outline: none;
  }
  .col-standard { width: 50%; }
  .col-active { width: 15%; text-align: center; }
  .col-actions { width: 15%; text-align: center; }
  .btn-icon {
    background: none; border: none; cursor: pointer;
    color: var(--vscode-foreground); font-size: 1em;
    padding: 2px 4px; opacity: 0.6; border-radius: 2px;
  }
  .btn-icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .btn-icon.danger { color: var(--vscode-errorForeground); }
  .btn-icon.danger:hover { opacity: 1; }
  .btn-icon.active { opacity: 1; color: var(--vscode-focusBorder); }
  .btn-add {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-size: 0.85em; margin-top: 8px;
  }
  .btn-add:hover { background: var(--vscode-button-hoverBackground); }
  .buttons {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 20px; padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border);
  }
  .buttons button {
    padding: 6px 20px; border: none; border-radius: 2px; cursor: pointer; font-size: 0.9em;
  }
  .btn-save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
  <h2>C++ Standard</h2>
  <div class="hint">Manage the list of C++ standards shown in the sidebar. Click the radio button to set the active standard. Leave empty to use platform default.</div>

  <table>
    <thead>
      <tr>
        <th class="col-standard">Standard</th>
        <th class="col-active">Active</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="tableBody"></tbody>
  </table>

  <button class="btn-add" onclick="addRow()">+ Add Standard</button>

  <div class="buttons">
    <button class="btn-cancel" onclick="cancel()">Cancel</button>
    <button class="btn-save" onclick="save()">Save</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let options = ${JSON.stringify(options)};
    let current = ${JSON.stringify(current)};

    function render() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      options.forEach((opt, i) => {
        const tr = document.createElement('tr');
        if (opt === current) tr.className = 'active';
        tr.innerHTML =
          '<td class="col-standard"><input type="text" value="' + escapeAttr(opt) + '" oninput="options[' + i + ']=this.value" /></td>' +
          '<td class="col-active"><button class="btn-icon' + (opt === current ? ' active' : '') + '" title="Set as active" onclick="setActive(' + i + ')">&#9679;</button></td>' +
          '<td class="col-actions">' +
            '<button class="btn-icon" title="Move up" onclick="moveUp(' + i + ')"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
            '<button class="btn-icon" title="Move down" onclick="moveDown(' + i + ')"' + (i === options.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
            '<button class="btn-icon danger" title="Delete" onclick="removeRow(' + i + ')">&times;</button>' +
          '</td>';
        tbody.appendChild(tr);
      });
    }

    function escapeAttr(s) {
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function setActive(i) {
      current = options[i];
      render();
    }

    function moveUp(i) {
      if (i <= 0) return;
      const tmp = options[i];
      options[i] = options[i - 1];
      options[i - 1] = tmp;
      render();
    }

    function moveDown(i) {
      if (i >= options.length - 1) return;
      const tmp = options[i];
      options[i] = options[i + 1];
      options[i + 1] = tmp;
      render();
    }

    function removeRow(i) {
      if (options[i] === current) current = '';
      options.splice(i, 1);
      render();
    }

    function addRow() {
      options.push('');
      render();
      const inputs = document.querySelectorAll('#tableBody input[type="text"]');
      inputs[inputs.length - 1].focus();
    }

    function save() {
      const filtered = options.filter(o => o.trim());
      vscode.postMessage({ type: 'save', options: filtered, current });
    }

    function cancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    render();
  </script>
</body>
</html>`;
}
