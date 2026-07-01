import * as vscode from 'vscode';
import { resolveUmkPath } from './utils';
import { activeAssembly, activeMainPackage, activeInstallation } from './state';

export function showBuildEditPanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppBuildEdit',
    'Build Options',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const cfg = vscode.workspace.getConfiguration('upp');
  panel.webview.html = buildHtml(cfg);

  panel.webview.onDidReceiveMessage(async (msg) => {
    const cfg = vscode.workspace.getConfiguration('upp');
    if (msg.type === 'save') {
      if (msg.buildCommand !== undefined) {
        await cfg.update('buildCommand', msg.buildCommand, vscode.ConfigurationTarget.Workspace);
      }
      if (msg.stopOnErrors !== undefined) {
        await cfg.update('stopOnErrors', msg.stopOnErrors, vscode.ConfigurationTarget.Workspace);
      }
      vscode.commands.executeCommand('upp.syncAndRefresh');
      vscode.window.showInformationMessage('UPP: Build options saved.');
    } else if (msg.type === 'refresh') {
      panel.webview.html = buildHtml(vscode.workspace.getConfiguration('upp'));
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(cfg: vscode.WorkspaceConfiguration): string {
  const buildCmd = cfg.get<string>('buildCommand', '');
  const stopOnErrors = cfg.get<boolean>('stopOnErrors');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Build Options</title>
  <style>
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 16px;
      margin: 0;
    }
    h2 {
      font-size: 16px;
      margin: 0 0 16px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-widget-border, #444);
    }
    .field {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-weight: 500;
      margin-bottom: 4px;
      color: var(--vscode-foreground, #ccc);
    }
    input[type="text"], textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 2px;
      outline: none;
    }
    input[type="text"]:focus, textarea:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    textarea {
      resize: vertical;
      min-height: 60px;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
      margin-top: 4px;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
    }
    .checkbox-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
    }
    .checkbox-row label {
      margin: 0;
      cursor: pointer;
    }
    .btn-row {
      display: flex;
      gap: 8px;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-widget-border, #444);
    }
    .btn {
      padding: 6px 16px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e639c);
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .section {
      margin-bottom: 20px;
    }
    .section-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground, #999);
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <h2>Build Options</h2>

  <div class="section">
    <div class="section-title">Build Command</div>
    <div class="field">
      <label for="buildCommand">Command line</label>
      <textarea id="buildCommand" rows="2">${esc(buildCmd)}</textarea>
      <div class="hint">Full umk command. Edit to override the auto-generated command.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Behavior</div>
    <div class="checkbox-row">
      <input type="checkbox" id="stopOnErrors" ${stopOnErrors ? 'checked' : ''} />
      <label for="stopOnErrors">Stop on errors</label>
    </div>
    <div class="hint">When enabled, halt the build immediately on the first error.</div>
  </div>

  <div class="btn-row">
    <button class="btn" onclick="save()">Save</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function save() {
      vscode.postMessage({
        type: 'save',
        buildCommand: document.getElementById('buildCommand').value,
        stopOnErrors: document.getElementById('stopOnErrors').checked,
      });
    }
  </script>
</body>
</html>`;
}
