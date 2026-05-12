import { NestingSuggestion, ScssRoot, ScssRule } from '../types';
import { allRules } from '../parser/scssParser';

export interface NestingOptions {
  maxDepth: number;
  minChildren: number;
}

interface SelectorGroup {
  parent: string;
  rules: ScssRule[];
}

/**
 * Find rule sets that share a common selector prefix at the same nesting
 * level and could be collapsed into a single nested rule.
 *
 * Example:
 *   .card { color: red; }
 *   .card .header { font-size: 20px; }
 *   .card:hover { color: blue; }
 *
 *  → suggest nesting:
 *   .card {
 *     color: red;
 *     .header { font-size: 20px; }
 *     &:hover { color: blue; }
 *   }
 */
export function analyzeNesting(asts: Map<string, ScssRoot>, options: NestingOptions): NestingSuggestion[] {
  const suggestions: NestingSuggestion[] = [];

  for (const ast of asts.values()) {
    // Only analyze top-level rules in each file for now; descendants are
    // already nested.
    const topLevelRules = ast.children.filter((c): c is ScssRule => c.kind === 'rule');
    const groups = groupBySharedPrefix(topLevelRules);

    for (const group of groups) {
      if (group.rules.length < options.minChildren) continue;
      // Skip if the parent selector itself is empty or trivial.
      if (!group.parent || group.parent.length === 0) continue;
      // Skip really long compound selectors as parents — usually means the
      // grouping was over-eager.
      if (group.parent.split(/\s+/).length > 4) continue;

      const proposed = buildNestedRule(group, ast.source);
      // Savings measured as "selector repetitions removed" — each rule after
      // the first one no longer has to repeat the parent selector. This is
      // the real maintainability win from nesting, regardless of whether the
      // pretty-printed line count changes.
      const repetitionsSaved = group.rules.length - 1;
      if (repetitionsSaved <= 0) continue;

      const id = makeId('nest', ast.filePath, group.parent, group.rules[0].range.start.offset);
      const first = group.rules[0];
      const last = group.rules[group.rules.length - 1];

      suggestions.push({
        id,
        kind: 'nesting',
        title: `Collapse ${group.rules.length} rules into nested "${group.parent}"`,
        description: `${group.rules.length} top-level rules all extend "${group.parent}". Nesting them removes the repeated parent selector.`,
        severity: 'info',
        filePath: ast.filePath,
        locations: group.rules.map((r) => ({ filePath: ast.filePath, range: r.range })),
        safeAutoApply: true,
        estimatedLinesSaved: repetitionsSaved,
        parentSelector: group.parent,
        childRuleIds: group.rules.map((r) => `${r.range.start.offset}`),
        proposedText: proposed,
      });
    }
  }

  return suggestions;
}

/**
 * Group rules whose selectors share a common leading token. Each rule
 * contributes to at most one group (the one for its longest qualifying
 * prefix among the group candidates).
 *
 * We use the first whitespace-separated token of the FIRST selector in each
 * rule's selector list as the grouping key. Pseudo-classes and combinators
 * attached to the root token count as the same group (with `&` rewriting).
 */
function groupBySharedPrefix(rules: ScssRule[]): SelectorGroup[] {
  const byRoot = new Map<string, ScssRule[]>();

  for (const rule of rules) {
    const first = rule.selectors[0];
    if (!first) continue;
    const root = extractRootSelector(first);
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(rule);
  }

  const out: SelectorGroup[] = [];
  for (const [parent, group] of byRoot) {
    if (group.length >= 2) out.push({ parent, rules: group });
  }
  return out;
}

/**
 * Extract the "root" selector — the part before any descendant combinator,
 * pseudo, or attribute. Examples:
 *   ".card"           → ".card"
 *   ".card .header"   → ".card"
 *   ".card:hover"     → ".card"
 *   ".card > .body"   → ".card"
 *   ".card.active"    → ".card" (compound — handle later)
 */
function extractRootSelector(selector: string): string | undefined {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return undefined;

  // Find the first combinator or pseudo split point.
  const match = trimmed.match(/^([.#&]?[\w-]+|\*|\[[^\]]+\])/);
  if (!match) return undefined;
  return match[1];
}

/**
 * Build the proposed nested rule text. Each child rule gets its leading
 * parent removed (replaced with `&` if needed).
 */
function buildNestedRule(group: SelectorGroup, _source: string): string {
  const lines: string[] = [`${group.parent} {`];

  // Aggregate declarations from rules whose selector is exactly the parent
  // (so we can pull them up).
  const exactRules: ScssRule[] = [];
  const childRules: ScssRule[] = [];

  for (const r of group.rules) {
    const firstSel = r.selectors[0].trim();
    if (firstSel === group.parent && r.selectors.length === 1) {
      exactRules.push(r);
    } else {
      childRules.push(r);
    }
  }

  for (const r of exactRules) {
    for (const child of r.children) {
      if (child.kind === 'decl') {
        const imp = child.important ? ' !important' : '';
        lines.push(`  ${child.property}: ${child.value}${imp};`);
      }
    }
  }

  for (const r of childRules) {
    const rewritten = r.selectors
      .map((s) => rewriteSelector(s.trim(), group.parent))
      .join(', ');
    lines.push(`  ${rewritten} {`);
    for (const child of r.children) {
      if (child.kind === 'decl') {
        const imp = child.important ? ' !important' : '';
        lines.push(`    ${child.property}: ${child.value}${imp};`);
      }
    }
    lines.push(`  }`);
  }

  lines.push(`}`);
  return lines.join('\n');
}

/**
 * Strip the parent prefix from a selector and replace with `&` where needed.
 *   (".card", ".card")        → null (handled separately, declarations pulled up)
 *   (".card .header", ".card") → ".header"
 *   (".card:hover", ".card")   → "&:hover"
 *   (".card > .body", ".card") → "> .body"
 *   (".card.active", ".card")  → "&.active"
 */
function rewriteSelector(child: string, parent: string): string {
  if (child === parent) return '&';

  // Descendant: ".card .header" → ".header"
  if (child.startsWith(parent + ' ')) {
    return child.slice(parent.length + 1);
  }
  // Combinator child/sibling: ".card > .body" → "> .body"
  const combinatorMatch = child.match(new RegExp(`^${escapeRegex(parent)}\\s*([>+~])\\s*(.+)$`));
  if (combinatorMatch) {
    return `${combinatorMatch[1]} ${combinatorMatch[2]}`;
  }
  // Pseudo / compound: ".card:hover" → "&:hover", ".card.active" → "&.active"
  if (child.startsWith(parent)) {
    const rest = child.slice(parent.length);
    if (rest.startsWith(':') || rest.startsWith('.') || rest.startsWith('#') || rest.startsWith('[')) {
      return `&${rest}`;
    }
  }
  // Fallback — couldn't simplify, keep original (this rule won't really
  // benefit, but we don't want to corrupt output).
  return child;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function estimateLinesSaved(_group: SelectorGroup, _proposed: string): number {
  // Kept for backwards compatibility; no longer used by the analyzer.
  return 0;
}

function makeId(prefix: string, file: string, key: string, offset: number): string {
  return `${prefix}:${file}:${offset}:${hash(key)}`;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export { allRules };
