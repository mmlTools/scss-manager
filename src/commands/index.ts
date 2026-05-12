import * as vscode from 'vscode';
import * as path from 'path';
import { runAllAnalyzers } from '../analyzers';
import { scanProject } from '../parser/projectScanner';
import { Suggestion } from '../types';
import { StatisticsTreeProvider } from '../views/statisticsTreeProvider';
import { showSuggestionPanel } from '../views/suggestionPanel';
import { applyNestingRefactor } from '../refactor/nestingRefactor';
import { applyVariableRefactor } from '../refactor/variableRefactor';
import { applyDuplicateRefactor } from '../refactor/duplicateRefactor';
import { applyRedundancyRefactor } from '../refactor/redundancyRefactor';
import { refactorSnippet } from '../llm/aiAssistant';
import { minifyDocument, formatBytes } from '../minify/minifier';
import { convertCssToScss } from '../convert/cssToScss';
import * as fs from 'fs/promises';
import { logger } from '../utils/logger';

export function registerCommands(
  context: vscode.ExtensionContext,
  treeProvider: StatisticsTreeProvider,
): void {
  /* ─── scan ──────────────────────────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.scanProject', async () => {
      await runScan(treeProvider);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.refreshStatistics', () => {
      treeProvider.refresh();
    }),
  );

  /* ─── apply / show ─────────────────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.showSuggestionDetails', async (id: string | { id: string }) => {
      const sid = typeof id === 'string' ? id : id?.id;
      const s = treeProvider.findSuggestion(sid);
      if (!s) {
        vscode.window.showWarningMessage('SCSS Manager: suggestion not found (re-scan to refresh).');
        return;
      }
      showSuggestionPanel(context, s, {
        onApply: async (sid2) => {
          const fresh = treeProvider.findSuggestion(sid2);
          if (fresh) await applySingleSuggestion(fresh, { useAi: false });
        },
        onAiRefactor: async (sid2) => {
          const fresh = treeProvider.findSuggestion(sid2);
          if (fresh) await applySingleSuggestion(fresh, { useAi: true });
        },
        onReveal: async (filePath, line, col) => {
          await revealLocation(filePath, line, col);
        },
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.applySuggestion', async (arg) => {
      // Accept either a TreeNode (when invoked from the view item context
      // menu) or a raw id (programmatic).
      let id: string | undefined;
      if (typeof arg === 'string') id = arg;
      else if (arg && typeof arg === 'object' && 'suggestion' in arg) id = (arg as { suggestion: Suggestion }).suggestion.id;
      else if (arg && typeof arg === 'object' && 'id' in arg) id = (arg as { id: string }).id;
      if (!id) return;

      const s = treeProvider.findSuggestion(id);
      if (!s) return;
      const ok = await applySingleSuggestion(s, { useAi: !s.safeAutoApply });
      if (ok) {
        // Re-scan so the suggestion list updates.
        await runScan(treeProvider);
      }
    }),
  );

  /* ─── apply all safe ─────────────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.applyAllSafe', async () => {
      const result = treeProvider.getResult();
      if (!result) {
        vscode.window.showInformationMessage('SCSS Manager: run a scan first.');
        return;
      }
      const safe = result.suggestions.filter((s) => s.safeAutoApply);
      if (safe.length === 0) {
        vscode.window.showInformationMessage('SCSS Manager: nothing safe to apply.');
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `Apply ${safe.length} safe fix${safe.length === 1 ? '' : 'es'}?`,
        { modal: true },
        'Apply All',
        'Cancel',
      );
      if (choice !== 'Apply All') return;

      // Sort by offset descending within each file so earlier edits don't
      // shift offsets of later ones.
      const byFile = new Map<string, Suggestion[]>();
      for (const s of safe) {
        if (!byFile.has(s.filePath)) byFile.set(s.filePath, []);
        byFile.get(s.filePath)!.push(s);
      }
      for (const list of byFile.values()) {
        list.sort((a, b) => b.locations[0].range.start.offset - a.locations[0].range.start.offset);
      }

      let applied = 0;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Applying safe fixes', cancellable: false },
        async (progress) => {
          let i = 0;
          const all = [...safe];
          for (const s of all) {
            i++;
            progress.report({ message: `${i}/${all.length} — ${s.title}`, increment: 100 / all.length });
            try {
              const ok = await applySingleSuggestion(s, { useAi: false, suppressConfirm: true });
              if (ok) applied++;
            } catch (e) {
              logger.error(`applyAll failed for ${s.id}`, e);
            }
          }
        },
      );
      vscode.window.showInformationMessage(`SCSS Manager: applied ${applied}/${safe.length} safe fix${safe.length === 1 ? '' : 'es'}.`);
      await runScan(treeProvider);
    }),
  );

  /* ─── AI refactor selection / file ──────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.aiRefactorSelection', async () => {
      await aiRefactor('selection');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.aiRefactorFile', async () => {
      await aiRefactor('file');
    }),
  );

  /* ─── reveal / nav ────────────────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.revealLocation', async (filePath: string, line: number, col: number) => {
      await revealLocation(filePath, line, col);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:MMLTECH.scss-manager');
    }),
  );

  /* ─── minify ──────────────────────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.minifyFile', async (arg?: vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage('SCSS Manager: open an SCSS file first.');
        return;
      }
      const lang = (await vscode.workspace.openTextDocument(uri)).languageId;
      if (lang !== 'scss' && lang !== 'sass') {
        vscode.window.showInformationMessage('SCSS Manager: not an SCSS/SASS file.');
        return;
      }
      try {
        const result = await minifyDocument(uri);
        if (!result) {
          vscode.window.showInformationMessage('SCSS Manager: minify is disabled in settings.');
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `SCSS Manager: minified → ${path.basename(result.outputPath)} ` +
            `(${formatBytes(result.bytesIn)} → ${formatBytes(result.bytesOut)})${result.mapPath ? ' + map' : ''}`,
          'Open Output',
        );
        if (choice === 'Open Output') {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.outputPath));
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      } catch (e) {
        vscode.window.showErrorMessage(`SCSS Manager: minify failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  /* ─── CSS → SCSS conversion ──────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.convertCssToScss', async (arg?: vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage('SCSS Manager: open or right-click a .css file.');
        return;
      }
      if (!uri.fsPath.toLowerCase().endsWith('.css')) {
        vscode.window.showInformationMessage('SCSS Manager: not a .css file.');
        return;
      }
      try {
        const cssBytes = await fs.readFile(uri.fsPath, 'utf8');
        const cfg = vscode.workspace.getConfiguration('scssManager');
        const result = convertCssToScss(cssBytes, {
          variableMinOccurrences: cfg.get<number>('convert.variableMinOccurrences', 3),
        });

        const outPath = resolveConvertOutputPath(
          uri.fsPath,
          cfg.get<string>('convert.outputPath', ''),
        );

        // Overwrite confirmation.
        const overwrite = cfg.get<boolean>('convert.overwriteExisting', false);
        if (!overwrite) {
          try {
            await fs.access(outPath);
            const choice = await vscode.window.showWarningMessage(
              `SCSS Manager: ${path.basename(outPath)} already exists. Overwrite?`,
              { modal: true },
              'Overwrite',
              'Cancel',
            );
            if (choice !== 'Overwrite') return;
          } catch {
            /* file does not exist — fine */
          }
        }

        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, result.scss, 'utf8');

        const openAfter = cfg.get<boolean>('convert.openAfter', true);
        const msg =
          `SCSS Manager: converted → ${path.basename(outPath)} ` +
          `(${result.topLevelRuleCount} top-level rules, ${result.variableCount} variable${result.variableCount === 1 ? '' : 's'})`;

        if (openAfter) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
          await vscode.window.showTextDocument(doc, { preview: false });
          vscode.window.showInformationMessage(msg);
        } else {
          const choice = await vscode.window.showInformationMessage(msg, 'Open');
          if (choice === 'Open') {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
            await vscode.window.showTextDocument(doc, { preview: false });
          }
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `SCSS Manager: CSS → SCSS failed — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),
  );

  /* ─── inline editor commands ──────────────────────────────────────── */
  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.extractVariable', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        vscode.window.showInformationMessage('Select a value first.');
        return;
      }
      const value = ed.document.getText(ed.selection).trim();
      const name = await vscode.window.showInputBox({
        prompt: `Variable name for "${value}"`,
        value: '$',
        validateInput: (v) => (v.startsWith('$') && v.length > 1 ? null : 'Must start with $'),
      });
      if (!name) return;

      const we = new vscode.WorkspaceEdit();
      we.insert(ed.document.uri, new vscode.Position(0, 0), `${name}: ${value};\n`);
      // Replace every occurrence of the value in the active file.
      const fullText = ed.document.getText();
      let idx = 0;
      while ((idx = fullText.indexOf(value, idx)) !== -1) {
        we.replace(
          ed.document.uri,
          new vscode.Range(ed.document.positionAt(idx), ed.document.positionAt(idx + value.length)),
          name,
        );
        idx += value.length;
      }
      await vscode.workspace.applyEdit(we);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('scssManager.nestSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        vscode.window.showInformationMessage('Select the rules to nest.');
        return;
      }
      const cts = new vscode.CancellationTokenSource();
      try {
        const text = ed.document.getText(ed.selection);
        const refactored = await refactorSnippet(text, 'collapse repeated parent selectors into nested rules', cts.token);
        if (!refactored) return;

        const cfg = vscode.workspace.getConfiguration('scssManager');
        if (cfg.get<boolean>('ai.confirmBeforeApply', true)) {
          const choice = await vscode.window.showInformationMessage(
            'Apply AI nesting refactor?',
            { modal: true, detail: refactored.slice(0, 800) + (refactored.length > 800 ? '\n…' : '') },
            'Apply',
            'Cancel',
          );
          if (choice !== 'Apply') return;
        }
        await ed.edit((eb) => eb.replace(ed.selection, refactored));
      } finally {
        cts.dispose();
      }
    }),
  );
}

/* ─── helpers ────────────────────────────────────────────────────────── */

export async function runScan(treeProvider: StatisticsTreeProvider): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('scssManager');
  const include = cfg.get<string[]>('scan.include', ['**/*.scss', '**/*.sass']);
  const exclude = cfg.get<string[]>('scan.exclude', ['**/node_modules/**']);

  treeProvider.setScanning(true);
  try {
    await vscode.window.withProgress(
      { location: { viewId: 'scssManager.statisticsView' }, title: 'SCSS scan', cancellable: true },
      async (progress, token) => {
        const start = Date.now();
        const asts = await scanProject(
          { include, exclude },
          (p) => {
            progress.report({
              message: `${p.scanned}/${p.total}`,
              increment: 100 / Math.max(1, p.total),
            });
          },
          token,
        );
        const result = runAllAnalyzers(asts, Date.now() - start);
        treeProvider.setResult(result);
        logger.info(
          `Scanned ${result.statistics.filesScanned} files in ${result.statistics.scanDurationMs}ms — ${result.suggestions.length} suggestions`,
        );
      },
    );
  } catch (e) {
    logger.error('runScan failed', e);
    vscode.window.showErrorMessage(`SCSS Manager: scan failed (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    treeProvider.setScanning(false);
  }
}

async function applySingleSuggestion(
  s: Suggestion,
  options: { useAi: boolean; suppressConfirm?: boolean },
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('scssManager');
  const confirmDefault = cfg.get<boolean>('ai.confirmBeforeApply', true);
  const confirm = options.suppressConfirm ? false : confirmDefault;

  if (options.useAi) {
    return applyViaAi(s, confirm);
  }

  switch (s.kind) {
    case 'nesting':
      return applyNestingRefactor(s, { confirm });
    case 'variable':
      return applyVariableRefactor(s, {
        confirm,
        useAiNaming: cfg.get<boolean>('ai.enableAutoNaming', true),
      });
    case 'duplicate':
      return applyDuplicateRefactor(s, { confirm });
    case 'redundancy':
      return applyRedundancyRefactor(s, { confirm });
    default:
      return false;
  }
}

async function applyViaAi(s: Suggestion, confirm: boolean): Promise<boolean> {
  // Pull the affected range's text, ask the model to refactor with the
  // suggestion as context, then replace.
  const loc = s.locations[0];
  if (!loc) return false;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.filePath));

  // For variable extraction across multiple files, AI-driven mode would have
  // to operate cross-file. We keep it scoped to the first file's full text
  // here for safety. The deterministic path already handles cross-file.
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    doc.positionAt(doc.getText().length),
  );

  const cts = new vscode.CancellationTokenSource();
  try {
    const refactored = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `AI refactor: ${s.title}`, cancellable: true },
      async (_, token) => {
        const linked = new vscode.CancellationTokenSource();
        token.onCancellationRequested(() => linked.cancel());
        return refactorSnippet(doc.getText(), `${s.kind}: ${s.description}`, linked.token);
      },
    );
    if (!refactored) return false;
    if (confirm) {
      const choice = await vscode.window.showInformationMessage(
        `Apply AI refactor to ${path.basename(loc.filePath)}?`,
        { modal: true, detail: refactored.slice(0, 1500) + (refactored.length > 1500 ? '\n…' : '') },
        'Apply',
        'Cancel',
      );
      if (choice !== 'Apply') return false;
    }
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, fullRange, refactored);
    return vscode.workspace.applyEdit(we);
  } finally {
    cts.dispose();
  }
}

async function aiRefactor(mode: 'selection' | 'file'): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showInformationMessage('SCSS Manager: open an SCSS file first.');
    return;
  }
  const text = mode === 'selection' && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : ed.document.getText();
  const range = mode === 'selection' && !ed.selection.isEmpty
    ? ed.selection
    : new vscode.Range(new vscode.Position(0, 0), ed.document.positionAt(ed.document.getText().length));

  const cts = new vscode.CancellationTokenSource();
  try {
    const refactored = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `AI refactor (${mode})`, cancellable: true },
      async (_, token) => {
        token.onCancellationRequested(() => cts.cancel());
        return refactorSnippet(text, 'project-wide cleanup: nest, extract variables, dedupe', cts.token);
      },
    );
    if (!refactored) return;
    const cfg = vscode.workspace.getConfiguration('scssManager');
    if (cfg.get<boolean>('ai.confirmBeforeApply', true)) {
      const choice = await vscode.window.showInformationMessage(
        `Apply AI refactor to ${mode === 'file' ? 'entire file' : 'selection'}?`,
        { modal: true, detail: refactored.slice(0, 1500) + (refactored.length > 1500 ? '\n…' : '') },
        'Apply',
        'Cancel',
      );
      if (choice !== 'Apply') return;
    }
    await ed.edit((eb) => eb.replace(range, refactored));
  } finally {
    cts.dispose();
  }
}

async function revealLocation(filePath: string, line: number, col: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Resolve the on-disk path for a CSS → SCSS conversion result. */
function resolveConvertOutputPath(sourcePath: string, configured: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  // Strip ".min" if present so `foo.min.css` → `foo.scss`.
  const cleanedBase = base.endsWith('.min') ? base.slice(0, -4) : base;
  const defaultName = `${cleanedBase}.scss`;

  const trimmed = (configured ?? '').trim();
  if (!trimmed) {
    return path.join(path.dirname(sourcePath), defaultName);
  }

  let resolved = trimmed;
  if (!path.isAbsolute(resolved)) {
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourcePath));
    const root = ws?.uri.fsPath ?? path.dirname(sourcePath);
    resolved = path.join(root, resolved);
  }

  if (resolved.toLowerCase().endsWith('.scss')) {
    return resolved;
  }
  return path.join(resolved, defaultName);
}
