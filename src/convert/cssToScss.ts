import postcss from 'postcss';
import type { Root, Rule, AtRule, Declaration, Comment, ChildNode } from 'postcss';
import { logger } from '../utils/logger';

/**
 * CSS → SCSS converter.
 *
 * Strategy
 * --------
 * 1. Parse CSS with postcss.
 * 2. Build a selector trie for single-selector rules so that shared
 *    ancestors collapse into nested blocks. Multi-selector rules
 *    (`.a, .b { … }`) stay un-nested but are still emitted in source order.
 * 3. Walk every declaration, count repeated literal values
 *    (hex colors, rgb/rgba/hsl/hsla colors, lengths, font stacks), and
 *    hoist values seen N+ times into top-of-file `$variables`.
 * 4. Render the trie back out as SCSS with 2-space indentation.
 *
 * @-rules — `@media`, `@supports`, `@keyframes`, etc. — keep their inner
 * children grouped, with the inner block itself nested via the same algorithm.
 */

export interface ConvertOptions {
  /** Minimum repeat count before a value is hoisted to a variable. Default 3. */
  variableMinOccurrences?: number;
  /** Indent unit (default two spaces). */
  indent?: string;
}

export interface ConvertResult {
  scss: string;
  variableCount: number;
  topLevelRuleCount: number;
}

/* ─── public API ──────────────────────────────────────────────────────── */

export function convertCssToScss(css: string, options: ConvertOptions = {}): ConvertResult {
  const indent = options.indent ?? '  ';
  const minOcc = options.variableMinOccurrences ?? 3;

  let root: Root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    logger.warn('convertCssToScss: parse failed', err instanceof Error ? err.message : String(err));
    throw new Error(`CSS parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 1: collect all value occurrences for variable extraction.
  const valueCounts = collectValueCounts(root);
  const varMap = buildVariableMap(valueCounts, minOcc);

  // Step 2: build a forest of nested blocks.
  const forest = buildForest(root, varMap);

  // Step 3: render.
  const out: string[] = [];
  if (varMap.size > 0) {
    out.push('// Extracted variables');
    // Stable order: by var name.
    const entries = [...varMap.entries()].sort(([, a], [, b]) => a.localeCompare(b));
    for (const [value, name] of entries) {
      out.push(`${name}: ${value};`);
    }
    out.push('');
  }

  for (const node of forest) {
    out.push(renderNode(node, 0, indent));
  }

  return {
    scss: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    variableCount: varMap.size,
    topLevelRuleCount: forest.length,
  };
}

/* ─── trie model ──────────────────────────────────────────────────────── */

type ForestNode = RuleBlock | AtRuleBlock | CommentBlock;

interface RuleBlock {
  kind: 'rule';
  /** The displayed selector for this block. For nested rules this is the
   * combinator + segment, e.g. `.btn` or `> .icon` or `&:hover`. */
  selector: string;
  declarations: { prop: string; value: string; important: boolean }[];
  children: ForestNode[];
}

interface AtRuleBlock {
  kind: 'atrule';
  name: string; // e.g. "media"
  params: string;
  declarations: { prop: string; value: string; important: boolean }[];
  children: ForestNode[];
}

interface CommentBlock {
  kind: 'comment';
  text: string;
}

/* ─── forest construction ────────────────────────────────────────────── */

function buildForest(root: Root, varMap: Map<string, string>): ForestNode[] {
  const forest: ForestNode[] = [];
  // Trie keyed by selector segment for top-level rules so we can nest.
  // The trie is rebuilt for each block (top-level / @media / etc.).
  const trieIndex = new Map<string, RuleBlock>();

  for (const node of root.nodes ?? []) {
    appendChild(node, forest, trieIndex, varMap);
  }
  return forest;
}

function appendChild(
  node: ChildNode,
  forest: ForestNode[],
  trieIndex: Map<string, RuleBlock>,
  varMap: Map<string, string>,
): void {
  if (node.type === 'comment') {
    forest.push({ kind: 'comment', text: (node as Comment).text });
    return;
  }
  if (node.type === 'atrule') {
    forest.push(convertAtRule(node as AtRule, varMap));
    return;
  }
  if (node.type === 'rule') {
    insertRule(node as Rule, forest, trieIndex, varMap);
    return;
  }
}

function convertAtRule(at: AtRule, varMap: Map<string, string>): AtRuleBlock {
  const block: AtRuleBlock = {
    kind: 'atrule',
    name: at.name,
    params: at.params,
    declarations: [],
    children: [],
  };
  // @keyframes children are rules with selectors like "from"/"to"/"50%".
  // We don't nest those further.
  const isKeyframes = /^(-\w+-)?keyframes$/.test(at.name);
  if (isKeyframes) {
    for (const child of at.nodes ?? []) {
      if (child.type === 'rule') {
        const r: RuleBlock = {
          kind: 'rule',
          selector: (child as Rule).selector,
          declarations: collectDecls(child as Rule, varMap),
          children: [],
        };
        block.children.push(r);
      } else if (child.type === 'comment') {
        block.children.push({ kind: 'comment', text: (child as Comment).text });
      }
    }
    return block;
  }

  const innerTrie = new Map<string, RuleBlock>();
  for (const child of at.nodes ?? []) {
    if (child.type === 'decl') {
      const d = child as Declaration;
      block.declarations.push({
        prop: d.prop,
        value: applyVars(d.value, varMap),
        important: !!d.important,
      });
    } else {
      appendChild(child as ChildNode, block.children, innerTrie, varMap);
    }
  }
  return block;
}

function insertRule(
  rule: Rule,
  forest: ForestNode[],
  trieIndex: Map<string, RuleBlock>,
  varMap: Map<string, string>,
): void {
  const selectors = splitSelectors(rule.selector);
  const decls = collectDecls(rule, varMap);

  // Multi-selector rules don't get nested — they're emitted as one combined
  // selector list. Source order is preserved by always appending to `forest`.
  if (selectors.length > 1) {
    forest.push({
      kind: 'rule',
      selector: selectors.join(', '),
      declarations: decls,
      children: [],
    });
    return;
  }

  const segments = splitIntoSegments(selectors[0]);
  if (segments.length === 0) return;

  // Walk/insert into the trie.
  let parentChildren: ForestNode[] = forest;
  let trie = trieIndex;
  let block: RuleBlock | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // For child segments we want the segment to start with `&` when it's
    // pseudo / adjacent (no whitespace) — handled in renderer via `seg.compound`.
    const key = i === 0 ? seg.text : seg.combinator + seg.text;
    block = trie.get(key);
    if (!block) {
      block = {
        kind: 'rule',
        selector: renderSegmentForBlock(seg, i === 0),
        declarations: [],
        children: [],
      };
      trie.set(key, block);
      parentChildren.push(block);
    }
    parentChildren = block.children;
    trie = childTrie(block);
  }

  if (block) {
    // Multiple CSS rules may share a selector — concatenate their decls.
    for (const d of decls) block.declarations.push(d);
  }
}

const childTrieMap = new WeakMap<RuleBlock, Map<string, RuleBlock>>();
function childTrie(block: RuleBlock): Map<string, RuleBlock> {
  let m = childTrieMap.get(block);
  if (!m) {
    m = new Map();
    childTrieMap.set(block, m);
  }
  return m;
}

/* ─── selector splitting ─────────────────────────────────────────────── */

/** Split a selector list (`.a, .b > .c`) respecting parentheses. */
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface Segment {
  /** Combinator preceding this segment: ' ', '>', '+', '~', or '' for the first. */
  combinator: string;
  /** The selector text for this level, e.g. `.btn`, `:hover`, `& + &`. */
  text: string;
  /** True if this segment glues onto the parent without whitespace (e.g. `:hover`, `.a.b`). */
  compound: boolean;
}

/**
 * Split a complex selector like `.card > .header:hover .icon` into segments.
 * Compound suffixes (`:hover`, `.a.b`, `[attr]`) become their own segments so
 * they can be nested with `&`.
 */
function splitIntoSegments(sel: string): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  let combinator = '';
  let buf = '';
  let depth = 0;

  const flush = (compoundChain = false) => {
    const t = buf.trim();
    if (t) {
      segs.push({ combinator, text: t, compound: compoundChain });
      combinator = ' ';
    }
    buf = '';
  };

  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;

    if (depth === 0 && /\s/.test(ch)) {
      flush();
      // Consume whitespace + optional combinator.
      while (i < sel.length && /\s/.test(sel[i])) i++;
      if (i < sel.length && (sel[i] === '>' || sel[i] === '+' || sel[i] === '~')) {
        combinator = sel[i];
        i++;
        while (i < sel.length && /\s/.test(sel[i])) i++;
      }
      continue;
    }

    // Compound break: pseudo or class/id/attr boundary AFTER something already in buf
    if (depth === 0 && buf.length > 0 && /^[A-Za-z0-9_-]/.test(buf[0]) === false && false) {
      // (placeholder — see logic below)
    }

    buf += ch;
    i++;
  }
  flush();

  // Second pass: split compound chains (`.a.b:hover`) into separate `&`-nested segments.
  // We only break when a segment is "complex" enough to be worth nesting.
  const expanded: Segment[] = [];
  for (const seg of segs) {
    const pieces = splitCompound(seg.text);
    if (pieces.length === 1) {
      expanded.push(seg);
    } else {
      expanded.push({ combinator: seg.combinator, text: pieces[0], compound: false });
      for (let k = 1; k < pieces.length; k++) {
        expanded.push({ combinator: '', text: pieces[k], compound: true });
      }
    }
  }
  return expanded;
}

/** Split `.a.b:hover[attr]` into `['.a', '.b', ':hover', '[attr]']`. */
function splitCompound(text: string): string[] {
  // If the segment starts with a tag/`*`/`&`, keep that as the first piece.
  const out: string[] = [];
  let i = 0;
  let buf = '';
  let depth = 0;
  // Leading element / universal / parent ref
  if (i < text.length && /[A-Za-z*&]/.test(text[i])) {
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i])) {
      buf += text[i++];
    }
    if (text[0] === '*' || text[0] === '&') {
      buf = text[0] + buf.slice(1);
    }
    out.push(buf);
    buf = '';
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    const isBoundary =
      depth === 0 &&
      buf.length > 0 &&
      (ch === '.' || ch === '#' || ch === ':' || ch === '[');
    if (isBoundary) {
      out.push(buf);
      buf = '';
    }
    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  // Filter empties (in case of unexpected input).
  return out.filter(Boolean);
}

function renderSegmentForBlock(seg: Segment, isFirst: boolean): string {
  if (isFirst) return seg.text;
  if (seg.compound) {
    // `:hover`, `.b`, `[attr]` → `&:hover`, `&.b`, `&[attr]`
    return `&${seg.text}`;
  }
  if (seg.combinator === ' ' || seg.combinator === '') return seg.text;
  return `${seg.combinator} ${seg.text}`;
}

/* ─── declarations + variable extraction ─────────────────────────────── */

function collectDecls(rule: Rule, varMap: Map<string, string>) {
  const out: { prop: string; value: string; important: boolean }[] = [];
  for (const child of rule.nodes ?? []) {
    if (child.type === 'decl') {
      const d = child as Declaration;
      out.push({
        prop: d.prop,
        value: applyVars(d.value, varMap),
        important: !!d.important,
      });
    }
    // Nested rules inside a CSS rule are technically invalid in plain CSS but
    // we silently drop them — they'll be re-emerged via the trie if present
    // as separate CSS rules.
  }
  return out;
}

/** Tokens we consider candidates for variable extraction. */
const VAR_VALUE_RE =
  /#[0-9a-f]{3,8}\b|\brgba?\([^)]+\)|\bhsla?\([^)]+\)|\b\d*\.?\d+(px|rem|em|%|vh|vw|s|ms|deg)\b/gi;

function collectValueCounts(root: Root): Map<string, number> {
  const counts = new Map<string, number>();
  root.walkDecls((d) => {
    const matches = d.value.match(VAR_VALUE_RE);
    if (!matches) return;
    for (const m of matches) {
      const norm = m.trim();
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  });
  return counts;
}

function buildVariableMap(counts: Map<string, number>, minOcc: number): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  // Sort: colors first, then by descending count for deterministic naming.
  const sorted = [...counts.entries()]
    .filter(([, c]) => c >= minOcc)
    .sort((a, b) => b[1] - a[1]);

  let colorIdx = 1;
  let lengthIdx = 1;
  let timeIdx = 1;
  for (const [value] of sorted) {
    let name: string;
    if (/^#|rgba?\(|hsla?\(/i.test(value)) {
      name = uniqueName(`$color-${colorIdx++}`, used);
    } else if (/(ms|s)$/i.test(value)) {
      name = uniqueName(`$time-${timeIdx++}`, used);
    } else {
      name = uniqueName(`$size-${lengthIdx++}`, used);
    }
    map.set(value, name);
    used.add(name);
  }
  return map;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function applyVars(value: string, varMap: Map<string, string>): string {
  if (varMap.size === 0) return value;
  return value.replace(VAR_VALUE_RE, (match) => varMap.get(match) ?? match);
}

/* ─── renderer ───────────────────────────────────────────────────────── */

function renderNode(node: ForestNode, depth: number, indent: string): string {
  const pad = indent.repeat(depth);
  if (node.kind === 'comment') {
    return `${pad}/*${node.text}*/`;
  }
  if (node.kind === 'atrule') {
    const head = `${pad}@${node.name}${node.params ? ' ' + node.params : ''} {`;
    const body: string[] = [];
    for (const d of node.declarations) {
      body.push(`${pad}${indent}${d.prop}: ${d.value}${d.important ? ' !important' : ''};`);
    }
    for (const child of node.children) {
      body.push(renderNode(child, depth + 1, indent));
    }
    if (body.length === 0) return `${head}}`;
    return `${head}\n${body.join('\n')}\n${pad}}`;
  }
  // rule
  const head = `${pad}${node.selector} {`;
  const body: string[] = [];
  for (const d of node.declarations) {
    body.push(`${pad}${indent}${d.prop}: ${d.value}${d.important ? ' !important' : ''};`);
  }
  for (const child of node.children) {
    body.push(renderNode(child, depth + 1, indent));
  }
  if (body.length === 0) return `${head}}`;
  return `${head}\n${body.join('\n')}\n${pad}}`;
}
