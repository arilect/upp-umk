import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseMainConfigs } from './assemblyParser';
import { activeAssembly, activeMainPackage } from './state';

interface ConfigEntry {
  raw: string;
  alias: string;
}

function getConfigEntries(): { entries: ConfigEntry[]; current: string } {
  const cfg = vscode.workspace.getConfiguration('upp');
  const current: string = cfg.get('configurationFlag', '');
  const aliases: Record<string, string> = cfg.get('configAliases', {});

  let options: string[] = [];
  if (activeAssembly && activeMainPackage && activeAssembly.nests.length > 0) {
    const pkgDir = path.join(
      activeAssembly.nests.find(n =>
        fs.existsSync(path.join(n, activeMainPackage!.replace(/\//g, path.sep)))
      ) ?? activeAssembly.nests[0],
      activeMainPackage.replace(/\//g, path.sep)
    );
    const pkgLeaf = path.basename(pkgDir);
    const uppFile = path.join(pkgDir, `${pkgLeaf}.upp`);
    options = parseMainConfigs(uppFile);
  }

  // Also include the current value if not in options
  if (current && !options.includes(current)) {
    options.unshift(current);
  }

  const entries: ConfigEntry[] = options.map(opt => {
    const normalized = opt.replace(/\s+/g, ',').replace(/,+/g, ',');
    return { raw: opt, alias: aliases[normalized] || '' };
  });

  return { entries, current };
}

function saveConfigEntries(entries: ConfigEntry[], current: string) {
  const cfg = vscode.workspace.getConfiguration('upp');
  const aliases: Record<string, string> = {};
  for (const e of entries) {
    const normalized = e.raw.replace(/\s+/g, ',').replace(/,+/g, ',');
    if (e.alias) aliases[normalized] = e.alias;
  }
  cfg.update('configAliases', aliases, vscode.ConfigurationTarget.Workspace);
  cfg.update('configurationFlag', current, vscode.ConfigurationTarget.Workspace);
}

export function showConfigFlagsPanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppConfigFlags',
    'Config Flags',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const { entries, current } = getConfigEntries();
  panel.webview.html = buildHtml(entries, current);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      const newEntries: ConfigEntry[] = msg.entries;
      const newCurrent: string = msg.current;
      saveConfigEntries(newEntries, newCurrent);
      vscode.window.showInformationMessage('UPP: Config flags saved.');
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildHtml(entries: ConfigEntry[], current: string): string {
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
  .col-raw { width: 45%; }
  .col-alias { width: 40%; }
  .col-active { width: 5%; text-align: center; }
  .col-actions { width: 10%; text-align: center; }
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
  <h2>Config Flags</h2>
  <div class="hint">Manage configuration flags from your .upp file. Set aliases to show friendlier names in the sidebar. Click the radio button to set the active config.</div>

  <table>
    <thead>
      <tr>
        <th class="col-raw">Raw Flags</th>
        <th class="col-alias">Alias</th>
        <th class="col-active">Active</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="tableBody"></tbody>
  </table>

  <button class="btn-add" onclick="addRow()">+ Add Flag</button>

  <div class="buttons">
    <button class="btn-cancel" onclick="cancel()">Cancel</button>
    <button class="btn-save" onclick="save()">Save</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let entries = ${JSON.stringify(entries)};
    let current = ${JSON.stringify(current)};

    function render() {
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = '';
      entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (e.raw.replace(/\\s+/g, ',').replace(/,+/g, ',') === current) tr.className = 'active';
        tr.innerHTML =
          '<td class="col-raw"><input type="text" value="' + escapeAttr(e.raw) + '" oninput="entries[' + i + '].raw=this.value" /></td>' +
          '<td class="col-alias"><input type="text" value="' + escapeAttr(e.alias) + '" placeholder="(optional)" oninput="entries[' + i + '].alias=this.value" /></td>' +
          '<td class="col-active"><button class="btn-icon' + (tr.className === 'active' ? ' active' : '') + '" title="Set as active" onclick="setActive(' + i + ')">&#9679;</button></td>' +
          '<td class="col-actions">' +
            '<button class="btn-icon" title="Move up" onclick="moveUp(' + i + ')"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
            '<button class="btn-icon" title="Move down" onclick="moveDown(' + i + ')"' + (i === entries.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
            '<button class="btn-icon danger" title="Delete" onclick="removeRow(' + i + ')">&times;</button>' +
          '</td>';
        tbody.appendChild(tr);
      });
    }

    function escapeAttr(s) {
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function setActive(i) {
      const e = entries[i];
      current = e.raw.replace(/\\s+/g, ',').replace(/,+/g, ',');
      render();
    }

    function moveUp(i) {
      if (i <= 0) return;
      const tmp = entries[i];
      entries[i] = entries[i - 1];
      entries[i - 1] = tmp;
      render();
    }

    function moveDown(i) {
      if (i >= entries.length - 1) return;
      const tmp = entries[i];
      entries[i] = entries[i + 1];
      entries[i + 1] = tmp;
      render();
    }

    function removeRow(i) {
      if (entries[i].raw.replace(/\\s+/g, ',').replace(/,+/g, ',') === current) {
        current = '';
      }
      entries.splice(i, 1);
      render();
    }

    function addRow() {
      entries.push({ raw: '', alias: '' });
      render();
      // Focus the new raw input
      const inputs = document.querySelectorAll('#tableBody input[type="text"]');
      if (inputs.length >= 2) {
        inputs[inputs.length - 2].focus();
      }
    }

    function save() {
      // Filter out empty entries
      const filtered = entries.filter(e => e.raw.trim());
      vscode.postMessage({ type: 'save', entries: filtered, current });
    }

    function cancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    render();
  </script>
</body>
</html>`;
}
