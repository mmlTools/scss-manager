# Change Log

All notable changes to the SCSS Manager extension.

## [1.2.0] — CSS → SCSS converter

### Added
- **CSS → SCSS converter** powered by postcss
  - New command `SCSS: Convert CSS → SCSS` (editor title bar icon, editor right-click menu, and Explorer right-click on any `.css` file — including minified `.min.css`)
  - Selector trie nesting: rules sharing a common ancestor selector collapse into nested blocks (`.card { .header { … } }`)
  - Compound selectors like `:hover`, `.foo.bar`, `[disabled]` nest with `&` references
  - `@media` / `@supports` blocks group their inner rules with full nesting
  - `@keyframes` are preserved as-is
  - Multi-selector rules (`.a, .b { … }`) are emitted as un-nested selector lists
  - Repeated literal values (hex / rgb(a) / hsl(a) colors, lengths, durations) are hoisted into top-of-file `$variables` (threshold configurable)
- New settings:
  - `scssManager.convert.outputPath` — empty / relative dir / relative `.scss` file / absolute path
  - `scssManager.convert.overwriteExisting` — skip the overwrite confirmation
  - `scssManager.convert.openAfter` — open the generated `.scss` automatically
  - `scssManager.convert.variableMinOccurrences` — threshold for variable extraction (default 3)
- `.min.css` source files get the `.min` stripped from the output filename (`foo.min.css` → `foo.scss`)

## [1.1.0] — Minifier

### Added
- **SCSS Minifier** powered by `dart-sass` (`style: 'compressed'`)
  - New command `SCSS: Minify Current File` (editor title bar icon + right-click menu)
  - Optional **auto-minify on save** (`scssManager.minify.autoOnSave`)
  - Configurable **output path** (`scssManager.minify.outputPath`) — empty = next to source, relative = workspace-relative, ends with `.css` = fixed file, otherwise treated as a directory
  - Configurable filename suffix (`scssManager.minify.suffix`, default `.min`)
  - Optional **source map** emission (`scssManager.minify.sourceMap`) — writes `<output>.css.map` and appends a `sourceMappingURL` comment
  - Master toggle `scssManager.minify.enabled`
- Toast notification shows in→out byte sizes with an **Open Output** action

### Fixed
- Scanning indicator in the sidebar now renders the animated `loading~spin` codicon instead of showing the literal `$(loading~spin)` text

## [1.0.0] — Initial release

### Added
- Activity-bar sidebar with statistics and suggestions
- Project-wide SCSS scanning via `vscode.workspace.findFiles`
- Nesting analyzer (detects rules sharing a common selector prefix)
- Variable extraction analyzer (hex, rgba/hsla, lengths, font families, z-index)
- Duplicate / near-duplicate detection with Jaccard similarity
- In-rule redundancy detection (empty rules, duplicate decls, repeated properties)
- Deterministic refactor pipeline for safe suggestions
- AI refactor pipeline via VS Code Language Model API (Copilot Chat compatible)
- Apply-all-safe command
- AI refactor for selection / entire file (right-click menu)
- Auto-scan on save (configurable)
- Settings panel with 13 configurable knobs
