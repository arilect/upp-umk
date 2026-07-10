import * as vscode from 'vscode';

let panelShown = false;

export function showDebugAdapterPanel(): void {
  if (panelShown) return;
  panelShown = true;

  const panel = vscode.window.createWebviewPanel(
    'uppDebugAdapter',
    'UPP: Debug Adapter Required',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = `<!DOCTYPE html><html><head><style>
    body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:20px;line-height:1.6;}
    h2{color:#f44;margin-bottom:8px;}
    p{margin:8px 0;}
    code{background:var(--vscode-input-background);padding:2px 6px;border-radius:3px;font-size:0.9em;}
    button{padding:8px 20px;border:none;border-radius:4px;cursor:pointer;font-size:0.95em;margin:4px 4px 4px 0;}
    .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
    .btn-primary:hover{background:var(--vscode-button-hoverBackground);}
    .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
    .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground);}
    .hint{font-size:0.85em;opacity:0.6;margin-top:12px;}
    .note{background:var(--vscode-input-background);padding:10px 14px;border-radius:4px;margin:12px 0;border-left:3px solid var(--vscode-textLink-foreground);}
    .card{background:var(--vscode-input-background);border-radius:6px;padding:14px 16px;margin:10px 0;border:1px solid var(--vscode-widget-border);}
    .card h3{margin:0 0 6px 0;font-size:1em;}
    .card p{margin:4px 0 8px 0;font-size:0.9em;opacity:0.8;}
    .tag{display:inline-block;font-size:0.75em;padding:2px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);margin-left:6px;}
  </style></head><body>
    <h2>No Debug Adapter Installed</h2>
    <p>To debug U++ programs with breakpoints and stepping in VS Code, install one of the supported debug adapters:</p>

    <div class="card">
      <h3>Native Debug <span class="tag">Recommended for Linux/macOS</span></h3>
      <p>Lightweight GDB/LLDB adapter. No Microsoft dependencies. Built-in SSH remote support.</p>
      <button class="btn-primary" id="btnInstallNative">Install Native Debug</button>
    </div>

    <div class="card">
      <h3>C/C++ <span class="tag">Recommended for Windows</span></h3>
      <p>Microsoft's full C++ tooling. IntelliSense, NatVis visualizers, richer variable inspection.</p>
      <button class="btn-primary" id="btnInstallCpp">Install C/C++</button>
    </div>

    <div class="note">
      <strong>Why is this needed?</strong> VS Code's debugger picker shows generic options (Node.js, Chrome, etc.)
      that cannot run C++ binaries. Only a C/C++ debug adapter can provide breakpoints, stepping, and variable inspection.
    </div>

    <br/>
    <button class="btn-secondary" id="btnSettings">Open UPP Settings</button>
    <button class="btn-secondary" id="btnDismiss">Dismiss</button>
    <div id="status" class="hint"></div>

    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById('btnInstallNative').addEventListener('click', () => {
        vscode.postMessage({ type: 'install', extensionId: 'webfreak.debug' });
        document.getElementById('status').textContent = 'Installing Native Debug...';
      });
      document.getElementById('btnInstallCpp').addEventListener('click', () => {
        vscode.postMessage({ type: 'install', extensionId: 'ms-vscode.cpptools' });
        document.getElementById('status').textContent = 'Installing C/C++...';
      });
      document.getElementById('btnSettings').addEventListener('click', () => {
        vscode.postMessage({ type: 'settings' });
      });
      document.getElementById('btnDismiss').addEventListener('click', () => {
        vscode.postMessage({ type: 'dismiss' });
      });
    </script>
  </body></html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'install') {
      vscode.commands.executeCommand('extension.install', msg.extensionId);
      panel.webview.postMessage({ type: 'status', text: `Installing ${msg.extensionId}... Restart VS Code after installation.` });
    } else if (msg.type === 'settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:arilect.upp-umk');
    } else if (msg.type === 'dismiss') {
      panel.dispose();
    }
  });

  panel.onDidDispose(() => { panelShown = false; });
}

export function resetPanelFlag(): void {
  panelShown = false;
}
