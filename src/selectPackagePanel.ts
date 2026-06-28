import * as vscode from 'vscode';
import * as path from 'path';
import { Assembly, findPackagesInAssembly, PackageInfo } from './assemblyParser';

export function showSelectPackagePanel(
  assemblies: Assembly[],
  currentAssemblyName: string | undefined,
  currentPackage: string | undefined,
  onSelect: (assembly: Assembly, pkgName: string, pkgDir: string, uppFile: string, description?: string) => void,
  onNewAssembly: () => void,
) {
  const panel = vscode.window.createWebviewPanel(
    'uppSelectPackage',
    'Select U++ Package',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  // Pre-collect packages for every assembly
  const assemblyData = assemblies.map(a => ({
    name: a.name,
    filePath: a.filePath,
    nests: a.nests,
    output: a.output,
    packages: findPackagesInAssembly(a).map(p => ({
      name: p.name,
      nestDir: p.nestDir,
      nestLabel: path.basename(p.nestDir),
      uppFile: p.uppFile,
      description: p.description ?? '',
      isMain: p.isMain,
    })),
  }));

  panel.webview.html = buildHtml(assemblyData, currentAssemblyName, currentPackage);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'select') {
      const asm = assemblyData.find(a => a.name === msg.assemblyName);
      const pkg = asm?.packages.find(p => p.name === msg.pkgName && p.nestDir === msg.nestDir);
      if (asm && pkg) {
        const fullAsm = assemblies.find(a => a.name === asm.name)!;
        onSelect(fullAsm, pkg.name, path.dirname(pkg.uppFile), pkg.uppFile, pkg.description || undefined);
      }
      panel.dispose();
    } else if (msg.type === 'editAssembly') {
      const asm = assemblies.find(a => a.name === msg.assemblyName);
      if (asm) {
        vscode.window.showTextDocument(vscode.Uri.file(asm.filePath));
      }
    } else if (msg.type === 'newAssembly') {
      panel.dispose();
      onNewAssembly();
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface AsmData {
  name: string;
  filePath: string;
  nests: string[];
  output: string;
  packages: { name: string; nestDir: string; nestLabel: string; uppFile: string; description: string; isMain: boolean }[];
}

function buildHtml(assemblies: AsmData[], currentAssemblyName: string | undefined, currentPackage: string | undefined): string {
  const dataJson = JSON.stringify(assemblies);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; display: flex; flex-direction: column; height: 100vh; }
  .main { display: flex; gap: 12px; flex: 1; min-height: 0; }
  .left { width: 25%; display: flex; flex-direction: column; }
  .right { width: 75%; display: flex; flex-direction: column; }
  .search { margin-bottom: 8px; }
  .search input { width: 100%; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
  .filter { margin-bottom: 8px; display: flex; gap: 4px; }
  .filter button { padding: 3px 10px; border: 1px solid var(--vscode-input-border); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); cursor: pointer; font-size: 0.85em; }
  .filter button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .list { flex: 1; overflow-y: auto; border: 1px solid var(--vscode-input-border); border-radius: 2px; }
  .asm-item { padding: 6px 8px; cursor: pointer; border-bottom: 1px solid var(--vscode-input-border); }
  .asm-item:hover { background: var(--vscode-list-hoverBackground); }
  .asm-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .asm-name { font-weight: bold; }
  .asm-path { font-size: 0.85em; opacity: 0.7; margin-top: 2px; }
  .nest-header { padding: 4px 8px; font-weight: bold; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-input-border); color: var(--vscode-sideBarSectionHeader-foreground); font-size: 0.9em; }
  .pkg-item { display: flex; align-items: center; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid var(--vscode-input-border); }
  .pkg-item:hover { background: var(--vscode-list-hoverBackground); }
  .pkg-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .pkg-name { font-weight: bold; flex: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-nest { flex: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; font-size: 0.85em; }
  .pkg-desc { flex: 3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; font-size: 0.85em; }
  .pkg-detail { padding: 8px; border: 1px solid var(--vscode-input-border); border-radius: 2px; margin-top: 8px; }
  .pkg-detail-label { font-weight: bold; margin-top: 6px; }
  .pkg-detail-value { opacity: 0.8; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .buttons button { padding: 6px 16px; border: none; border-radius: 2px; cursor: pointer; }
  .btn-select { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .empty { padding: 12px; opacity: 0.5; text-align: center; }
  .btn-new-asm { width: 100%; padding: 5px 8px; border: none; border-radius: 2px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-top: 6px; font-size: 0.9em; }
  .btn-new-asm:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <div class="main">
    <div class="left">
      <div class="search"><input type="text" id="asmSearch" placeholder="Search assemblies..." /></div>
      <div class="list" id="asmList"></div>
      <button class="btn-new-asm" id="btnNewAsm">+ New Assembly</button>
    </div>
    <div class="right">
      <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
        <div class="search" style="flex:1; margin-bottom:0;"><input type="text" id="pkgSearch" placeholder="Search packages..." /></div>
        <div class="filter" id="filter">
          <button data-filter="all">All</button>
          <button data-filter="main" class="active">Main</button>
          <button data-filter="nonmain">Non-main</button>
        </div>
      </div>
      <div class="list" id="pkgList"><div class="empty">Select an assembly</div></div>
      <div class="pkg-detail" id="pkgDetail" style="display:none"></div>
    </div>
  </div>
  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-select" id="btnSelect" disabled>Select</button>
  </div>
  <script>
    const DATA = ${dataJson};
    let selectedAsm = null;
    let selectedPkg = null;
    let currentFilter = 'main';
    const vscode = acquireVsCodeApi();

    const asmList = document.getElementById('asmList');
    const pkgList = document.getElementById('pkgList');
    const pkgDetail = document.getElementById('pkgDetail');
    const asmSearch = document.getElementById('asmSearch');
    const pkgSearch = document.getElementById('pkgSearch');
    const btnSelect = document.getElementById('btnSelect');
    const filterEl = document.getElementById('filter');

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // ── Assembly list ──
    function renderAssemblies() {
      const q = asmSearch.value.toLowerCase();
      asmList.innerHTML = DATA.filter(a => a.name.toLowerCase().includes(q) || a.filePath.toLowerCase().includes(q)).map(a =>
        '<div class="asm-item" data-name="' + esc(a.name) + '">' +
          '<div class="asm-name">' + esc(a.name) + '</div>' +
          '<div class="asm-path">' + esc(a.filePath) + '</div>' +
        '</div>'
      ).join('') || '<div class="empty">No assemblies found</div>';
    }

    function selectAsm(el) {
      document.querySelectorAll('.asm-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      selectedAsm = DATA.find(a => a.name === el.dataset.name);
      selectedPkg = null;
      btnSelect.disabled = true;
      pkgDetail.style.display = 'none';
      pkgSearch.disabled = false;
      renderPackages();
    }

    // ── Package list ──
    function renderPackages() {
      const assembliesToShow = selectedAsm ? [selectedAsm] : DATA;
      const q = pkgSearch.value.toLowerCase();
      const showAsmName = !selectedAsm;

      const nestMap = new Map();
      for (const asm of assembliesToShow) {
        for (const p of asm.packages) {
          if (currentFilter === 'main' && !p.isMain) continue;
          if (currentFilter === 'nonmain' && p.isMain) continue;
          if (q && !p.name.toLowerCase().includes(q) && !p.nestDir.toLowerCase().includes(q) && !p.nestLabel.toLowerCase().includes(q) && !asm.name.toLowerCase().includes(q)) continue;
          const key = (showAsmName ? asm.name + '/' : '') + p.nestDir;
          let list = nestMap.get(key);
          if (!list) { list = []; nestMap.set(key, list); }
          list.push({ ...p, assemblyName: asm.name });
        }
      }

      if (nestMap.size === 0) {
        pkgList.innerHTML = '<div class="empty">No packages found</div>';
        return;
      }

      let html = '';
      for (const [key, pkgs] of nestMap) {
        const asmLabel = showAsmName ? ' [' + pkgs[0].assemblyName + ']' : '';
        html += '<div class="nest-header">' + esc(pkgs[0].nestLabel) + asmLabel + '</div>';
        for (const p of pkgs) {
          const isActive = selectedPkg && selectedPkg.name === p.name && selectedPkg.nestDir === p.nestDir && selectedPkg.assemblyName === p.assemblyName;
          html += '<div class="pkg-item' + (isActive ? ' active' : '') + '" data-name="' + esc(p.name) + '" data-nest="' + esc(p.nestDir) + '" data-asm="' + esc(p.assemblyName) + '">' +
            '<div class="pkg-name">' + esc(p.name) + '</div>' +
            '<div class="pkg-nest">' + esc(p.nestLabel) + '</div>' +
            '<div class="pkg-desc">' + esc(p.description) + '</div>' +
          '</div>';
        }
      }
      pkgList.innerHTML = html;
    }

    function selectPkg(el) {
      document.querySelectorAll('.pkg-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      const asmName = el.dataset.asm;
      const asm = DATA.find(a => a.name === asmName);
      if (!asm) return;
      selectedPkg = asm.packages.find(p => p.name === el.dataset.name && p.nestDir === el.dataset.nest);
      if (selectedPkg) {
        selectedPkg.assemblyName = asmName;
        btnSelect.disabled = false;
        pkgDetail.style.display = '';
        pkgDetail.innerHTML =
          '<div class="pkg-detail-label">Package</div><div class="pkg-detail-value">' + esc(selectedPkg.name) + '</div>' +
          '<div class="pkg-detail-label">Assembly</div><div class="pkg-detail-value">' + esc(asmName) + '</div>' +
          '<div class="pkg-detail-label">Nest</div><div class="pkg-detail-value">' + esc(selectedPkg.nestDir) + '</div>' +
          '<div class="pkg-detail-label">Type</div><div class="pkg-detail-value">' + (selectedPkg.isMain ? 'Main' : 'Non-main') + '</div>' +
          '<div class="pkg-detail-label">Description</div><div class="pkg-detail-value">' + esc(selectedPkg.description || '(none)') + '</div>';
      }
    }

    // ── Events ──
    asmList.addEventListener('click', e => { const el = e.target.closest('.asm-item'); if (el) selectAsm(el); });
    asmList.addEventListener('dblclick', e => {
      const el = e.target.closest('.asm-item');
      if (el) {
        const asm = DATA.find(a => a.name === el.dataset.name);
        if (asm) {
          vscode.postMessage({ type: 'editAssembly', assemblyName: asm.name });
        }
      }
    });
    pkgList.addEventListener('click', e => { const el = e.target.closest('.pkg-item'); if (el) selectPkg(el); });
    pkgList.addEventListener('dblclick', e => {
      const el = e.target.closest('.pkg-item');
      if (el) {
        const asmName = el.dataset.asm;
        const pkg = DATA.find(a => a.name === asmName)?.packages.find(p => p.name === el.dataset.name && p.nestDir === el.dataset.nest);
        if (pkg) {
          vscode.postMessage({ type: 'select', assemblyName: asmName, pkgName: pkg.name, nestDir: pkg.nestDir });
        }
      }
    });

    asmSearch.addEventListener('input', renderAssemblies);
    pkgSearch.addEventListener('input', () => renderPackages());

    filterEl.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      filterEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderPackages();
    });

    btnSelect.addEventListener('click', () => {
      if (selectedAsm && selectedPkg) {
        vscode.postMessage({ type: 'select', assemblyName: selectedAsm.name, pkgName: selectedPkg.name, nestDir: selectedPkg.nestDir });
      }
    });

    document.getElementById('btnCancel').addEventListener('click', () => { vscode.postMessage({ type: 'cancel' }); });
    document.getElementById('btnNewAsm').addEventListener('click', () => { vscode.postMessage({ type: 'newAssembly' }); });

    // ── Init ──
    renderAssemblies();

    // Auto-select current assembly if provided
    if (${JSON.stringify(currentAssemblyName ?? '')}) {
      const el = asmList.querySelector('[data-name="${esc(currentAssemblyName ?? '')}"]');
      if (el) { selectAsm(el); el.scrollIntoView({ block: 'nearest' }); }
    } else {
      // No assembly selected — show all packages across all assemblies
      pkgSearch.focus();
      renderPackages();
    }
  </script>
</body>
</html>`;
}
