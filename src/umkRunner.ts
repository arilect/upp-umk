import * as vscode from 'vscode';
import * as cp from 'child_process';

export type UmkAction = 'build' | 'run' | 'rebuild';

export interface UmkOptions {
  umkPath: string;
  assemblyName: string;  // assembly name or comma-separated nest dirs
  mainPackage: string;   // e.g. "MyApp/Main"
  buildMethod: string;   // e.g. "GCC", "CLANG", or path to .bm file
  buildFlags?: string;   // combined flags without dash, e.g. "br" = blitz+release
  configurationFlag?: string;   // +FLAG,FLAG compilation flags, e.g. "GUI,MT"
  outPath?: string;      // override output path
  runArgs?: string[];    // arguments to pass to the binary when action === 'run'
  action: UmkAction;
  outputChannel: vscode.OutputChannel;
  showOutput?: 'always' | 'auto' | 'never';
}

/**
 * Build the umk argument list.
 *
 * Full syntax:
 *   umk assembly package [build_method] [-flags] [+FLAG,...] [out] [! [runarg]..]
 *
 * -r  = release mode (NOT "run")
 * -a  = rebuild all (closest thing to "clean")
 * !   = execute binary after successful build (positional, after out)
 *
 * Examples:
 *   umk myapp MyApp/Main GCC              # debug build (default)
 *   umk myapp MyApp/Main GCC -r           # release build
 *   umk myapp MyApp/Main GCC -br          # blitz + release
 *   umk myapp MyApp/Main GCC -r ! arg1    # release build then run with arg1
 *   umk myapp MyApp/Main GCC -a           # rebuild all
 */
function buildArgs(opts: UmkOptions): string[] {
  const args: string[] = [opts.assemblyName, opts.mainPackage];

  if (opts.buildMethod?.trim()) {
    args.push(opts.buildMethod.trim());
  }

  // Combine action-specific flags with user-supplied flags into one -xyz token
  let flags = opts.buildFlags?.trim() ?? '';
  if (opts.action === 'rebuild') {
    flags = flags.includes('a') ? flags : 'a' + flags;
  }
  if (flags) {
    args.push(`-${flags}`);
  }

  if (opts.configurationFlag?.trim()) {
    args.push(`+${opts.configurationFlag.trim()}`);
  }

  if (opts.outPath?.trim()) {
    args.push(opts.outPath.trim());
  }

  // ! must come after out, then optional run arguments
  if (opts.action === 'run') {
    args.push('!');
    if (opts.runArgs?.length) {
      args.push(...opts.runArgs);
    }
  }

  return args;
}

export function runUmk(opts: UmkOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(opts);
    const displayCmd = `${opts.umkPath} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;

    const show = opts.showOutput ?? 'always';
    if (show === 'always') {
      opts.outputChannel.show(true);
    }
    opts.outputChannel.appendLine('');
    opts.outputChannel.appendLine(`► ${displayCmd}`);
    opts.outputChannel.appendLine('─'.repeat(72));

    let settled = false;

    const proc = cp.spawn(opts.umkPath, args, {
      env: process.env,
      shell: false,
    });

    proc.stdout.on('data', (data: Buffer) => opts.outputChannel.append(data.toString()));
    proc.stderr.on('data', (data: Buffer) => opts.outputChannel.append(data.toString()));

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        opts.outputChannel.appendLine(`\n✓ Done (exit 0)`);
        resolve();
      } else {
        opts.outputChannel.appendLine(`\n✗ Failed (exit ${code})`);
        if (show === 'auto') { opts.outputChannel.show(true); }
        reject(new Error(`umk exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      opts.outputChannel.appendLine(`✗ Could not start umk: ${err.message}`);
      opts.outputChannel.appendLine('  Check the "upp.umkPath" setting.');
      if (show === 'auto') { opts.outputChannel.show(true); }
      reject(err);
    });
  });
}