import postcss from 'postcss';
// postcss-scss has no types; import as any.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const scssSyntax = require('postcss-scss');

import {
  ScssAtRule,
  ScssComment,
  ScssDeclaration,
  ScssNode,
  ScssRoot,
  ScssRule,
  SourceRange,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Parse SCSS source into our normalized AST. Returns a root with `children`
 * already linked to their parents.
 *
 * Robust against syntax errors: if postcss fails, returns an empty root with
 * the original source preserved so callers can still inspect it.
 */
export function parseScss(source: string, filePath: string): ScssRoot {
  const root: ScssRoot = {
    kind: 'root',
    filePath,
    children: [],
    source,
  };

  let parsed: postcss.Root;
  try {
    parsed = postcss().process(source, { syntax: scssSyntax, from: filePath }).root;
  } catch (err) {
    logger.warn(`parseScss: failed to parse ${filePath}`, err instanceof Error ? err.message : String(err));
    return root;
  }

  for (const node of parsed.nodes) {
    const converted = convertNode(node, source, root);
    if (converted) root.children.push(converted);
  }

  return root;
}

/* ─── conversion ──────────────────────────────────────────────────────────── */

function convertNode(node: postcss.Node, source: string, parent: ScssNode): ScssNode | undefined {
  const range = computeRange(node, source);

  switch (node.type) {
    case 'rule': {
      const rule = node as postcss.Rule;
      const out: ScssRule = {
        kind: 'rule',
        selector: rule.selector,
        selectors: rule.selectors ?? splitSelectors(rule.selector),
        children: [],
        range,
        parent,
      };
      if (rule.nodes) {
        for (const child of rule.nodes) {
          const c = convertNode(child, source, out);
          if (c) out.children.push(c);
        }
      }
      return out;
    }

    case 'decl': {
      const decl = node as postcss.Declaration;
      const out: ScssDeclaration = {
        kind: 'decl',
        property: decl.prop,
        value: decl.value,
        important: decl.important === true,
        range,
        parent,
      };
      return out;
    }

    case 'atrule': {
      const at = node as postcss.AtRule;
      const out: ScssAtRule = {
        kind: 'atrule',
        name: at.name,
        params: at.params,
        children: [],
        range,
        parent,
      };
      if (at.nodes) {
        for (const child of at.nodes) {
          const c = convertNode(child, source, out);
          if (c) out.children.push(c);
        }
      }
      return out;
    }

    case 'comment': {
      const cm = node as postcss.Comment;
      const out: ScssComment = {
        kind: 'comment',
        text: cm.text,
        range,
        parent,
      };
      return out;
    }

    default:
      return undefined;
  }
}

function computeRange(node: postcss.Node, source: string): SourceRange {
  // postcss uses 1-based lines AND 1-based columns. VS Code uses 0-based for
  // both. Convert. `end` is inclusive in postcss → we add 1 to column to make
  // an exclusive range matching VS Code's semantics.
  const startLine = (node.source?.start?.line ?? 1) - 1;
  const startCol = (node.source?.start?.column ?? 1) - 1;
  const endLine = (node.source?.end?.line ?? startLine + 1) - 1;
  const endCol = (node.source?.end?.column ?? startCol + 1);

  const startOffset = lineColToOffset(source, startLine, startCol);
  const endOffset = lineColToOffset(source, endLine, endCol);

  return {
    start: { line: startLine, column: startCol, offset: startOffset },
    end: { line: endLine, column: endCol, offset: endOffset },
  };
}

function lineColToOffset(source: string, line: number, col: number): number {
  let offset = 0;
  let currentLine = 0;
  for (let i = 0; i < source.length; i++) {
    if (currentLine === line) {
      return offset + col;
    }
    if (source[i] === '\n') {
      currentLine++;
    }
    offset++;
  }
  return source.length;
}

function splitSelectors(s: string): string[] {
  return s.split(',').map((p) => p.trim()).filter(Boolean);
}

/* ─── traversal helpers ───────────────────────────────────────────────────── */

export function walk(node: ScssNode, visit: (n: ScssNode) => void): void {
  visit(node);
  const kids = (node as ScssRule | ScssAtRule | ScssRoot).children;
  if (Array.isArray(kids)) {
    for (const c of kids) walk(c, visit);
  }
}

export function* allRules(node: ScssNode): IterableIterator<ScssRule> {
  if (node.kind === 'rule') yield node;
  const kids = (node as ScssRule | ScssAtRule | ScssRoot).children;
  if (Array.isArray(kids)) {
    for (const c of kids) yield* allRules(c);
  }
}

export function* allDeclarations(node: ScssNode): IterableIterator<ScssDeclaration> {
  if (node.kind === 'decl') yield node;
  const kids = (node as ScssRule | ScssAtRule | ScssRoot).children;
  if (Array.isArray(kids)) {
    for (const c of kids) yield* allDeclarations(c);
  }
}

export function* allAtRules(node: ScssNode): IterableIterator<ScssAtRule> {
  if (node.kind === 'atrule') yield node;
  const kids = (node as ScssRule | ScssAtRule | ScssRoot).children;
  if (Array.isArray(kids)) {
    for (const c of kids) yield* allAtRules(c);
  }
}
