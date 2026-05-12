import * as vscode from 'vscode';
import { StatisticsTreeProvider } from './views/statisticsTreeProvider';
import { registerCommands, runScan } from './commands';
import { minifyDocument } from './minify/minifier';
import { logger } from './utils/logger';

let treeProvider: StatisticsTreeProvider | undefined;
let saveDebounce: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.info('SCSS Manager activating');

  treeProvider = new StatisticsTreeProvider();
  const view = vscode.window.createTreeView('scssManager.statisticsView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  registerCommands(context, treeProvider);

  // Auto-scan on save (debounced)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration('scssManager');
      if (doc.languageId !== 'scss' && doc.languageId !== 'sass') return;

      // Auto-minify (fire and forget — errors are surfaced as notifications)
      if (cfg.get<boolean>('minify.autoOnSave', false)) {
        void minifyDocument(doc.uri).catch((e) => {
          vscode.window.showErrorMessage(
            `SCSS Manager: auto-minify failed — ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }

      if (!cfg.get<boolean>('scan.autoScanOnSave', true)) return;
      if (saveDebounce) clearTimeout(saveDebounce);
      saveDebounce = setTimeout(() => {
        if (treeProvider) runScan(treeProvider);
      }, 800);
    }),
  );

  // Initial scan if there's an open workspace and at least one SCSS file
  // already open.
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    // Don't block activation; kick off async.
    void runScan(treeProvider);
  }
}

export function deactivate(): void {
  if (saveDebounce) clearTimeout(saveDebounce);
  treeProvider = undefined;
  logger.info('SCSS Manager deactivated');
}
