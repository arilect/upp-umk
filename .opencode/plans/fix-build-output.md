# Fix build command not showing output

## Problem
The build/rebuild action reads `showOutput` from the `upp.outputConsole` setting (default: `'auto'`).  
With `'auto'`, the "UPP Build" output channel is only shown on build failure. On success, no output is visible.

## Changes

### 1. `src/actions.ts` — Build/rebuild action (always show output)
Replace:
```typescript
const showOutput = cfg.get<'always' | 'auto' | 'never'>('outputConsole', 'auto');
```
With:
```typescript
const showBuildOutput: 'always' | 'auto' | 'never' = 'always';
```
And update the `runUmk()` call to pass `showBuildOutput`.

### 2. `src/actions.ts` — Run action variable rename
The run action currently reads `outputConsole` from settings. Rename the local variable for clarity:
```typescript
const showRunOutput = cfg.get('outputConsole', 'auto');
const openTerminal = showRunOutput !== 'never';
```

### 3. `src/extension.ts` — Debug action variable rename
The debug command handler has `showOutput: 'auto'` inline. Rename for clarity:
```typescript
showDebugOutput: 'auto',
```
(Note: `UmkOptions.showOutput` in `umkRunner.ts` stays as-is — it's the generic interface field used by all callers.)

### 4. `src/workspace.ts` — Workspace display name includes package

Add a `name` property to the `.code-workspace` JSON so VS Code shows the package name in the window title instead of just the assembly filename.

**When creating** (line ~80-83):
```typescript
const wsContent = {
    name: `${assembly.name} / ${path.basename(pkgName)}`,
    folders: folders.map(f => ({ path: f })),
    settings: buildSettings(assembly, activeMainPackage, buildParams),
};
```

**When updating an existing workspace** (line ~93-98), also update the `name`:
```typescript
const wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
wsJson.name = `${assembly.name} / ${path.basename(pkgName)}`;
wsJson.settings = buildSettings(assembly, activeMainPackage, buildParams, wsJson.settings);
fs.writeFileSync(wsPath, JSON.stringify(wsJson, null, 2), 'utf8');
```

### 5. `src/outputDir.ts` — Fix Windows binary discovery

**Problem:** `findBinaryInOutputDir()` at line 63 checks `candidate = <variantDir>/<pkgLeaf>` (without `.exe`), which fails on Windows where umk outputs the binary directly as `<variantDir>/<pkgLeaf>.exe`. It then falls through to the subdirectory check which also fails, returning `undefined`.

**Fix:** Before the `if (!fs.existsSync(candidate)) continue;`, try `candidate` with `.exe` appended.

### 6. `src/workspace.ts` — Stop creating `.code-workspace` files; save settings directly

**Core problem:** When the user selects an assembly/package, `switchWorkspace()` creates/updates a `<workspacesDir>/<assembly>.code-workspace` file and opens it. This forces the user into a workspace-file-based workflow they don't want. Without the workspace file open, build settings aren't applied.

**Fix:** Rework `switchWorkspace()` to:
- **Not create** a new `.code-workspace` file
- If a `.code-workspace` file does exist (from a previous version), update its settings but **do not switch** to it
- Persist build params (`buildMethod`, `configurationFlag`, `buildCommand`) using `cfg.update()` to `WorkspaceFolder` level (writes to `.vscode/settings.json`)

This ensures settings survive VS Code restarts without requiring a workspace file.

### 7. `src/extension.ts` — Remove automatic `workspacesDir` setup prompt

**Problem:** The initial activation prompts the user to set `workspacesDir` automatically, which triggers the workspace-file creation path that the user doesn't want.

**Fix:** Remove or neuter the setup prompt so it doesn't push users into workspace file mode.

### 8. Recompile
Run `npm run compile`.

## Files NOT changed
- `src/umkRunner.ts` — `UmkOptions.showOutput` interface field stays unchanged
- `src/runOptionsPanel.ts` — references the VS Code setting key `outputConsole`, not a variable
- `package.json` — `outputConsole` setting definition stays unchanged

## Rationale
The `.code-workspace` file mechanism was forcing users into a workspace-file workflow they don't want, and its settings weren't applied unless the workspace file was open. By saving settings directly to `.vscode/settings.json`, the extension works correctly regardless of whether a workspace file is used.

## Verification
1. Delete `~\.vscode\workspaces\examples.code-workspace` (or let the user do it)
2. Run `npm run compile` — should succeed
3. Open the U++ project folder directly (not via workspace file)
4. Select assembly "examples" and package "AddressBook" via UPP UI
5. Check `.vscode/settings.json` — should contain `upp.buildMethod`, `upp.configurationFlag`, etc.
6. Run "UPP: Build Package" — output channel should appear with correct command including `+GUI` and build method
7. Run "UPP: Build & Run" — run behavior unchanged
8. Run "UPP: Debug" — debug behavior unchanged
