import * as vscode from 'vscode';
import { DuplicateSuggestion } from '../types';
import { applyEditsToFiles, safelyOpen } from '../utils/editor';
import { logger } from '../utils/logger';

/**
 * Apply a duplicate-consolidation refactor.
 *
 *  - `merge` strategy: combines two selectors into a single rule's selector
 *    list and deletes the second rule. Only safe when both rules live in the
 *    same file and the declaration sets are identical.
 *  - `extend` and `mixin` strategies require user confirmation and are
 *    routed through the AI assistant via the WebView (this function will
 *    return false; the WebView handles them).
 */
export async function applyDuplicateRefactor(
  suggestion: DuplicateSuggestion,
  options: { confirm: boolean },
): Promise<boolean> {
  if (suggestion.strategy !== 'merge') {
    vscode.window.showInformationMessage(
      `SCSS Manager: this duplicate suggestion requires AI refactoring. Open the details panel and use "AI Refactor".`,
    );
    return false;
  }

  const [a, b] = suggestion.locations;
  if (!a || !b) return false;
  if (a.filePath !== b.filePath) {
    vscode.window.showInformationMessage('Cross-file duplicate merge is not supported automatically. Use AI Refactor.');
    return false;
  }

  const doc = await safelyOpen(vscode.Uri.file(a.filePath));
  if (!doc) return false;

  // Read both rules' text. Combine selector lists into the first rule;
  // delete the second.
  const firstText = doc.getText(
    new vscode.Range(
      new vscode.Position(a.range.start.line, a.range.start.column),
      new vscode.Position(a.range.end.line, a.range.end.column),
    ),
  );
  const secondText = doc.getText(
    new vscode.Range(
      new vscode.Position(b.range.start.line, b.range.start.column),
      new vscode.Position(b.range.end.line, b.range.end.column),
    ),
  );

  const firstHead = extractSelectorHead(firstText);
  const secondHead = extractSelectorHead(secondText);
  if (!firstHead || !secondHead) {
    logger.warn('duplicate merge: could not parse selector heads');
    return false;
  }

  const mergedHead = `${firstHead.selector}, ${secondHead.selector}`;
  const mergedFirst = firstHead.before + mergedHead + firstHead.after;

  // Build edits: replace first rule with merged version; delete second rule
  // including the trailing newline.
  const firstStart = new vscode.Position(a.range.start.line, a.range.start.column);
  const firstEnd = new vscode.Position(a.range.end.line, a.range.end.column);
  const secondStart = new vscode.Position(b.range.start.line, b.range.start.column);
  const secondEnd = new vscode.Position(b.range.end.line, b.range.end.column);

  // Expand secondEnd through a trailing newline if present, so we don't leave
  // a blank line.
  let secondEndAdjusted = secondEnd;
  const fullText = doc.getText();
  const secondEndOffset = doc.offsetAt(secondEnd);
  if (fullText[secondEndOffset] === '\n') {
    secondEndAdjusted = doc.positionAt(secondEndOffset + 1);
  }

  return applyEditsToFiles(
    [
      { filePath: a.filePath, range: new vscode.Range(firstStart, firstEnd), newText: mergedFirst },
      { filePath: b.filePath, range: new vscode.Range(secondStart, secondEndAdjusted), newText: '' },
    ],
    { confirm: options.confirm, label: 'merge duplicate rules' },
  );
}

/**
 * Parse a rule's text and return its selector part along with the surrounding
 * whitespace / braces, so we can replace just the selector while keeping the
 * body intact.
 */
function extractSelectorHead(ruleText: string): { before: string; selector: string; after: string } | undefined {
  const braceIdx = ruleText.indexOf('{');
  if (braceIdx === -1) return undefined;
  const head = ruleText.slice(0, braceIdx);
  // Preserve leading whitespace.
  const m = head.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m) return undefined;
  return { before: m[1], selector: m[2], after: m[3] + ruleText.slice(braceIdx) };
}
