# U++ Integration for VSCode

Build, run, debug, and manage **[U++](https://ultimatepp.org)** packages in VSCode using the `umk` command-line tool.

[**Install from VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=arilect.upp-umk)

> **🚧 Under Active Development**
> 
> This extension is evolving rapidly — expect the occasional rough edge as features land.
> Primary development happens on **Linux** (Arch/CachyOS). **Windows** is supported but slightly behind.
> **macOS** has not been tested yet — contributions welcome.

## What is U++?

[U++](https://ultimatepp.org) (formerly known as Ultimate++) is a C++ rapid application development framework. It uses a bundle system with `.var` files for assemblies and `.upp` files to organize packages. The `umk` tool is U++'s command-line build utility, which this extension wraps to provide a seamless VSCode experience.

### So what is U++ exactly?

Is it a software framework? Cross-platform? A GUI toolkit? A C++ enhancement? A C++ `std::` library replacement? An IDE (integrated development environment)? Or even a complete web framework? Blazingly fast? Multithreading? Really memory effective? Rapid development? Less code? Integrated icon and form layout designers? Integrated code documentation system? Subpixel graphics? Easy SQL for most databases? OpenGL? Other libraries? Much more?

The short answer is — **yes, to all of those things**.

But then the next natural question appears — why would me or someone else need this mostly unknown thing? Where is the catch? Pros and cons? Especially when there are so many established and/or promising other tools? Developers are spoilt for choice nowadays, aren't they?

Wait — have I not touched software licenses yet? How many of them have all the mentioned features? And how many of them have the very, very permissive licenses for commercial applications? The answer, my friends, is blowing in the wind... Not many.

So more choices and competition is a good thing? This is a principle of capitalism and open source. But every time someone starts and develops a new thing, he/she/they need some time to overcome doubters. For the U++ project, this "some time" is **20 years of improvements**. And I still cannot understand why U++ has not attracted as many developers as it deserves by its design ideas. Moreover, why does it attract a lot of doubting-hating-nonsense opinions when someone mentions U++ on the internet?

### Common objections

**"How do you dare create an alternative to the C++ standard library? With all kinds of containers? And say it is better, faster, and easier to use for GUI widgets? It lowers the popularity of C++!"**

You cannot believe it is not butter, as in a famous advert? This is not about replacing C++ — it is about making C++ development **faster, cleaner, and more productive**. U++ complements the standard library where it falls short, especially in GUI development, build management, and cross-platform abstraction.

**"You claim your library is faster. There are lies, damned lies, and then there are your benchmarks!"**

Yes, maybe. But maybe only `std::unordered_map` has those problems? These opinions really exist.

**"Forcing an IDE on users is a major limitation."**

What? Compare that to Microsoft Windows and Visual Studio — for years. Then came Apple and Xcode. And when someone creates an easier-to-use alternative, some start fires?

But such blame https://www.reddit.com/r/cpp/comments/juiudg/comment/gce8yuz/?utm_source=share&utm_medium=web2x&context=3 inspired me to create this extension!

## Features

- **Assembly & package management** — browse, select, and create packages across multiple U++ assemblies from a sidebar UI
- **Build & run** — build and run your U++ projects with a single click or keyboard shortcut
- **Debug** — build with debug symbols and launch gdb automatically
- **IntelliSense** — auto-generate `c_cpp_properties.json` and `compile_commands.json` for accurate code completion
- **clangd integration** — auto-generate `compile_commands.json` with watch mode, auto-restart clangd
- **IntelliSense settings panel** — configure generation mode, UMK command, clangd diagnostic suppression, and view `c_cpp_properties.json`
- **Workspace management** — automatic `.code-workspace` creation and switching per assembly
- **Configurable** — build methods, flags, link modes, output paths, and more

## Requirements

- [U++](https://github.com/ultimatepp/ultimatepp) with `umk` on `$PATH` (ships as part of the build tools)
- [Native Debug](https://marketplace.visualstudio.com/items?itemName=webfreak.debug) extension (optional, for VS Code debugger integration)
- GDB (`sudo apt install gdb`)

## Installing U++

U++ is **not** available via winget, Homebrew, or apt.

 You can download it directly from [ultimatepp.org](https://www.ultimatepp.org/www$uppweb$download$en-us.html) and install manually using instructions.

 Or, this extension will do everything all automatically for you!

### Linux

U++ sources will be installed to `~/upp-stable`. Two options are available:

**umk only** (no GTK required — works on headless VPS / servers):


After installation,the extension should auto-detect `~/upp-stable`.

### macOS

Requires Xcode Command Line Tools (`xcode-select --install`).

The install script will install Homebrew and openssl if needed.

### Windows

Download the `.7z` archive from the [download page](https://www.ultimatepp.org/www$uppweb$download$en-us.html) and extract it with [7-Zip](https://www.7-zip.org/). The `umk.exe` binary is inside the extracted directory — add it to your `$PATH`.

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
| **IntelliSense Files** | Generation mode dropdown + Generate/Regenerate button |

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
| `upp.compileCommandsMode` | `"auto"` | `"manual"` or `"auto"` — how compile_commands.json files are generated |
| `upp.generateCompileCommands` | `""` | Auto-generated umk command for compile_commands.json |
| `upp.outputConsole` | `"auto"` | When to open output panel: `"always"`, `"auto"`, `"never"` |
| `upp.restartClangdAfterGenerate` | `true` | Restart clangd after generating compile_commands.json |
| `upp.clangdSuppress` | `["ambiguous_reference", ...]` | Clangd diagnostic codes to suppress for U++ framework headers |
| `upp.autoPackageSwitchWorkspace` | `true` | Auto-switch workspace when selecting a package |

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
| `auto` | Watch source files, regenerate automatically (2s debounce) — **default** |
| `manual` | Generate on demand via sidebar button |

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

## Known Limitations

- **Linux-first** — primary development and testing on Arch/CachyOS. Windows works but may lag behind. macOS is untested.
- **U++ required** — `umk` must be installed and available on `$PATH`
- **GDB required** — debugging needs gdb installed (`sudo apt install gdb` on Debian/Ubuntu, `pacman -S gdb` on Arch)

## Development

```bash
git clone https://github.com/arilect/upp-umk.git
cd upp-umk
npm install
npm run compile
```

To watch for changes during development:

```bash
npm run watch
```

To package as a `.vsix`:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension upp-umk-*.vsix
```

## License

[MIT](LICENSE)
