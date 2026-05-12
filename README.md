# SCSS Manager

AI-powered SCSS refactoring for VS Code. Scans your entire project, finds opportunities to nest selectors, extract repeated values into variables, consolidate near-duplicate rules, and remove redundant declarations — all visible in a dedicated sidebar with one-click apply.

## Features

| Feature | What it does |
|---|---|
| **Project-wide scan** | Indexes every `.scss` / `.sass` file in your workspace (respects glob include/exclude) |
| **Sidebar statistics** | Activity-bar icon opens a panel with files scanned, total lines, selectors, declarations, variables, mixins, and max/avg nesting depth |
| **Nesting suggestions** | Detects rules like `.card`, `.card .header`, `.card:hover` and proposes the nested equivalent |
| **Variable extraction** | Finds literal values (hex colors, lengths, font families) used N+ times and suggests extracting them — with AI-generated semantic names |
| **Duplicate consolidation** | Computes Jaccard similarity between rules; suggests `merge`, `@extend`, or `@mixin` based on how much they overlap |
| **In-rule redundancies** | Empty rules, duplicate declarations, same-property-multiple-values |
| **One-click apply** | Click any suggestion in the sidebar → details panel → "Apply" (deterministic) or "✨ Apply with AI" |
| **Apply all safe** | Single command applies every suggestion flagged as deterministic-safe in one workspace edit |
| **AI refactor** | Right-click any selection in an SCSS file → "AI Refactor Selection" sends it through the VS Code Language Model API |
| **Auto-scan on save** | Re-scans automatically when an SCSS file is saved (configurable) |
| **SCSS minifier** | Compile + compress the active SCSS/SASS file to `.min.css` with optional source map. Run on demand or automatically on save; output location is fully configurable |
| **CSS → SCSS** | Right-click any `.css` (or `.min.css`) file and convert it to nicely nested, parameterized SCSS — repeated colors / lengths / durations are auto-hoisted into `$variables` |

## Installation

### Development
```bash
git clone <this-repo>
cd scss-manager
npm install
npm run compile
```
Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### Package
```bash
npm install -g @vscode/vsce
vsce package
code --install-extension scss-manager-1.2.0.vsix
```

## How to use

1. Click the SCSS Manager icon in the activity bar (left rail).
2. Click **Scan Project** if the scan didn't auto-start.
3. Explore the panel:
   - **Project Statistics** — counts and metrics
   - **Suggestions** — collapsible categories (Nesting, Variables, Duplicates, Redundancies)
   - **Actions** — re-scan, apply all safe, AI refactor active file, settings
4. Click any suggestion → details panel opens with proposed before/after.
5. Click **Apply** for safe deterministic refactors, or **✨ Apply with AI** for ones that benefit from a language-model rewrite.

## Configuration

All settings live under `scssManager.*`:

| Setting | Default | Purpose |
|---|---|---|
| `scan.include` | `["**/*.scss", "**/*.sass"]` | Glob patterns to scan |
| `scan.exclude` | `["**/node_modules/**", "**/vendor/**", ...]` | Glob patterns to skip |
| `scan.autoScanOnSave` | `true` | Re-scan when an SCSS file is saved |
| `variables.minOccurrences` | `3` | Minimum occurrences before suggesting variable extraction |
| `variables.targetFile` | `""` | Workspace-relative file for extracted variables (empty = same file) |
| `variables.namingStrategy` | `"semantic-ai"` | `semantic-ai`, `literal`, or `hash` |
| `nesting.maxDepth` | `4` | Max nesting depth the analyzer will produce |
| `nesting.minChildren` | `2` | Min descendant rules required to trigger a nesting suggestion |
| `duplicates.minSharedDeclarations` | `3` | Min identical declarations to flag two rules as duplicates |
| `duplicates.similarityThreshold` | `0.85` | Jaccard threshold for the near-duplicate check |
| `ai.languageModel` | `"auto"` | Preferred model; `auto`, `copilot-claude`, `copilot-gpt-4o`, `copilot-gpt-4` |
| `ai.enableAutoNaming` | `true` | Use the LM to propose variable names on extraction |
| `ai.confirmBeforeApply` | `true` | Show modal preview before applying AI refactors |
| `minify.enabled` | `true` | Master switch for the minifier |
| `minify.autoOnSave` | `false` | Automatically minify SCSS/SASS files after save |
| `minify.outputPath` | `""` | Where to write minified output. Empty = next to source. Relative = resolved against the workspace folder. End with `.css` for a fixed file; otherwise treated as a directory |
| `minify.suffix` | `".min"` | Suffix appended to the base filename (e.g. `style.scss` → `style.min.css`). Ignored when `outputPath` points to a `.css` file |
| `minify.sourceMap` | `false` | Also write a `.css.map` source map next to the minified output and append a `sourceMappingURL` comment |
| `convert.outputPath` | `""` | Where to write the converted `.scss`. Empty = next to source. Relative = workspace-relative. End with `.scss` for a fixed file; otherwise treated as a directory |
| `convert.overwriteExisting` | `false` | Overwrite an existing `.scss` at the output location without prompting |
| `convert.openAfter` | `true` | Open the generated `.scss` in the editor after conversion |
| `convert.variableMinOccurrences` | `3` | Minimum repeat count before a literal value is hoisted to a `$variable` during CSS → SCSS |

## AI integration

AI features use the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model). The extension does **not** ship its own model; it requests one from any installed provider.

Currently the most reliable provider is **GitHub Copilot Chat**. If no language model is available, deterministic features still work; AI features show a one-time prompt offering to install Copilot Chat.

Models the extension will try, in order: `claude-3.5-sonnet` (Copilot), `gpt-4o` (Copilot), `gpt-4` (Copilot), any Copilot model, any provider.

## Project structure

```
scss-manager/
├── package.json
├── tsconfig.json
├── media/scss-icon.svg
├── samples/messy.scss
└── src/
    ├── extension.ts                  ← entry point
    ├── types.ts                      ← shared types
    ├── parser/
    │   ├── scssParser.ts             ← postcss-scss wrapper
    │   └── projectScanner.ts         ← workspace file scan
    ├── analyzers/
    │   ├── index.ts                  ← runs all analyzers
    │   ├── statisticsCollector.ts
    │   ├── nestingAnalyzer.ts
    │   ├── variableAnalyzer.ts
    │   ├── duplicateAnalyzer.ts
    │   └── redundancyAnalyzer.ts
    ├── refactor/
    │   ├── nestingRefactor.ts
    │   ├── variableRefactor.ts
    │   ├── duplicateRefactor.ts
    │   └── redundancyRefactor.ts
    ├── views/
    │   ├── statisticsTreeProvider.ts ← sidebar TreeView
    │   └── suggestionPanel.ts        ← detail WebView
    ├── llm/
    │   └── aiAssistant.ts            ← vscode.lm wrapper
    ├── minify/
    │   └── minifier.ts               ← dart-sass compressed compile + source map
    ├── convert/
    │   └── cssToScss.ts              ← CSS → SCSS converter (selector trie + variable extraction)
    ├── commands/index.ts
    └── utils/
        ├── editor.ts
        └── logger.ts
```

## Minifier

The **Minify Current File** action (editor title bar icon, right-click menu, or `SCSS: Minify Current File` from the command palette) compiles the active SCSS/SASS file with dart-sass in compressed mode.

Output-path resolution rules for `scssManager.minify.outputPath`:

| Value | Result |
|---|---|
| `""` (empty) | `<sourceDir>/<name>.min.css` |
| `"dist/css"` | `<workspace>/dist/css/<name>.min.css` |
| `"dist/main.css"` | `<workspace>/dist/main.css` (suffix ignored) |
| `"C:/abs/dir"` or `"/abs/dir"` | absolute directory + `<name>.min.css` |
| `"C:/abs/file.css"` | absolute file path, used as-is |

When `scssManager.minify.sourceMap` is enabled, a v3 source map is written as `<output>.css.map` and a `/*# sourceMappingURL=… */` comment is appended to the CSS.

## CSS → SCSS converter

Right-click any `.css` file (in the Explorer or in the editor) and pick **SCSS: Convert CSS → SCSS**. The converter:

- Parses the file with postcss.
- Builds a selector trie so shared ancestors collapse into nested blocks (`.card .header` becomes `.card { .header { … } }`).
- Compound suffixes (`:hover`, `.foo.bar`, `[disabled]`) are nested with `&` references.
- `@media` and `@supports` blocks group their inner rules with full nesting.
- `@keyframes` are preserved as-is.
- Multi-selector rules (`.a, .b { … }`) are emitted flat.
- Repeated colors / lengths / durations are hoisted into top-of-file `$variables` (threshold: `scssManager.convert.variableMinOccurrences`).
- Works on minified `.min.css` files; the `.min` is stripped from the output filename.

Output-path resolution for `scssManager.convert.outputPath` mirrors the minifier:

| Value | Result |
|---|---|
| `""` | `<sourceDir>/<name>.scss` |
| `"scss"` | `<workspace>/scss/<name>.scss` |
| `"src/styles/main.scss"` | `<workspace>/src/styles/main.scss` |
| `"C:/abs/file.scss"` | absolute file path, used as-is |

## Dependencies

- `postcss` + `postcss-scss` — SCSS parsing (battle-tested, real AST)
- `sass` — dart-sass for minified compilation + source maps
- `typescript` — build only

## Limitations

- Variable extraction across multiple files requires that the target file is `@use`d or `@import`ed by every consumer — the extension does **not** add imports automatically. Use the `variables.targetFile` setting and ensure your existing import chain covers it.
- `@extend` / `@mixin` consolidation for high-similarity duplicates is routed through AI rather than done deterministically, because the right transformation depends on context.
- The analyzer respects glob exclusions but doesn't currently understand `@use` namespaces — a variable defined in one file is treated as available everywhere when checking for name collisions.

## License

MIT.
