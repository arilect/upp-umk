# U++ Extension Help

## Where Do `.var` Files Live?

On Linux / macOS, `.var` assembly files are stored in `~/.config/u++/theide/`. The extension scans this directory automatically.

If no `.var` files exist, use the **Source Trees** panel to add source tree paths and create assemblies from there.

### Using the Extension Without `.var` Files

You can create `.var` files manually. The format is:

```
UPP = "/path/to/uppsrc";
OUTPUT = "/home/user/.cache/upp.out";
```

Or use the **Source Trees** panel to add source tree paths and create assemblies from there.

## Source Trees Panel

Open via the **Source Trees** button in the U++ sidebar.

### What Are Source Trees?

Source trees are directories containing a U++ source distribution (`uppsrc/`). Users can have multiple versions installed side by side (e.g. `~/upp-24.1/upp`, `~/upp-25.0/upp`).

**Platform differences:**

| | Windows | Linux / macOS |
|---|---|---|
| Panel title | Installations | Source Trees |
| Source Tree row in sidebar | Shown | Hidden |
| Activate button | Shown | Hidden |
| `.var` files location | Inside the installation directory | `~/.config/u++/theide/` (platform-specific) |

On **Windows**, each installation contains everything: `uppsrc/`, `umk`, and `.var` assembly files. Activating an installation switches which assemblies and `umk` binary are used.

On **Linux / macOS**, `.var` files are stored separately from installations. Source trees are reference paths useful when creating or editing `.var` files. The Activate button is not shown because switching source trees does not affect which assemblies are available.

### Panel Sections

#### Scan Paths

Directories to scan recursively for subdirectories containing `uppsrc/`. Use `~` for home directory. Each path is scanned for directories matching the optional glob pattern.

#### Source Trees

List of discovered and manually added source trees. Each entry shows:
- Path to the source tree
- Assembly count (for scanned entries)
- `[manual]` tag for user-added entries

On Windows, each entry has an **Activate** button that switches the active installation.

#### Scan for .var Files

Scan directories recursively for `.var` assembly files. This is the primary way to discover assemblies on Linux / macOS where `.var` files live outside installations.

- Add directories to scan (e.g. `~/.config/u++/theide`)
- Click **Scan for .var Files**
- Found assemblies appear with checkboxes
- Checked assemblies are **enabled** and appear in the packages table
- Uncheck an assembly to hide it from the packages table

Results persist across panel sessions. Reopening the panel re-scans using the saved directories.

### Settings

| Setting | Description |
|---|---|
| `upp.installationsPaths` | Root directories to scan for source trees (default: `["~"]`) |
| `upp.installationsGlob` | Glob pattern to filter directory names during scan |
| `upp.installationsManual` | Manually added source tree paths (preserved across scans) |
| `upp.varDir` | Override directory for `.var` files (default: platform-specific) |
| `upp.scanDirs` | Directories to scan for `.var` files |
| `upp.enabledAssemblies` | List of `.var` file paths that are enabled |
| `upp.scannedAssemblies` | All `.var` files found in the last scan |
| `upp.activeInstallation` | Path to the active source tree (Windows only) |

### Creating a New Assembly

Click **+ New Assembly** in the Select Package panel. Fill in:
- **Assembly Name** — used as the argument for `umk` (e.g. `myproject`)
- **Nest Directories** — source directories, one per line (these are the `UPP = "..."` paths in the `.var` file)
- **Output Directory** — build output location (defaults to `~/.cache/upp.out/<name>`)
- **UppHub Directory** — optional path to a UppHub clone

The `.var` file is created in the platform-specific config directory (e.g. `~/.config/u++/theide/` on Linux).

## Assemblies and Packages

### Assemblies

An assembly is defined by a `.var` file. The assembly name is the `.var` filename without extension. The `.var` file contains:

```
UPP = "/path/to/nest1;/path/to/nest2;";
OUTPUT = "/home/user/.cache/myapp.out";
_all = "0";
```

- `UPP` — semicolon-separated nest directories (source trees)
- `OUTPUT` — build output directory
- Assembly name = `.var` filename (e.g. `MyApps.var` → assembly `MyApps`)

### Packages

Packages are discovered by scanning the nest directories listed in the active assembly's `.var` file. A valid package is a directory containing a `.upp` file with the same name as the directory (e.g. `Core/Core.upp`).

### Enabled Assemblies

Only enabled assemblies appear in the packages table. Manage enabled assemblies via the checkboxes in the Source Trees panel's "Scan for .var Files" section.

When `upp.enabledAssemblies` is empty (first use), all discovered assemblies are shown.

## Build Method

The build method defines the compiler and flags. `.bm` files are stored in platform-specific directories:

- Linux: `~/.config/u++/theide/`, `~/.config/u++/umk/`
- macOS: `~/Library/Application Support/U++/theide/`
- Windows: `%APPDATA%\U++\theide\`

Select a build method via **Build Method > Select Method** in the sidebar.

## clangd Integration

### IntelliSense Files

The **Intellisense Files** button (in the sidebar) runs `umk -j` for every package in the active assembly's dependency tree. Each package directory gets its own `compile_commands.json` file.

**What it does:**
- Walks the dependency tree starting from the main package's `.upp` file
- Runs `umk <assembly> <package> <method> -j` for each package, with `cwd` set to the package directory
- Strips header-file entries (`.h`, `.hpp`, etc.) so clangd analyses headers in context rather than as isolated translation units
- Adds `compile_commands.json` to `.gitignore` in each package directory

**clangd picks up the files automatically** — it searches upward from each source file to find the nearest `compile_commands.json`. No merge into workspace root needed.

Clicking the **Intellisense Files** row in the sidebar opens the IntelliSense Settings panel, where you can configure generation mode, UMK command, restart behavior, and diagnostic suppression. The `upp.clangdSuppress` setting controls which clangd diagnostics are suppressed for U++ framework headers.

### IntelliSense Files vs c_cpp_properties.json

| | compile_commands.json | c_cpp_properties.json |
|---|---|---|
| Used by | **clangd** (language server) | VS Code's built-in IntelliSense (Microsoft C/C++ extension) |
| Generated by | `umk -j` (the Generate button) | `updateIntelliSense` (automatic on assembly/package switch) |
| Content | Full compiler invocations with all `-I`, `-D`, `-std` flags | Include paths, defines, intelliSense mode |
| Priority | **clangd ignores c_cpp_properties.json when compile_commands.json exists** | Only used when compile_commands.json is absent |

**When you see the IntelliSense notification** ("IntelliSense updated — N include paths from M nests"), those paths are written to `c_cpp_properties.json`. However, if clangd is active and `compile_commands.json` files exist, clangd uses those instead. The IntelliSense notification is informational only in that case.

### Why clangd might still show errors

1. **compile_commands.json not generated yet** — Click Generate in the sidebar
2. **Window not reloaded** — After generating, click Reload in the notification or run `Developer: Reload Window`
3. **Wrong assembly** — Ensure the active assembly's `.var` file lists the correct nest directories
4. **clangd restart conflict** — The extension shows a Reload button after generation instead of auto-restarting clangd (avoids `clangd.applyFix already exists` error)

### IntelliSense Settings Panel

Open the IntelliSense Settings panel by clicking the **Intellisense Files** row in the sidebar, or via the command palette.

**Available settings:**

| Setting | Description |
|---|---|
| Generation mode | How compile_commands.json files are generated (per-package, merged, etc.) |
| UMK command | The `umk` binary path or command used for generation |
| Restart behavior | Whether clangd is automatically restarted after generation |
| Diagnostic suppression | Which clangd diagnostics to suppress for U++ framework headers |

**Diagnostic suppression checklist:**

The `upp.clangdSuppress` setting lets you suppress specific clangd diagnostics that produce false positives on U++ framework headers. Common candidates include:
- `unused-includes` — U++ headers often pull in transitive dependencies
- `missing-includes` — framework headers resolved via build system paths
- `dangling-else` — macro-heavy code can trigger false warnings

**c_cpp_properties.json viewer/editor:**

The panel also displays the contents of the generated `c_cpp_properties.json` file, showing include paths, defines, and IntelliSense mode for reference.

## Debugging

### How It Works

1. Click **Debug** (or `Ctrl+Shift+D`)
2. Extension builds with debug symbols (strips `r` and `d` from build flags)
3. Generates `.vscode/launch.json` (auto-managed by `upp.autoLaunchJson`)
4. Launches gdb via the installed debug adapter

### Debug Adapters

Before using Debug, you must install a debug adapter. Without one, the extension shows a setup panel with install links — it will **not** fall back to raw `gdb` in a terminal.

| | Native Debug (`webfreak.debug`) | C/C++ (`ms-vscode.cpptools`) |
|---|---|---|
| **Install** | `ext install webfreak.debug` | `ext install ms-vscode.cpptools` |
| **Recommended for** | Linux / macOS | Windows |
| **GDB 17.1+** | Works (own adapter) | Known issues ([MIEngine#1607](https://github.com/microsoft/MIEngine/issues/1607)) |
| **Variable inspection** | Basic (limited child expansion) | Full (Natvis, structured data) |
| **Remote debugging** | Built-in SSH + gdbserver | Pipe transport (Docker, etc.) |
| **Weight** | Lightweight (~890K installs) | Heavy — brings IntelliSense (~30M installs) |
| **Breakpoints** | Conditional, function, attach by PID | Conditional, function, data, logpoints |
| **IntelliSense** | None (debugging only) | Full (completions, hover, go-to-definition) |

### Which to Choose

- **Linux / macOS**: Start with **Native Debug** — lightweight, reliable, no MIEngine quirks
- **Windows**: **C/C++ extension** — better Windows debugger integration
- **Both installed**: Native Debug takes priority (the extension prefers it)

> **Note:** The debugger picker may also show options like "Node.js" or "Chrome" — these are
> VS Code's generic debuggers for other languages and will not work with U++ binaries.
> Always select **"UPP: Debug"**.

### Troubleshooting

- **"Debug binary not found"** — Build the project first (`Ctrl+Shift+B`). Check `upp.outPath` if using a custom output directory.
- **"No Debug Adapter" panel** — Install Native Debug or C/C++ from the panel's buttons, then restart VS Code.
- **GDB 17.1 breaks cppdbg** — Switch to Native Debug (has its own adapter, not reliant on MIEngine), or downgrade GDB to 16.x.
- **Breakpoints not hit** — Ensure the binary was built with debug symbols (default). Check that `upp.buildFlags` does not include `r` (release) or `d` (minimal debug).

## Headless / Remote / VPS

### How It Works

The extension auto-detects headless environments (no display server) and routes program output to the VS Code integrated terminal instead of trying to open an external emulator. This works out-of-the-box on:

- **code-server** / **VS Code Server** (browser-based VS Code)
- **SSH remote development** (VS Code Remote - SSH)
- **Docker / dev containers** (VS Code Remote - Containers)
- **VPS / cloud instances** without a desktop environment

### Auto-Detection Logic

When `upp.useIntegratedTerminal` is not explicitly set, the extension checks:

1. `$DISPLAY` or `$WAYLAND_DISPLAY` set? → Desktop present → use external terminal
2. No display server + `$TERM_PROGRAM` is `vscode`, `code-server`, or `vscode-insiders`? → Headless remote → use integrated terminal

### Recommended Settings for Headless

| Setting | Recommended Value | Why |
|---|---|---|
| `upp.useIntegratedTerminal` | `true` (or leave unset for auto-detect) | External terminal emulators need a display server |
| `upp.outputConsole` | `"always"` or `"never"` | `"always"` shows output immediately; `"never"` runs silently |
| `upp.runCwd` | `""` (default) or custom path | Falls back to debug output directory if empty |
| `upp.runEnv` | Per-project needs | Environment variables (newline-separated `KEY=VALUE`) |

### Debugging on Headless

- **Native Debug recommended** — lighter, own GDB adapter, built-in SSH remote support
- No `$DISPLAY` means external terminal emulation will fail — integrated terminal is the only option
- The debug adapter panel works normally on headless — it opens in VS Code's webview

### CI / GitHub Actions

The extension does **not** auto-detect CI environments (`$CI`, `$GITHUB_ACTIONS`, etc.). If running VS Code Server in CI, set `upp.useIntegratedTerminal: true` explicitly. For pure CI pipelines without VS Code, use `umk` directly from the command line — it requires no GTK or display server.
