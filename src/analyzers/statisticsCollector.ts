import { ProjectStatistics, ScssNode, ScssRoot } from '../types';
import { allAtRules, allDeclarations, allRules } from '../parser/scssParser';

export function collectStatistics(asts: Map<string, ScssRoot>, scanDurationMs: number): ProjectStatistics {
  let totalLines = 0;
  let totalSelectors = 0;
  let totalDeclarations = 0;
  let totalVariables = 0;
  let totalMixins = 0;
  let maxNestingDepth = 0;
  let depthSum = 0;
  let depthSamples = 0;

  for (const ast of asts.values()) {
    totalLines += countLines(ast.source);

    for (const rule of allRules(ast)) {
      totalSelectors += rule.selectors.length;
      const depth = computeDepth(rule);
      if (depth > maxNestingDepth) maxNestingDepth = depth;
      depthSum += depth;
      depthSamples++;
    }

    for (const decl of allDeclarations(ast)) {
      totalDeclarations++;
      if (decl.property.startsWith('$')) {
        totalVariables++;
      }
    }

    for (const at of allAtRules(ast)) {
      if (at.name === 'mixin') totalMixins++;
    }
  }

  return {
    filesScanned: asts.size,
    totalLines,
    totalSelectors,
    totalDeclarations,
    totalVariables,
    totalMixins,
    maxNestingDepth,
    averageNestingDepth: depthSamples === 0 ? 0 : depthSum / depthSamples,
    scanDurationMs,
    scannedAt: Date.now(),
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') count++;
  return count;
}

function computeDepth(node: ScssNode): number {
  let depth = 0;
  let current: ScssNode | undefined = node.parent;
  while (current) {
    if (current.kind === 'rule') depth++;
    current = (current as ScssNode).parent;
  }
  return depth;
}
