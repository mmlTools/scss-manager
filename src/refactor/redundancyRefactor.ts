import * as vscode from 'vscode';
import { RedundancySuggestion } from '../types';
import { applyEditsToFiles, safelyOpen } from '../utils/editor';

export async function applyRedundancyRefactor(
  suggestion: RedundancySuggestion,
  options: { confirm: boolean },
): Promise<boolean> {
  if (!suggestion.safeAutoApply) {
    vscode.window.showInformationMessage(
      'SCSS Manager: this redundancy requires manual review.',
    );
    return false;
  }

  const loc = suggestion.locations[0];
  if (!loc) return false;

  const doc = await safelyOpen(vscode.Uri.file(loc.filePath));
  if (!doc) return false;

  // For empty rules and duplicate declarations, delete the range plus a
  // trailing newline if present.
  const startPos = new vscode.Position(loc.range.start.line, loc.range.start.column);
  let endPos = new vscode.Position(loc.range.end.line, loc.range.end.column);
  const endOffset = doc.offsetAt(endPos);
  const fullText = doc.getText();
  if (fullText[endOffset] === '\n') {
    endPos = doc.positionAt(endOffset + 1);
  } else if (fullText.slice(endOffset, endOffset + 2) === '\r\n') {
    endPos = doc.positionAt(endOffset + 2);
  }

  return applyEditsToFiles(
    [{ filePath: loc.filePath, range: new vscode.Range(startPos, endPos), newText: '' }],
    { confirm: options.confirm, label: suggestion.reason },
  );
}
