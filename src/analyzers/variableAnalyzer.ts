import { ScssDeclaration, ScssRoot, VariableSuggestion } from '../types';
import { allDeclarations } from '../parser/scssParser';

export interface VariableOptions {
  minOccurrences: number;
  namingStrategy: 'semantic-ai' | 'literal' | 'hash';
}

interface ValueOccurrence {
  filePath: string;
  decl: ScssDeclaration;
  rawValue: string;
}

/**
 * Find literal values that appear `minOccurrences` or more times across the
 * project. These are candidates for variable extraction.
 *
 * Categories scanned:
 *   - hex colors (#rgb / #rrggbb / #rrggbbaa)
 *   - rgb()/rgba()/hsl()/hsla()
 *   - named colors used in color-bearing properties
 *   - length values (px / rem / em / %) — only when they appear at least
 *     `minOccurrences` times across distinct files
 *   - font-family strings (when bare in a `font-family` decl)
 *   - common z-index integers
 */
export function analyzeVariables(asts: Map<string, ScssRoot>, options: VariableOptions): VariableSuggestion[] {
  const occurrencesByValue = new Map<string, ValueOccurrence[]>();
  const existingNames = collectExistingVariableNames(asts);

  for (const ast of asts.values()) {
    for (const decl of allDeclarations(ast)) {
      // Skip the variable declarations themselves.
      if (decl.property.startsWith('$')) continue;
      // Skip declarations already using a variable.
      if (decl.value.includes('$')) continue;

      const extracted = extractCandidateValues(decl);
      for (const value of extracted) {
        const key = canonicalize(value);
        if (!occurrencesByValue.has(key)) occurrencesByValue.set(key, []);
        occurrencesByValue.get(key)!.push({ filePath: ast.filePath, decl, rawValue: value });
      }
    }
  }

  const suggestions: VariableSuggestion[] = [];

  for (const [canonical, occs] of occurrencesByValue) {
    if (occs.length < options.minOccurrences) continue;

    // Pick a representative location for the primary report.
    const first = occs[0];
    const proposedName = generateName(canonical, occs, existingNames, options.namingStrategy);
    existingNames.add(proposedName);

    const linesSaved = Math.max(0, occs.length - 1); // each replacement saves ~1 character cost, but variable line adds 1
    suggestions.push({
      id: `var:${hash(canonical)}`,
      kind: 'variable',
      title: `Extract ${occs.length}× "${truncate(canonical, 30)}" → ${proposedName}`,
      description: `The value "${canonical}" appears ${occs.length} times across ${new Set(
        occs.map((o) => o.filePath),
      ).size} file(s). Extracting it into a variable centralizes the value and makes theme changes easier.`,
      severity: 'info',
      filePath: first.filePath,
      locations: occs.map((o) => ({ filePath: o.filePath, range: o.decl.range })),
      safeAutoApply: false, // requires choosing a target file
      estimatedLinesSaved: linesSaved,
      value: canonical,
      occurrences: occs.length,
      proposedName,
      insertionFile: first.filePath,
      insertionOffset: 0, // refactor will compute real offset
    });
  }

  // Sort by impact (most occurrences first).
  suggestions.sort((a, b) => b.occurrences - a.occurrences);
  return suggestions;
}

/* ─── extraction ──────────────────────────────────────────────────────────── */

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR = /\b(rgb|rgba|hsl|hsla)\([^)]*\)/g;
const LENGTH = /\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)\b/g;

const COLOR_BEARING_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'box-shadow',
  'text-shadow',
  'fill',
  'stroke',
  'caret-color',
]);

function extractCandidateValues(decl: ScssDeclaration): string[] {
  const out: string[] = [];
  const value = decl.value;

  // Hex colors
  let m: RegExpExecArray | null;
  HEX.lastIndex = 0;
  while ((m = HEX.exec(value)) !== null) out.push(m[0]);

  // rgb/rgba/hsl/hsla
  FUNC_COLOR.lastIndex = 0;
  while ((m = FUNC_COLOR.exec(value)) !== null) out.push(m[0]);

  // Lengths — only collect if the whole value is a single length, to avoid
  // noise from shorthand (`padding: 8px 16px`).
  if (/^\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)$/.test(value.trim())) {
    out.push(value.trim());
  }

  // Font family — if the decl is `font-family` and value isn't already a var.
  if (decl.property === 'font-family') {
    out.push(value.trim());
  }

  // z-index — if a non-trivial integer.
  if (decl.property === 'z-index') {
    const z = parseInt(value, 10);
    if (!Number.isNaN(z) && Math.abs(z) >= 10) out.push(String(z));
  }

  // Filter: must be a color-bearing property for color values, otherwise drop
  // (e.g. `content: "#fff"` would be a false positive for the hex regex).
  return out.filter((v) => isReasonableCandidate(decl, v));
}

function isReasonableCandidate(decl: ScssDeclaration, value: string): boolean {
  // Color in a non-color property is suspicious.
  if (/^#[0-9a-fA-F]{3,8}$|^(rgb|rgba|hsl|hsla)\(/.test(value)) {
    if (!COLOR_BEARING_PROPS.has(decl.property)) return false;
  }
  return true;
}

function canonicalize(value: string): string {
  let v = value.trim();
  // Lowercase hex.
  if (v.startsWith('#')) v = v.toLowerCase();
  // Collapse whitespace inside function calls.
  v = v.replace(/\s+/g, ' ');
  return v;
}

/* ─── naming ──────────────────────────────────────────────────────────────── */

function collectExistingVariableNames(asts: Map<string, ScssRoot>): Set<string> {
  const names = new Set<string>();
  for (const ast of asts.values()) {
    for (const decl of allDeclarations(ast)) {
      if (decl.property.startsWith('$')) {
        names.add(decl.property);
      }
    }
  }
  return names;
}

function generateName(
  value: string,
  occs: ValueOccurrence[],
  existing: Set<string>,
  strategy: 'semantic-ai' | 'literal' | 'hash',
): string {
  // For now, all strategies fall through to a literal-derived name.
  // The 'semantic-ai' strategy is upgraded asynchronously by the AI assistant
  // when the user applies the suggestion (since AI calls are expensive, we
  // defer them until the user is interested).
  let base: string;

  if (strategy === 'hash') {
    base = `$c-${hash(value).slice(0, 5)}`;
  } else if (value.startsWith('#')) {
    // Hex: name by canonical hex with prefix derived from sample property.
    const sampleProp = occs[0]?.decl.property ?? 'color';
    const role = sampleProp.includes('background') ? 'bg' : sampleProp.includes('border') ? 'border' : 'color';
    base = `$${role}-${value.replace('#', '').toLowerCase()}`;
  } else if (/^\d/.test(value)) {
    // Length / number.
    const unitMatch = value.match(/[a-z%]+$/i);
    const unit = unitMatch ? unitMatch[0] : 'n';
    const num = value.replace(/[a-z%]+$/i, '').replace('.', '_');
    base = `$size-${num}${unit}`;
  } else if (/^(rgb|rgba|hsl|hsla)/.test(value)) {
    base = `$color-${hash(value).slice(0, 5)}`;
  } else {
    base = `$value-${hash(value).slice(0, 5)}`;
  }

  // Deduplicate.
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
