import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveCppStandard } from './utils';

const DEFAULT_SUPPRESS = [
  'ambiguous_reference',
  'ovl_ambiguous_call',
  'access',
  'access_field_ctor',
  'undeclared_var_use_suggest',
  'unknown_type_leading_errors',
];

export function showIntellisensePanel() {
  const panel = vscode.window.createWebviewPanel(
    'uppIntellisense',
    'IntelliSense Settings',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = buildHtml(panel);

  panel.webview.onDidReceiveMessage(async (msg) => {
    const cfg = vscode.workspace.getConfiguration('upp');

    if (msg.type === 'save') {
      if (msg.generateCompileCommands !== undefined) {
        await cfg.update('generateCompileCommands', msg.generateCompileCommands, vscode.ConfigurationTarget.Workspace);
      }
      if (msg.restartClangdAfterGenerate !== undefined) {
        await cfg.update('restartClangdAfterGenerate', msg.restartClangdAfterGenerate, vscode.ConfigurationTarget.Workspace);
      }
      if (msg.clangdSuppress !== undefined) {
        await cfg.update('clangdSuppress', msg.clangdSuppress, vscode.ConfigurationTarget.Workspace);
      }
      panel.webview.html = buildHtml(panel);
      vscode.window.showInformationMessage('UPP: IntelliSense settings saved.');
    } else if (msg.type === 'openFile') {
      const uri = vscode.Uri.file(msg.path);
      await vscode.window.showTextDocument(uri);
    } else if (msg.type === 'executeCommand') {
      await vscode.commands.executeCommand(msg.command, ...(msg.args || []));
    } else if (msg.type === 'regenerate') {
      await vscode.commands.executeCommand('upp.updateIntelliSense');
      panel.webview.html = buildHtml(panel);
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(panel: vscode.WebviewPanel): string {
  const cfg = vscode.workspace.getConfiguration('upp');

  const generateCompileCommands = cfg.get<string>('generateCompileCommands', '');
  const restartClangd = cfg.get<boolean>('restartClangdAfterGenerate', false);
  const clangdSuppress = cfg.get<string[]>('clangdSuppress', DEFAULT_SUPPRESS);

  const buildMethod = cfg.get<string>('buildMethod', '');
  const varDir = cfg.get<string>('varDir', '');
  const cppStandard = resolveCppStandard(buildMethod, varDir, cfg);

  const extensionPath = vscode.extensions.getExtension('arilect.upp-umk')?.extensionPath || '';
  const cssPath = path.join(extensionPath, 'media', 'upp-panel.css');
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.file(cssPath));

  const ccppPath = path.join(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
    '.vscode',
    'c_cpp_properties.json',
  );
  let ccppInfo = '';
  if (fs.existsSync(ccppPath)) {
    try {
      const props = JSON.parse(fs.readFileSync(ccppPath, 'utf8'));
      const uppcfg = (props.configurations || []).find(
        (c: any) => c.name === 'UPP',
      );
      if (uppcfg) {
        const includeCount = (uppcfg.includePath || []).length;
        const defines = (uppcfg.defines || []).join(', ') || '(none)';
        const std = uppcfg.cppStandard || '(not set)';
        const mode = uppcfg.intelliSenseMode || '(not set)';
        const cc = uppcfg.compileCommands || '(not linked)';
        ccppInfo = `
          <div class="info-grid">
            <div class="info-row"><span class="info-label">includePath count:</span> <span class="info-value">${includeCount}</span></div>
            <div class="info-row"><span class="info-label">defines:</span> <span class="info-value">${esc(defines)}</span></div>
            <div class="info-row"><span class="info-label">cppStandard:</span> <span class="info-value">${esc(std)}</span></div>
            <div class="info-row"><span class="info-label">intelliSenseMode:</span> <span class="info-value">${esc(mode)}</span></div>
            <div class="info-row"><span class="info-label">compileCommands:</span> <span class="info-value">${esc(cc)}</span></div>
          </div>`;
      } else {
        ccppInfo = '<div class="hint">No UPP configuration found in c_cpp_properties.json.</div>';
      }
    } catch {
      ccppInfo = '<div class="hint">Could not parse c_cpp_properties.json.</div>';
    }
  } else {
    ccppInfo = '<div class="hint">File not found. Click "Regenerate" to create it.</div>';
  }

  const allDiagnostics = DEFAULT_SUPPRESS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntelliSense Settings</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <h2>IntelliSense Settings</h2>

  <div class="section">
    <div class="section-title">UMK Command</div>
    <div class="field">
      <label for="generateCompileCommands">UMK Command</label>
      <input type="text" id="generateCompileCommands" value="${esc(generateCompileCommands)}" />
      <div class="hint">umk command used to generate compile_commands.json.</div>
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="restartClangd" ${restartClangd ? 'checked' : ''} />
      <label for="restartClangd">Restart clangd after generate</label>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Clangd Diagnostics</div>
    <div class="hint">Check diagnostics to suppress in clangd.</div>
    ${allDiagnostics.map(d => `
      <div class="checkbox-row">
        <input type="checkbox" id="diag-${d}" data-diag="${d}" ${clangdSuppress.includes(d) ? 'checked' : ''} />
        <label for="diag-${d}">${esc(d)}</label>
      </div>
    `).join('')}
  </div>

  <div class="section">
    <div class="section-title">C++ Standard</div>
    <div class="field">
      <label>Current standard:</label>
      <div class="code-block">${esc(cppStandard)}</div>
      <div class="hint">Set via sidebar or upp.cppStandard setting.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">c_cpp_properties.json</div>
    ${ccppInfo}
    <div class="btn-row">
      ${fs.existsSync(ccppPath)
        ? `<button class="btn" onclick="openFile('${esc(ccppPath)}')">Edit File</button>`
        : ''}
      <button class="btn" onclick="regenerate()">Regenerate</button>
    </div>
  </div>

  <div class="btn-row">
    <button class="btn" onclick="save()">Save</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function save() {
      const suppress = [];
      document.querySelectorAll('[data-diag]').forEach(cb => {
        if (cb.checked) suppress.push(cb.getAttribute('data-diag'));
      });
      vscode.postMessage({
        type: 'save',
        generateCompileCommands: document.getElementById('generateCompileCommands').value,
        restartClangdAfterGenerate: document.getElementById('restartClangd').checked,
        clangdSuppress: suppress,
      });
    }

    function openFile(filePath) {
      vscode.postMessage({ type: 'openFile', path: filePath });
    }

    function regenerate() {
      vscode.postMessage({ type: 'regenerate' });
    }
  </script>
</body>
</html>`;
}
