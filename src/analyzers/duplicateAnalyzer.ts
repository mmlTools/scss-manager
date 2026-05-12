import { DuplicateSuggestion, ScssRoot, ScssRule } from '../types';
import { allRules } from '../parser/scssParser';

export interface DuplicateOptions {
  minSharedDeclarations: number;
  similarityThreshold: number;
}

interface RuleSignature {
  rule: ScssRule;
  filePath: string;
  decls: Set<string>; // `${prop}:${value}`
  declList: Array<{ property: string; value: string }>;
}

/**
 * Find rule pairs whose declaration sets overlap heavily. These are candidates
 * for consolidation via @extend, mixin, or merge.
 *
 * Pairs are reported once (i, j) with i < j. To keep this O(n²) on rules
 * manageable for very large projects we bucket rules by declaration count
 * first; only compare within the same or adjacent buckets.
 */
export function analyzeDuplicates(asts: Map<string, ScssRoot>, options: DuplicateOptions): DuplicateSuggestion[] {
  const signatures: RuleSignature[] = [];

  for (const ast of asts.values()) {
    for (const rule of allRules(ast)) {
      const declList: Array<{ property: string; value: string }> = [];
      for (const child of rule.children) {
        if (child.kind === 'decl' && !child.property.startsWith('$')) {
          declList.push({ property: child.property, value: child.value.trim() });
        }
      }
      if (declList.length < options.minSharedDeclarations) continue;

      const set = new Set(declList.map((d) => `${d.property}:${d.value}`));
      signatures.push({ rule, filePath: ast.filePath, decls: set, declList });
    }
  }

  // Bucket by declaration count for prune.
  const buckets = new Map<number, RuleSignature[]>();
  for (const sig of signatures) {
    const c = sig.decls.size;
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c)!.push(sig);
  }

  const suggestions: DuplicateSuggestion[] = [];
  const seen = new Set<string>();

  for (const sig of signatures) {
    const lower = sig.decls.size;
    // Compare against rules with similar declaration count (±2).
    const candidates: RuleSignature[] = [];
    for (let delta = -2; delta <= 2; delta++) {
      const others = buckets.get(lower + delta);
      if (others) candidates.push(...others);
    }

    for (const other of candidates) {
      if (other === sig) continue;
      const a = sig.rule.range.start.offset + sig.filePath.length;
      const b = other.rule.range.start.offset + other.filePath.length;
      if (a >= b) continue; // pair once
      const key = `${sig.filePath}:${sig.rule.range.start.offset}|${other.filePath}:${other.rule.range.start.offset}`;
      if (seen.has(key)) continue;

      const { similarity, shared } = jaccardWithShared(sig.decls, other.decls);
      if (shared.length < options.minSharedDeclarations) continue;
      if (similarity < options.similarityThreshold) continue;
      seen.add(key);

      const strategy: 'extend' | 'merge' | 'mixin' =
        similarity === 1 && sig.filePath === other.filePath
          ? 'merge'
          : similarity >= 0.95
            ? 'extend'
            : 'mixin';

      const sharedDecls = shared.map((s) => {
        const [property, ...rest] = s.split(':');
        return { property, value: rest.join(':') };
      });

      const a_sel = sig.rule.selector;
      const b_sel = other.rule.selector;

      suggestions.push({
        id: `dup:${hash(key)}`,
        kind: 'duplicate',
        title: `Duplicate: "${truncate(a_sel, 25)}" ≈ "${truncate(b_sel, 25)}" (${(similarity * 100).toFixed(
          0,
        )}% match)`,
        description: `Selectors "${a_sel}" and "${b_sel}" share ${shared.length} declaration${
          shared.length === 1 ? '' : 's'
        }. Suggested strategy: ${strategy === 'merge' ? 'merge selector lists' : strategy === 'extend' ? 'use @extend' : 'extract a @mixin'}.`,
        severity: similarity === 1 ? 'warning' : 'info',
        filePath: sig.filePath,
        locations: [
          { filePath: sig.filePath, range: sig.rule.range },
          { filePath: other.filePath, range: other.rule.range },
        ],
        safeAutoApply: strategy === 'merge' && similarity === 1,
        estimatedLinesSaved: shared.length,
        selectorsInvolved: [a_sel, b_sel],
        sharedDeclarations: sharedDecls,
        similarity,
        strategy,
      });
    }
  }

  // Avoid overwhelming the user: cap to top-N by lines saved.
  suggestions.sort((a, b) => b.estimatedLinesSaved - a.estimatedLinesSaved);
  return suggestions.slice(0, 200);
}

function jaccardWithShared(a: Set<string>, b: Set<string>): { similarity: number; shared: string[] } {
  const shared: string[] = [];
  for (const x of a) if (b.has(x)) shared.push(x);
  const union = a.size + b.size - shared.length;
  const similarity = union === 0 ? 0 : shared.length / union;
  return { similarity, shared };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
