import * as vscode from 'vscode';

/**
 * Position inside a source file (1-based line, 0-based column to match VS Code).
 */
export interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/* ─── SCSS AST ────────────────────────────────────────────────────────────── */

export type ScssNode = ScssRule | ScssDeclaration | ScssAtRule | ScssComment | ScssRoot;

export interface ScssRoot {
  kind: 'root';
  filePath: string;
  children: ScssNode[];
  source: string;
  /** Always undefined on root; present only so all nodes share the shape. */
  parent?: undefined;
  /** Always undefined on root; present only so all nodes share the shape. */
  range?: undefined;
}

export interface ScssRule {
  kind: 'rule';
  /** Comma-separated selector list as authored (e.g. ".a, .b > c"). */
  selector: string;
  /** Normalized selectors split on commas. */
  selectors: string[];
  children: ScssNode[];
  range: SourceRange;
  parent?: ScssNode;
}

export interface ScssDeclaration {
  kind: 'decl';
  property: string;
  value: string;
  important: boolean;
  range: SourceRange;
  parent?: ScssNode;
}

export interface ScssAtRule {
  kind: 'atrule';
  /** Name without the @. */
  name: string;
  params: string;
  /** Empty if at-rule has no block (e.g. @import). */
  children: ScssNode[];
  range: SourceRange;
  parent?: ScssNode;
}

export interface ScssComment {
  kind: 'comment';
  text: string;
  range: SourceRange;
  parent?: ScssNode;
}

/* ─── Suggestions ─────────────────────────────────────────────────────────── */

export type SuggestionKind =
  | 'nesting'           // collapse repeated parent selectors into a nested block
  | 'variable'          // extract a repeated literal into a variable
  | 'duplicate'         // two rules share enough declarations to merge / @extend
  | 'redundancy'        // duplicate property within a single rule, or empty rule
  | 'mixin';            // future: extract repeated declaration blocks to a mixin

export type Severity = 'info' | 'warning' | 'error';

export interface SuggestionLocation {
  filePath: string;
  range: SourceRange;
}

export interface BaseSuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  severity: Severity;
  /** Primary file the suggestion lives in. */
  filePath: string;
  /** All locations that will be modified if the suggestion is applied. */
  locations: SuggestionLocation[];
  /** Whether the refactor can be applied deterministically (no AI required). */
  safeAutoApply: boolean;
  /** Approximate lines of code saved if applied. */
  estimatedLinesSaved: number;
}

export interface NestingSuggestion extends BaseSuggestion {
  kind: 'nesting';
  parentSelector: string;
  childRuleIds: string[];
  /** Pre-computed text the parent rule will be replaced with. */
  proposedText: string;
}

export interface VariableSuggestion extends BaseSuggestion {
  kind: 'variable';
  value: string;
  occurrences: number;
  proposedName: string;
  /** Where the variable definition will be inserted. */
  insertionFile: string;
  insertionOffset: number;
}

export interface DuplicateSuggestion extends BaseSuggestion {
  kind: 'duplicate';
  selectorsInvolved: string[];
  sharedDeclarations: Array<{ property: string; value: string }>;
  similarity: number;
  /** Suggested strategy. */
  strategy: 'extend' | 'merge' | 'mixin';
}

export interface RedundancySuggestion extends BaseSuggestion {
  kind: 'redundancy';
  reason: 'duplicate-declaration' | 'empty-rule' | 'overridden-shorthand';
  replacementText: string;
}

export type Suggestion =
  | NestingSuggestion
  | VariableSuggestion
  | DuplicateSuggestion
  | RedundancySuggestion;

/* ─── Statistics ──────────────────────────────────────────────────────────── */

export interface ProjectStatistics {
  filesScanned: number;
  totalLines: number;
  totalSelectors: number;
  totalDeclarations: number;
  totalVariables: number;
  totalMixins: number;
  maxNestingDepth: number;
  averageNestingDepth: number;
  scanDurationMs: number;
  scannedAt: number;
}

export interface ScanResult {
  statistics: ProjectStatistics;
  suggestions: Suggestion[];
  /** Map of filePath → parsed AST, retained for incremental refactors. */
  asts: Map<string, ScssRoot>;
}

/* ─── VS Code helpers ─────────────────────────────────────────────────────── */

export function toVsCodeRange(r: SourceRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(r.start.line, r.start.column),
    new vscode.Position(r.end.line, r.end.column),
  );
}

export function toVsCodePosition(p: SourcePosition): vscode.Position {
  return new vscode.Position(p.line, p.column);
}
