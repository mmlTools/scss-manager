import * as vscode from 'vscode';
import { ScssRoot } from '../types';
import { parseScss } from './scssParser';
import { logger } from '../utils/logger';

export interface ScanOptions {
  include: string[];
  exclude: string[];
  maxFiles?: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  currentFile?: string;
}

/**
 * Scan all files in the workspace matching the include/exclude globs and
 * return parsed ASTs. Uses vscode.workspace.findFiles so it respects the
 * VS Code file watcher exclusions automatically.
 */
export async function scanProject(
  options: ScanOptions,
  onProgress?: (p: ScanProgress) => void,
  token?: vscode.CancellationToken,
): Promise<Map<string, ScssRoot>> {
  const result = new Map<string, ScssRoot>();

  const includeGlob = options.include.length === 1 ? options.include[0] : `{${options.include.join(',')}}`;
  const excludeGlob = options.exclude.length === 0 ? null : `{${options.exclude.join(',')}}`;

  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(includeGlob, excludeGlob, options.maxFiles ?? 5000, token);
  } catch (e) {
    logger.error('findFiles failed', e);
    return result;
  }

  logger.info(`Scanning ${uris.length} files matching ${includeGlob}`);

  let i = 0;
  for (const uri of uris) {
    if (token?.isCancellationRequested) break;
    i++;
    onProgress?.({ scanned: i, total: uris.length, currentFile: uri.fsPath });

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const source = Buffer.from(bytes).toString('utf-8');
      const ast = parseScss(source, uri.fsPath);
      result.set(uri.fsPath, ast);
    } catch (e) {
      logger.warn(`Failed to read ${uri.fsPath}`, e instanceof Error ? e.message : String(e));
    }
  }

  return result;
}
