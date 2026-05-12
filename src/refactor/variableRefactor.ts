import * as vscode from 'vscode';
import * as path from 'path';
import { VariableSuggestion } from '../types';
import { applyEditsToFiles, safelyOpen } from '../utils/editor';
import { suggestVariableName } from '../llm/aiAssistant';
import { logger } from '../utils/logger';

export async function applyVariableRefactor(
  suggestion: VariableSuggestion,
  options: { confirm: boolean; useAiNaming: boolean; targetFile?: string },
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('scssManager');
  const targetFile =
    options.targetFile ?? cfg.get<string>('variables.targetFile', '') ?? '';

  // Resolve effective target file: configured override → primary file.
  let effectiveTarget = suggestion.insertionFile;
  if (targetFile && vscode.workspace.workspaceFolders) {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    effectiveTarget = path.isAbsolute(targetFile) ? targetFile : path.join(root, targetFile);
  }

  // Optionally upgrade the variable name with the LLM.
  let varName = suggestion.proposedName;
  if (options.useAiNaming) {
    const cts = new vscode.CancellationTokenSource();
    try {
      const sample = suggestion.locations.slice(0, 5).map((loc) => ({
        property: 'unknown', // we don't have the property here without re-parsing
        selector: 'unknown',
      }));
      const ai = await suggestVariableName(suggestion.value, sample, [], cts.token);
      if (ai) varName = ai;
    } catch (e) {
      logger.warn('AI naming failed; using fallback', e instanceof Error ? e.message : String(e));
    } finally {
      cts.dispose();
    }
  }

  // Build the variable declaration to insert.
  const varDecl = `${varName}: ${suggestion.value};\n`;

  // Determine the insertion offset in the effective target file:
  //  - After any leading @use / @forward / @import / @charset directives
  //  - But before any rules or other content
  const targetDoc = await safelyOpen(vscode.Uri.file(effectiveTarget));
  if (!targetDoc) {
    vscode.window.showErrorMessage(`SCSS Manager: cannot open target file ${effectiveTarget}`);
    return false;
  }
  const insertOffset = computeVariableInsertionOffset(targetDoc.getText());
  const insertPos = targetDoc.positionAt(insertOffset);

  // Build replacement edits for each occurrence.
  // We re-read each file's text to know exactly where the literal sits inside
  // the decl value, so we don't accidentally replace inside a string.
  const replacements: Array<{
    filePath: string;
    range: vscode.Range;
    newText: string;
  }> = [];

  for (const loc of suggestion.locations) {
    const doc = await safelyOpen(vscode.Uri.file(loc.filePath));
    if (!doc) continue;
    const declText = doc.getText(
      new vscode.Range(
        new vscode.Position(loc.range.start.line, loc.range.start.column),
        new vscode.Position(loc.range.end.line, loc.range.end.column),
      ),
    );
    // Find the exact literal in the decl text.
    const idx = declText.indexOf(suggestion.value);
    if (idx === -1) continue;
    const startOffset = loc.range.start.offset + idx;
    const endOffset = startOffset + suggestion.value.length;
    replacements.push({
      filePath: loc.filePath,
      range: new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset)),
      newText: varName,
    });
  }

  // Compose the workspace edit. Variable insertion goes first.
  const wsEdit = new vscode.WorkspaceEdit();
  const targetUri = vscode.Uri.file(effectiveTarget);
  wsEdit.insert(targetUri, insertPos, varDecl);
  for (const r of replacements) {
    wsEdit.replace(vscode.Uri.file(r.filePath), r.range, r.newText);
  }

  if (options.confirm) {
    const fileCount = new Set([effectiveTarget, ...replacements.map((r) => r.filePath)]).size;
    const choice = await vscode.window.showInformationMessage(
      `Extract "${suggestion.value}" as ${varName}? ${replacements.length} replacement${
        replacements.length === 1 ? '' : 's'
      } across ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
      { modal: true },
      'Apply',
      'Cancel',
    );
    if (choice !== 'Apply') return false;
  }

  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) {
    vscode.window.showWarningMessage('SCSS Manager: failed to apply variable extraction.');
  }
  return ok;
}

/**
 * Find the byte offset at which to insert a new $variable declaration in a
 * file. Inserts after the run of leading @use / @forward / @import / @charset
 * statements (and their blank-line gaps).
 */
function computeVariableInsertionOffset(text: string): number {
  const lines = text.split('\n');
  let lineIdx = 0;
  while (lineIdx < lines.length) {
    const line = lines[lineIdx].trim();
    if (line.length === 0) {
      lineIdx++;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('/*')) {
      lineIdx++;
      continue;
    }
    if (/^@(use|forward|import|charset)\b/.test(line)) {
      lineIdx++;
      continue;
    }
    break;
  }
  // Compute byte offset of the start of line `lineIdx`.
  let offset = 0;
  for (let i = 0; i < lineIdx && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for the '\n'
  }
  return offset;
}

export { applyEditsToFiles };
