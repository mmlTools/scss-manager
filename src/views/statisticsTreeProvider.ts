import * as vscode from 'vscode';
import * as path from 'path';
import {
  ProjectStatistics,
  ScanResult,
  Suggestion,
  SuggestionKind,
} from '../types';
import { workspaceRelative } from '../utils/editor';

/**
 * Tree node shape — discriminated union so each node type can carry its own
 * payload.
 */
export type TreeNode =
  | { kind: 'header'; id: string; label: string; description?: string }
  | { kind: 'stat'; id: string; label: string; value: string; iconId: string }
  | { kind: 'category'; id: string; label: string; suggestionKind: SuggestionKind; count: number }
  | { kind: 'suggestion'; id: string; suggestion: Suggestion }
  | { kind: 'action'; id: string; label: string; command: string; iconId: string }
  | { kind: 'empty'; id: string; label: string };

export class StatisticsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private result: ScanResult | undefined;
  private scanning = false;

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    this._onDidChangeTreeData.fire(undefined);
  }

  setResult(result: ScanResult | undefined): void {
    this.result = result;
    this._onDidChangeTreeData.fire(undefined);
  }

  getResult(): ScanResult | undefined {
    return this.result;
  }

  findSuggestion(id: string): Suggestion | undefined {
    return this.result?.suggestions.find((s) => s.id === id);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'header': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('symbol-folder');
        item.contextValue = 'header';
        return item;
      }
      case 'stat': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.value;
        item.iconPath = new vscode.ThemeIcon(node.iconId);
        item.contextValue = 'stat';
        return item;
      }
      case 'category': {
        const item = new vscode.TreeItem(
          node.label,
          node.count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.description = `${node.count}`;
        item.iconPath = new vscode.ThemeIcon(iconForCategory(node.suggestionKind));
        item.contextValue = 'category';
        return item;
      }
      case 'suggestion': {
        const s = node.suggestion;
        const item = new vscode.TreeItem(s.title);
        item.description = describeSuggestion(s);
        item.tooltip = new vscode.MarkdownString(buildTooltip(s));
        item.iconPath = new vscode.ThemeIcon(iconForSeverity(s.severity));
        item.contextValue = 'suggestion';
        item.command = {
          command: 'scssManager.showSuggestionDetails',
          title: 'Show Suggestion Details',
          arguments: [s.id],
        };
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.iconId);
        item.contextValue = 'action';
        item.command = { command: node.command, title: node.label };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.id === 'scanning' ? 'loading~spin' : 'info');
        item.contextValue = 'empty';
        return item;
      }
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (this.scanning) {
      return [{ kind: 'empty', id: 'scanning', label: 'Scanning…' }];
    }

    if (!element) {
      // Root level.
      const nodes: TreeNode[] = [];

      // 1. Stats section
      if (this.result) {
        nodes.push({
          kind: 'header',
          id: 'stats-header',
          label: 'Project Statistics',
          description: `${this.result.statistics.filesScanned} files · ${formatMs(this.result.statistics.scanDurationMs)}`,
        });

        // 2. Categories
        nodes.push({
          kind: 'header',
          id: 'suggestions-header',
          label: 'Suggestions',
          description: `${this.result.suggestions.length} total`,
        });

        // 3. Quick actions
        nodes.push({
          kind: 'header',
          id: 'actions-header',
          label: 'Actions',
        });
      } else {
        nodes.push({
          kind: 'action',
          id: 'scan',
          label: 'Scan Project',
          command: 'scssManager.scanProject',
          iconId: 'search',
        });
      }

      return nodes;
    }

    if (element.kind === 'header') {
      if (element.id === 'stats-header' && this.result) {
        return this.statsChildren(this.result.statistics);
      }
      if (element.id === 'suggestions-header' && this.result) {
        return this.suggestionCategoryChildren(this.result.suggestions);
      }
      if (element.id === 'actions-header') {
        return this.actionChildren();
      }
    }

    if (element.kind === 'category' && this.result) {
      const items = this.result.suggestions
        .filter((s) => s.kind === element.suggestionKind)
        .map((s): TreeNode => ({ kind: 'suggestion', id: s.id, suggestion: s }))
        .slice(0, 100); // cap for perf
      if (items.length === 0) {
        return [{ kind: 'empty', id: `${element.id}-empty`, label: 'No suggestions in this category' }];
      }
      return items;
    }

    return [];
  }

  private statsChildren(stats: ProjectStatistics): TreeNode[] {
    return [
      { kind: 'stat', id: 'stat-files', label: 'Files scanned', value: String(stats.filesScanned), iconId: 'files' },
      { kind: 'stat', id: 'stat-lines', label: 'Total lines', value: String(stats.totalLines), iconId: 'list-flat' },
      { kind: 'stat', id: 'stat-selectors', label: 'Selectors', value: String(stats.totalSelectors), iconId: 'symbol-class' },
      { kind: 'stat', id: 'stat-decls', label: 'Declarations', value: String(stats.totalDeclarations), iconId: 'symbol-property' },
      { kind: 'stat', id: 'stat-vars', label: 'Variables', value: String(stats.totalVariables), iconId: 'symbol-variable' },
      { kind: 'stat', id: 'stat-mixins', label: 'Mixins', value: String(stats.totalMixins), iconId: 'symbol-method' },
      {
        kind: 'stat',
        id: 'stat-depth',
        label: 'Nesting depth (max / avg)',
        value: `${stats.maxNestingDepth} / ${stats.averageNestingDepth.toFixed(1)}`,
        iconId: 'symbol-structure',
      },
    ];
  }

  private suggestionCategoryChildren(suggestions: Suggestion[]): TreeNode[] {
    const counts: Record<SuggestionKind, number> = {
      nesting: 0,
      variable: 0,
      duplicate: 0,
      redundancy: 0,
      mixin: 0,
    };
    for (const s of suggestions) counts[s.kind]++;
    return [
      { kind: 'category', id: 'cat-nesting', label: 'Nesting Opportunities', suggestionKind: 'nesting', count: counts.nesting },
      { kind: 'category', id: 'cat-variable', label: 'Variable Candidates', suggestionKind: 'variable', count: counts.variable },
      { kind: 'category', id: 'cat-duplicate', label: 'Duplicate / Similar Rules', suggestionKind: 'duplicate', count: counts.duplicate },
      { kind: 'category', id: 'cat-redundancy', label: 'In-rule Redundancies', suggestionKind: 'redundancy', count: counts.redundancy },
    ];
  }

  private actionChildren(): TreeNode[] {
    return [
      { kind: 'action', id: 'act-scan', label: 'Re-scan Project', command: 'scssManager.scanProject', iconId: 'search' },
      { kind: 'action', id: 'act-all', label: 'Apply All Safe Fixes', command: 'scssManager.applyAllSafe', iconId: 'check-all' },
      { kind: 'action', id: 'act-ai-file', label: 'AI Refactor Active File', command: 'scssManager.aiRefactorFile', iconId: 'sparkle' },
      { kind: 'action', id: 'act-settings', label: 'Open Settings', command: 'scssManager.openSettings', iconId: 'gear' },
    ];
  }
}

function iconForCategory(kind: SuggestionKind): string {
  switch (kind) {
    case 'nesting': return 'list-tree';
    case 'variable': return 'symbol-variable';
    case 'duplicate': return 'copy';
    case 'redundancy': return 'trash';
    case 'mixin': return 'symbol-method';
  }
}

function iconForSeverity(sev: 'info' | 'warning' | 'error'): string {
  switch (sev) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'lightbulb';
  }
}

function describeSuggestion(s: Suggestion): string {
  const rel = workspaceRelative(s.filePath);
  const base = path.basename(rel);
  const line = s.locations[0]?.range.start.line;
  return `${base}:${line === undefined ? '?' : line + 1}`;
}

function buildTooltip(s: Suggestion): string {
  const lines = [
    `**${s.title}**`,
    '',
    s.description,
    '',
    `_File:_ \`${workspaceRelative(s.filePath)}\``,
  ];
  if (s.estimatedLinesSaved > 0) {
    lines.push(`_Estimated lines saved:_ ${s.estimatedLinesSaved}`);
  }
  if (s.safeAutoApply) {
    lines.push('_Safe to auto-apply._');
  }
  return lines.join('\n');
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
