import * as vscode from 'vscode';
import { effectiveBuildFlags } from './buildCommand';

export interface UppTaskDefinition extends vscode.TaskDefinition {
  type: 'upp';
  assembly: string;
  mainPackage: string;
  action: 'build' | 'run' | 'rebuild';
  buildFlags?: string;   // e.g. "r" for release, "br" for blitz+release
  configurationFlag?: string;   // e.g. "GUI,MT"
  outPath?: string;
}

export class UppTaskProvider implements vscode.TaskProvider {
  static readonly taskType = 'upp';

  constructor(private readonly getActiveAssembly: () => { assName: string; mainPkg: string } | undefined) {}

  provideTasks(): vscode.Task[] {
    const active = this.getActiveAssembly();
    if (!active) return [];

    const config = vscode.workspace.getConfiguration('upp');
    const umkPath: string = config.get('umkPath', 'umk');
    const buildMethod: string = config.get('buildMethod', 'CLANG');
    const buildFlags: string = config.get('buildFlags', '');
    const configurationFlag: string = config.get('configurationFlag', '');
    const outPath: string    = config.get('outPath', '');
    const useTarget: boolean = config.get('useTarget', false);

    // Effective flags: raw buildFlags with link-mode flag injected (s/S stripped)
    const effectiveFlags = effectiveBuildFlags(config);

    const actions: Array<{ action: UppTaskDefinition['action']; label: string }> = [
      { action: 'build',   label: 'Build' },
      { action: 'run',     label: 'Build & Run' },
      { action: 'rebuild', label: 'Rebuild All' },
    ];

    return actions.map(({ action, label }) => {
      const def: UppTaskDefinition = {
        type: UppTaskProvider.taskType,
        assembly: active.assName,
        mainPackage: active.mainPkg,
        action,
        buildFlags,
      };

      // Build the shell command exactly as umk expects it
      const flags = action === 'rebuild'
        ? (effectiveFlags.includes('a') ? effectiveFlags : 'a' + effectiveFlags)
        : effectiveFlags;

      const args: string[] = [
        active.assName,
        active.mainPkg,
        buildMethod,
        flags ? `-${flags}` : '',
        useTarget ? '-u' : '',
        configurationFlag ? `+${configurationFlag}` : '',
        outPath || '',
        action === 'run' ? '!' : '',
      ].filter(Boolean);

      const task = new vscode.Task(
        def,
        vscode.TaskScope.Workspace,
        `UPP: ${label}`,
        'upp',
        new vscode.ProcessExecution(umkPath, args),
        '$gcc'
      );

      task.group = (action === 'build' || action === 'rebuild') ? vscode.TaskGroup.Build : undefined;
      return task;
    });
  }

  resolveTask(task: vscode.Task): vscode.Task {
    return task;
  }
}