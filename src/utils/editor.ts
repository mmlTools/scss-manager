import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from './logger';

/**
 * Apply a series of edits to one or more files atomically, optionally
 * previewing them via a diff before commit when `confirm` is true.
 */
export async function applyEditsToFiles(
  edits: Array<{ filePath: string; range?: vscode.Range; newText: string; isInsertion?: boolean; insertOffset?: number }>,
  options: { confirm?: boolean; label?: string } = {},
): Promise<boolean> {
  const wsEdit = new vscode.WorkspaceEdit();

  for (const e of edits) {
    const uri = vscode.Uri.file(e.filePath);
    const doc = await safelyOpen(uri);
    if (!doc) continue;

    if (e.isInsertion && typeof e.insertOffset === 'number') {
      const pos = doc.positionAt(e.insertOffset);
      wsEdit.insert(uri, pos, e.newText);
    } else if (e.range) {
      wsEdit.replace(uri, e.range, e.newText);
    }
  }

  if (options.confirm) {
    const choice = await vscode.window.showInformationMessage(
      `Apply ${options.label ?? 'refactor'}? ${edits.length} edit${edits.length === 1 ? '' : 's'} across ${
        new Set(edits.map((e) => e.filePath)).size
      } file${new Set(edits.map((e) => e.filePath)).size === 1 ? '' : 's'}.`,
      { modal: true },
      'Apply',
      'Cancel',
    );
    if (choice !== 'Apply') return false;
  }

  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) {
    logger.warn('applyEditsToFiles: applyEdit returned false');
    vscode.window.showWarningMessage('SCSS Manager: failed to apply refactor (workspace edit rejected).');
  }
  return ok;
}

export async function safelyOpen(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    logger.error(`Failed to open ${uri.fsPath}`, e);
    return undefined;
  }
}

export function workspaceRelative(absPath: string): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return absPath;
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    if (absPath.startsWith(folderPath)) {
      return path.relative(folderPath, absPath);
    }
  }
  return absPath;
}

export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}

/**
 * Indent a block of text by `count` spaces (or tabs if `useTabs`).
 */
export function indentLines(text: string, count: number, useTabs = false): string {
  const indent = useTabs ? '\t'.repeat(count) : ' '.repeat(count);
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.length === 0 ? l : indent + l))
    .join('\n');
}

/**
 * Get indent unit (spaces) for the active editor or a fallback of 2.
 */
export function getIndentUnit(doc?: vscode.TextDocument): { useTabs: boolean; size: number } {
  const editor = vscode.window.activeTextEditor;
  const eff = editor && (!doc || editor.document.uri.toString() === doc.uri.toString()) ? editor : undefined;
  if (eff) {
    return {
      useTabs: eff.options.insertSpaces === false,
      size: typeof eff.options.tabSize === 'number' ? eff.options.tabSize : 2,
    };
  }
  return { useTabs: false, size: 2 };
}
