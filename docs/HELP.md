# U++ Extension Help

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

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+B` | Build |
| `Ctrl+Shift+Q` | Run |
| `Ctrl+Shift+D` | Debug |
| `Ctrl+Shift+X` | Stop |
| `Alt+L` | Show Logs |

## clangd Integration

### compile_commands.json

The **Generate** button (Compile Commands row in the sidebar) runs `umk -j` for every package in the active assembly's dependency tree. Each package directory gets its own `compile_commands.json` file.

**What it does:**
- Walks the dependency tree starting from the main package's `.upp` file
- Runs `umk <assembly> <package> <method> -j` for each package, with `cwd` set to the package directory
- Strips header-file entries (`.h`, `.hpp`, etc.) so clangd analyses headers in context rather than as isolated translation units
- Adds `compile_commands.json` to `.gitignore` in each package directory

**clangd picks up the files automatically** — it searches upward from each source file to find the nearest `compile_commands.json`. No merge into workspace root needed.

### compile_commands.json vs c_cpp_properties.json

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
