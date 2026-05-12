import * as vscode from 'vscode';
import { NestingSuggestion, toVsCodeRange } from '../types';
import { applyEditsToFiles } from '../utils/editor';

export async function applyNestingRefactor(
  suggestion: NestingSuggestion,
  options: { confirm: boolean },
): Promise<boolean> {
  // Single-file refactor: locations are all in `suggestion.filePath`.
  const sorted = [...suggestion.locations].sort(
    (a, b) => a.range.start.offset - b.range.start.offset,
  );
  if (sorted.length === 0) return false;

  const first = sorted[0].range;
  const last = sorted[sorted.length - 1].range;

  // Replace the entire span from first rule start to last rule end with the
  // proposed nested block.
  const span = new vscode.Range(
    new vscode.Position(first.start.line, first.start.column),
    new vscode.Position(last.end.line, last.end.column),
  );

  // Delete other rule ranges that fall within span — they are subsumed by
  // the span replacement. (Since `span` covers them, a single replace is
  // enough; nothing further to do.)
  return applyEditsToFiles(
    [{ filePath: suggestion.filePath, range: span, newText: suggestion.proposedText }],
    { confirm: options.confirm, label: `nesting (${suggestion.parentSelector})` },
  );
}

export { toVsCodeRange };
