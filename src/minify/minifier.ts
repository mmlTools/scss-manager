import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as sass from 'sass';
import { logger } from '../utils/logger';

export interface MinifyOptions {
  /** Absolute path of the source SCSS/SASS file. */
  sourcePath: string;
  /** Whether to also emit a `.css.map` source map next to the output. */
  emitSourceMap: boolean;
  /**
   * Where the minified `.css` should be written.
   *
   * - If empty/undefined: written next to the source as `<name>.min.css`.
   * - If a relative path: resolved against the source's workspace folder.
   * - If absolute: used as-is.
   *
   * If the value points to a directory (no `.css` extension), the output is
   * placed inside that directory using `<sourceName>.min.css`.
   */
  outputPath?: string;
  /** Optional file-name suffix; defaults to `.min`. Ignored when outputPath is a file. */
  suffix?: string;
}

export interface MinifyResult {
  outputPath: string;
  mapPath?: string;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Compile + minify a single SCSS/SASS file.
 *
 * Uses dart-sass with `style: 'compressed'`, which produces minified CSS and
 * (optionally) a v3 source map.
 */
export async function minifyScssFile(opts: MinifyOptions): Promise<MinifyResult> {
  const src = opts.sourcePath;
  const suffix = opts.suffix ?? '.min';
  const outPath = resolveOutputPath(src, opts.outputPath, suffix);
  const mapPath = opts.emitSourceMap ? outPath + '.map' : undefined;

  const compiled = sass.compile(src, {
    style: 'compressed',
    sourceMap: !!mapPath,
    sourceMapIncludeSources: true,
    loadPaths: [path.dirname(src)],
  });

  let css = compiled.css;
  if (mapPath && compiled.sourceMap) {
    css += `\n/*# sourceMappingURL=${path.basename(mapPath)} */`;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, css, 'utf8');

  let bytesOut = Buffer.byteLength(css, 'utf8');
  if (mapPath && compiled.sourceMap) {
    const mapJson = JSON.stringify(compiled.sourceMap);
    await fs.writeFile(mapPath, mapJson, 'utf8');
    bytesOut += Buffer.byteLength(mapJson, 'utf8');
  }

  const srcStat = await fs.stat(src);
  return {
    outputPath: outPath,
    mapPath: mapPath && compiled.sourceMap ? mapPath : undefined,
    bytesIn: srcStat.size,
    bytesOut,
  };
}

/** Resolve the final on-disk path for the minified output. */
function resolveOutputPath(
  sourcePath: string,
  configured: string | undefined,
  suffix: string,
): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const defaultName = `${base}${suffix}.css`;

  if (!configured || !configured.trim()) {
    return path.join(path.dirname(sourcePath), defaultName);
  }

  let resolved = configured.trim();
  if (!path.isAbsolute(resolved)) {
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourcePath));
    const root = ws?.uri.fsPath ?? path.dirname(sourcePath);
    resolved = path.join(root, resolved);
  }

  // If the configured path ends in `.css`, treat as a full file path.
  if (resolved.toLowerCase().endsWith('.css')) {
    return resolved;
  }
  // Otherwise treat as a directory.
  return path.join(resolved, defaultName);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** High-level wrapper used by the command + auto-save hook. */
export async function minifyDocument(uri: vscode.Uri): Promise<MinifyResult | undefined> {
  const cfg = vscode.workspace.getConfiguration('scssManager');
  if (!cfg.get<boolean>('minify.enabled', true)) return undefined;

  try {
    const result = await minifyScssFile({
      sourcePath: uri.fsPath,
      emitSourceMap: cfg.get<boolean>('minify.sourceMap', false),
      outputPath: cfg.get<string>('minify.outputPath', ''),
      suffix: cfg.get<string>('minify.suffix', '.min'),
    });
    logger.info(
      `Minified ${path.basename(uri.fsPath)} → ${path.basename(result.outputPath)} ` +
        `(${formatBytes(result.bytesIn)} → ${formatBytes(result.bytesOut)})`,
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Minify failed for ${uri.fsPath}`, e);
    throw new Error(msg);
  }
}
