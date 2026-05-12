import { RedundancySuggestion, ScssRoot, ScssRule } from '../types';
import { allRules } from '../parser/scssParser';

/**
 * Find redundancies that can be safely fixed without considering other files:
 *   - Duplicate declarations within a single rule (last wins, earlier ones
 *     can be removed)
 *   - Empty rules
 *   - Shorthand followed by longhand override (warning only, don't auto-fix)
 */
export function analyzeRedundancy(asts: Map<string, ScssRoot>): RedundancySuggestion[] {
  const suggestions: RedundancySuggestion[] = [];

  for (const ast of asts.values()) {
    for (const rule of allRules(ast)) {
      const decls = rule.children.filter((c) => c.kind === 'decl') as Array<typeof rule.children[number] & { kind: 'decl' }>;

      // 1) Empty rule (no decls, no nested rules)
      if (rule.children.length === 0) {
        suggestions.push({
          id: `red:empty:${ast.filePath}:${rule.range.start.offset}`,
          kind: 'redundancy',
          title: `Empty rule: "${truncate(rule.selector, 40)}"`,
          description: `The rule "${rule.selector}" has no declarations. Safe to remove.`,
          severity: 'info',
          filePath: ast.filePath,
          locations: [{ filePath: ast.filePath, range: rule.range }],
          safeAutoApply: true,
          estimatedLinesSaved: rule.range.end.line - rule.range.start.line + 1,
          reason: 'empty-rule',
          replacementText: '',
        });
        continue;
      }

      // 2) Duplicate declarations within the same rule.
      const seen = new Map<string, number>();
      for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        const key = `${d.property}|${d.value}|${d.important}`;
        if (seen.has(key)) {
          const earlierIdx = seen.get(key)!;
          const earlier = decls[earlierIdx];
          suggestions.push({
            id: `red:dupdecl:${ast.filePath}:${earlier.range.start.offset}`,
            kind: 'redundancy',
            title: `Duplicate "${d.property}: ${truncate(d.value, 20)}" in "${truncate(rule.selector, 25)}"`,
            description: `The declaration "${d.property}: ${d.value}" appears twice in the same rule. The earlier occurrence can be removed.`,
            severity: 'warning',
            filePath: ast.filePath,
            locations: [{ filePath: ast.filePath, range: earlier.range }],
            safeAutoApply: true,
            estimatedLinesSaved: 1,
            reason: 'duplicate-declaration',
            replacementText: '',
          });
        } else {
          seen.set(key, i);
        }
      }

      // 3) Same property declared multiple times with different values.
      // This is sometimes intentional (fallback for older browsers), so we
      // mark it info, not auto-fixable.
      const byProperty = new Map<string, typeof decls>();
      for (const d of decls) {
        if (!byProperty.has(d.property)) byProperty.set(d.property, []);
        byProperty.get(d.property)!.push(d);
      }
      for (const [prop, list] of byProperty) {
        if (list.length < 2) continue;
        const last = list[list.length - 1];
        const first = list[0];
        if (first.value === last.value) continue; // already caught above
        suggestions.push({
          id: `red:samename:${ast.filePath}:${first.range.start.offset}`,
          kind: 'redundancy',
          title: `Property "${prop}" declared ${list.length}× in "${truncate(rule.selector, 25)}"`,
          description: `The property "${prop}" is declared multiple times in "${rule.selector}". The last value wins; earlier ones are only useful as a fallback. Verify intent.`,
          severity: 'info',
          filePath: ast.filePath,
          locations: list.map((d) => ({ filePath: ast.filePath, range: d.range })),
          safeAutoApply: false,
          estimatedLinesSaved: 0,
          reason: 'overridden-shorthand',
          replacementText: '',
        });
      }
    }
  }

  return suggestions;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
