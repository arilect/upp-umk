import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Assembly } from './assemblyParser';
import {
  UppHubNest, UppHubCatalog, fetchCatalog,
  getHubDir, isInstalled, getInstalledNests,
  uninstallNest, updateNest, updateAll,
  installWithDeps, syncAssemblyUpHub, ensureHubDir,
} from './uppHub';

let currentPanel: vscode.WebviewPanel | undefined;
let catalog: UppHubCatalog | undefined;

export function showUppHubPanel(assembly?: Assembly) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    if (assembly) currentPanel.webview.postMessage({ type: 'setAssembly', assembly: serializeAssembly(assembly) });
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'uppHub',
    'UppHub',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
  );

  currentPanel.webview.html = buildLoadingHtml();
  currentPanel.onDidDispose(() => { currentPanel = undefined; catalog = undefined; });

  const outputChannel = vscode.window.createOutputChannel('UppHub');
  loadAndSendCatalog(currentPanel, assembly, outputChannel);

  currentPanel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'install': {
        const nest = msg.nest as UppHubNest;
        const hubDir = msg.hubDir as string;
        ensureHubDir(hubDir);
        try {
          await installWithDeps(nest, catalog!, hubDir, outputChannel);
          if (assembly) syncAssemblyUpHub(assembly, hubDir);
          refreshPanel(currentPanel!, assembly, outputChannel);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP: Install failed: ${err.message}`);
        }
        break;
      }
      case 'uninstall': {
        const name = msg.name as string;
        const hubDir = msg.hubDir as string;
        try {
          await uninstallNest(hubDir, name, outputChannel);
          if (assembly) syncAssemblyUpHub(assembly, hubDir);
          refreshPanel(currentPanel!, assembly, outputChannel);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP: Uninstall failed: ${err.message}`);
        }
        break;
      }
      case 'update': {
        const name = msg.name as string;
        const hubDir = msg.hubDir as string;
        try {
          await updateNest(hubDir, name, outputChannel);
          refreshPanel(currentPanel!, assembly, outputChannel);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP: Update failed: ${err.message}`);
        }
        break;
      }
      case 'updateAll': {
        const hubDir = msg.hubDir as string;
        try {
          await updateAll(hubDir, outputChannel);
          refreshPanel(currentPanel!, assembly, outputChannel);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP: Update all failed: ${err.message}`);
        }
        break;
      }
      case 'installAll': {
        const hubDir = msg.hubDir as string;
        const names = msg.names as string[];
        ensureHubDir(hubDir);
        try {
          for (const name of names) {
            const nest = catalog!.nests.find(n => n.name === name);
            if (nest && !isInstalled(hubDir, name)) {
              await installWithDeps(nest, catalog!, hubDir, outputChannel);
            }
          }
          if (assembly) syncAssemblyUpHub(assembly, hubDir);
          refreshPanel(currentPanel!, assembly, outputChannel);
        } catch (err: any) {
          vscode.window.showErrorMessage(`UPP: Install all failed: ${err.message}`);
        }
        break;
      }
      case 'openUrl': {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      }
      case 'setHubDir': {
        const newDir = msg.hubDir as string;
        if (assembly && newDir) {
          syncAssemblyUpHub(assembly, newDir);
        }
        refreshPanel(currentPanel!, assembly, outputChannel);
        break;
      }
      case 'loadCatalog': {
        await loadAndSendCatalog(currentPanel!, assembly, outputChannel);
        break;
      }
    }
  });
}

async function loadAndSendCatalog(panel: vscode.WebviewPanel, assembly?: Assembly, outputChannel?: vscode.OutputChannel) {
  try {
    catalog = await fetchCatalog();
    const hubDir = getHubDir(assembly);
    const installed = hubDir ? getInstalledNests(hubDir) : [];
    panel.webview.postMessage({
      type: 'catalog',
      nests: catalog.nests,
      installed,
      hubDir: hubDir || '',
      assembly: serializeAssembly(assembly),
    });
  } catch (err: any) {
    panel.webview.html = buildErrorHtml(err.message);
  }
}

async function refreshPanel(panel: vscode.WebviewPanel, assembly?: Assembly, outputChannel?: vscode.OutputChannel) {
  if (catalog) {
    const hubDir = getHubDir(assembly);
    const installed = hubDir ? getInstalledNests(hubDir) : [];
    panel.webview.postMessage({
      type: 'catalog',
      nests: catalog.nests,
      installed,
      hubDir: hubDir || '',
      assembly: serializeAssembly(assembly),
    });
  }
}

function serializeAssembly(assembly?: Assembly) {
  if (!assembly) return undefined;
  return { name: assembly.name, filePath: assembly.filePath, uppHub: assembly.uppHub };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildLoadingHtml(): string {
  const extPath = vscode.extensions.getExtension('arilect.upp-umk')?.extensionPath;
  if (extPath) {
    const htmlPath = path.join(extPath, 'media', 'uppHub.html');
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf8');
    }
  }
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:40px;text-align:center;}
</style></head><body><h2>Loading UppHub catalog...</h2></body></html>`;
}

function buildErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:40px;}
.error{color:var(--vscode-errorForeground);margin-bottom:12px;}
button{padding:6px 16px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;border-radius:2px;}
</style></head><body>
<div class="error">Failed to load UppHub catalog</div>
<pre>${esc(message)}</pre>
<br><button onclick="acquireVsCodeApi().postMessage({type:'loadCatalog'})">Retry</button>
</body></html>`;
}
