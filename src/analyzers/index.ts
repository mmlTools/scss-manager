import * as vscode from 'vscode';
import { ScanResult, ScssRoot, Suggestion } from '../types';
import { collectStatistics } from './statisticsCollector';
import { analyzeNesting } from './nestingAnalyzer';
import { analyzeVariables } from './variableAnalyzer';
import { analyzeDuplicates } from './duplicateAnalyzer';
import { analyzeRedundancy } from './redundancyAnalyzer';
import { logger } from '../utils/logger';

export function runAllAnalyzers(asts: Map<string, ScssRoot>, scanDurationMs: number): ScanResult {
  const cfg = vscode.workspace.getConfiguration('scssManager');
  const suggestions: Suggestion[] = [];

  try {
    suggestions.push(
      ...analyzeNesting(asts, {
        maxDepth: cfg.get<number>('nesting.maxDepth', 4),
        minChildren: cfg.get<number>('nesting.minChildren', 2),
      }),
    );
  } catch (e) {
    logger.error('nesting analyzer failed', e);
  }

  try {
    suggestions.push(
      ...analyzeVariables(asts, {
        minOccurrences: cfg.get<number>('variables.minOccurrences', 3),
        namingStrategy: cfg.get<'semantic-ai' | 'literal' | 'hash'>('variables.namingStrategy', 'semantic-ai'),
      }),
    );
  } catch (e) {
    logger.error('variable analyzer failed', e);
  }

  try {
    suggestions.push(
      ...analyzeDuplicates(asts, {
        minSharedDeclarations: cfg.get<number>('duplicates.minSharedDeclarations', 3),
        similarityThreshold: cfg.get<number>('duplicates.similarityThreshold', 0.85),
      }),
    );
  } catch (e) {
    logger.error('duplicate analyzer failed', e);
  }

  try {
    suggestions.push(...analyzeRedundancy(asts));
  } catch (e) {
    logger.error('redundancy analyzer failed', e);
  }

  const statistics = collectStatistics(asts, scanDurationMs);

  return { statistics, suggestions, asts };
}
