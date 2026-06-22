# Ultimate++ (U++) Integration for VSCode

Build, run, debug, and manage **Ultimate++ packages** in VSCode using the `umk` command-line tool.

> **Note:** This extension has been tested on Linux, particularly on Arch/CachyOS. Windows and macOS support still needs work.

## Requirements

- `umk` installed and on `$PATH` (ships with U++ as part of the build tools)
- [Native Debug](https://marketplace.visualstudio.com/items?itemName=webfreak.debug) extension (optional, for VS Code debugger integration)
- GDB (`sudo apt install gdb`)

## Quick Start

1. Open a workspace containing your U++ project
2. Click the **`⚙ UPP: no assembly`** item in the status bar
3. Select your assembly (loaded from `~/.config/u++/theide/*.var`)
4. Pick a package from any assembly (or the selected one)
5. Press `Ctrl+Shift+B` → **Build**
6. Press `Ctrl+Shift+Q` → **Run** or `Ctrl+Shift+D` → **Debug**

## Commands

| Command | Keybinding | Description |
|---|---|---|
| `UPP: Build Package` | `Ctrl+Shift+B` | Build the active package |
| `UPP: Build & Run Package` | `Ctrl+Shift+Q` | Build then execute the resulting binary |
| `UPP: Debug Build & Run` | `Ctrl+Shift+D` | Build with debug symbols, launch gdb |
| `UPP: Stop Running Process` | `Ctrl+Shift+X` | Send Ctrl+C to the running process |
| `UPP: Show Logs` | `Alt+L` | Open the UPP Build output channel |
| `UPP: Rebuild All (-a)` | — | Clean rebuild |
| `UPP: Select Active Assembly` | — | Pick the assembly + main package |
| `UPP: New Package` | — | Create a new package in the active assembly |
| `UPP: Open Output Directory` | — | Open the build output dir in file explorer |
| `UPP: Generate compile_commands.json` | — | Generate for all packages in dependency tree |

## Sidebar

The sidebar shows the current build state and provides quick access to all actions:

| Item | Description |
|---|---|
| **New Package** | Create a new U++ package from templates |
| **Assembly** | Current assembly name (click to change) |
| **Package** | Current package (click to browse all packages across assemblies) |
| **Description** | Package description (click to edit) |
| **Method** | Build method (GCC, CLANG, etc.) |
| **Output** | Debug or Release mode |
| **Config** | Extra compilation flags |
| **Build As** | Full build command |
| **Run / Stop** | Build and run in terminal |
| **Debug / Stop Debug** | Build with debug symbols and run |
| **Debug Cmd** | The debug build command |
| **Debug Output Dir** | Where the debug binary is built |
| **Output Dir** | Where the release binary is built |

### Package Selection

Click **Package** in the sidebar to open the package browser. Even without an assembly selected, you can search packages across all assemblies. The assembly name is shown in brackets (e.g. `Core [git-reference]`).

**Double-click an assembly** in the left panel to open its `.var` file for editing.

Click **+ New Assembly** at the bottom of the assembly list to create a new assembly.

## Settings

```json
{
  "upp.varDir": "",
  "upp.umkPath": "umk",
  "upp.buildMethod": "CLANG",
  "upp.buildFlags": "",
  "upp.extraFlags": "",
  "upp.outPath": "",
  "upp.outputDir": "",
  "upp.debuggerPath": "gdb",
  "upp.buildCommand": "",
  "upp.debugCommand": "",
  "upp.releaseCommand": "",
  "upp.restartClangdAfterGenerate": true
}
```

| Setting | Default | Description |
|---|---|---|
| `upp.varDir` | `""` | Directory containing `.var` assembly files. Defaults to `~/.config/u++/theide/` |
| `upp.umkPath` | `"umk"` | Full path to umk if not on `$PATH` |
| `upp.buildMethod` | `"CLANG"` | Build method name or path to `.bm` file |
| `upp.buildFlags` | `""` | Build flags without dash (e.g. `"bsH8"` for BLITZ+shared+18 threads) |
| `upp.extraFlags` | `""` | Compilation flags as `+FLAG,FLAG` (e.g. `"GUI,X11"`) |
| `upp.outPath` | `""` | Override output file or directory |
| `upp.workspacesDir` | `""` | Directory for `.code-workspace` files |
| `upp.outputDir` | `""` | U++ build output directory. Defaults to `~/.cache/upp.out/` |
| `upp.debuggerPath` | `"gdb"` | Path to gdb executable |
| `upp.guiMode` | `"auto"` | `"auto"`, `"gui"`, or `"console"` — controls +GUI flag |
| `upp.runArgs` | `""` | Extra arguments passed to the binary when running |
| `upp.buildCommand` | `""` | Auto-generated umk build command (editable) |
| `upp.debugCommand` | `""` | Auto-generated debug build command (strips `r` and `d` flags) |
| `upp.releaseCommand` | `""` | Auto-generated release build command (adds `r` flag) |
| `upp.compileCommandsMode` | `"off"` | `compile_commands.json`: `"off"`, `"manual"`, or `"auto"` |
| `upp.compileCommandsCommand` | `""` | Auto-generated umk command for compile_commands.json |
| `upp.outputConsole` | `"auto"` | When to open output panel: `"always"`, `"auto"`, `"never"` |
| `upp.restartClangdAfterGenerate` | `true` | Restart clangd after generating compile_commands.json |
| `upp.showWorkspaceSwitchNotification` | `true` | Show switch prompt when creating/changing workspaces |

## Debugging

### How it works

1. Click **Debug** (or `Ctrl+Shift+D`)
2. Extension builds with debug symbols (automatically strips `r` and `d` from build flags)
3. Generates `.vscode/launch.json` with correct binary path
4. Launches gdb via [Native Debug](https://marketplace.visualstudio.com/items?itemName=webfreak.debug) or [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)

Without a debug extension, opens `gdb <binary>` in the terminal for manual debugging.

### Binary path resolution

The extension searches the U++ output directory for the compiled binary:

```
~/.cache/upp.out/<assembly>/<method>.<mode>.<flags>/<package>
```

For example:
```
~/.cache/upp.out/git-reference/CLANG.Debug.Debug_Full.Gui.Shared.X11/ArrayCtrl
```

The search only looks in build output directories (names starting with `CLANG.`, `GCC.`, etc.), skipping package source directories.

### Build flags for debug

The debug command automatically strips these flags from `upp.buildFlags`:
- `r` — release mode (removes optimizations, keeps debug symbols)
- `d` — minimal debug mode (removes debug symbols)

This ensures the binary always has full debug symbols for gdb.

### Recommended Linux stack

- VS Code / VS Code OSS
- [Native Debug](https://marketplace.visualstudio.com/items?itemName=webfreak.debug) (lightweight, no Microsoft dependencies)
- GDB (`sudo apt install gdb`)

## compile_commands.json Generation

For clangd and clang-based tooling.

### Modes

| Mode | Behavior |
|---|---|
| `off` | Generation disabled (default) |
| `manual` | Generate on demand via sidebar button |
| `auto` | Watch source files, regenerate automatically (2s debounce) |

### clangd integration

After generating `compile_commands.json`, the extension automatically restarts the clangd language server (if `upp.restartClangdAfterGenerate` is `true`) so it picks up the new data immediately.

## UMK Build Flags

| Flag | Description |
|---|---|
| (none) | Debug mode with full debug symbols (default) |
| `a` | Rebuild all |
| `b` | Use BLITZ build |
| `r` | Release mode |
| `1` | Release mode, optimize for size |
| `2` | Release mode, optimize for speed |
| `s` | Use shared libraries |
| `S` | Use shared libraries and build as shared library |
| `v` | Verbose output |
| `l` | Silent mode |
| `m` | Create a map file |
| `u` | Use target directory |
| `M` | Create makefile |
| `Hn` | Number of build threads (e.g. `H8`) |
| `j` | Generate `compile_commands.json` |
| `h` | Delete UppHub folder and reinstall missing packages |
| `U` | Install missing UppHub packages and update all |

## Assembly `.var` File Format

Assembly files live in `~/.config/u++/theide/` (modern U++) or `~/.upp/theide/` (legacy):

```
UPP = "/path/to/nest1;/path/to/nest2;";
OUTPUT = "/path/to/cache/out";
```

The `UPP` key holds semicolon-separated nest directories used for include path resolution.

## Installation

```bash
cp -r upp-vscode ~/.vscode/extensions/upp-umk
cd ~/.vscode/extensions/upp-umk
npm install
npm run compile
```

To package as a `.vsix`:
```bash
npm install -g vsce
vsce package
code --install-extension upp-umk-*.vsix
```
