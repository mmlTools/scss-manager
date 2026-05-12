import * as vscode from 'vscode';
import { Suggestion } from '../types';
import { workspaceRelative } from '../utils/editor';

let panel: vscode.WebviewPanel | undefined;

export function showSuggestionPanel(
  context: vscode.ExtensionContext,
  suggestion: Suggestion,
  callbacks: {
    onApply: (id: string) => Promise<void>;
    onAiRefactor: (id: string) => Promise<void>;
    onReveal: (filePath: string, line: number, col: number) => Promise<void>;
  },
): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'scssManagerSuggestion',
      'SCSS Suggestion',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || typeof msg !== 'object') return;
        try {
          if (msg.type === 'apply' && typeof msg.id === 'string') {
            await callbacks.onApply(msg.id);
          } else if (msg.type === 'ai-refactor' && typeof msg.id === 'string') {
            await callbacks.onAiRefactor(msg.id);
          } else if (msg.type === 'reveal' && msg.location) {
            await callbacks.onReveal(msg.location.filePath, msg.location.line, msg.location.column);
          }
        } catch (e) {
          vscode.window.showErrorMessage(`SCSS Manager: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      undefined,
      context.subscriptions,
    );
  }

  panel.title = truncate(suggestion.title, 40);
  panel.webview.html = renderHtml(suggestion);
  panel.reveal(vscode.ViewColumn.Beside, true);
}

export function closeSuggestionPanel(): void {
  panel?.dispose();
}

/* ─── HTML rendering ──────────────────────────────────────────────────────── */

function renderHtml(s: Suggestion): string {
  const css = baseCss();
  const detailHtml = renderSuggestionBody(s);

  const canApplyDirect = s.safeAutoApply;
  const showAiButton = !s.safeAutoApply || s.kind === 'variable' || s.kind === 'duplicate';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>${css}</style>
</head>
<body>
  <header>
    <span class="badge badge-${escapeAttr(s.severity)}">${labelForKind(s.kind)}</span>
    <h1>${escapeHtml(s.title)}</h1>
    <p class="description">${escapeHtml(s.description)}</p>
  </header>

  <main>
    ${detailHtml}

    <section class="locations">
      <h2>Locations (${s.locations.length})</h2>
      <ul>
        ${s.locations
          .map(
            (loc) => `
          <li>
            <a class="loc" data-action="reveal"
               data-filepath="${escapeAttr(loc.filePath)}"
               data-line="${loc.range.start.line}"
               data-col="${loc.range.start.column}">
              <span class="loc-path">${escapeHtml(workspaceRelative(loc.filePath))}</span>
              <span class="loc-line">:${loc.range.start.line + 1}</span>
            </a>
          </li>`,
          )
          .join('')}
      </ul>
    </section>
  </main>

  <footer>
    <div class="meta">
      ${s.estimatedLinesSaved > 0 ? `<span>${s.estimatedLinesSaved} line${s.estimatedLinesSaved === 1 ? '' : 's'} saved</span>` : ''}
      ${s.safeAutoApply ? '<span class="safe">✓ Safe to auto-apply</span>' : '<span class="ai-only">Needs review or AI</span>'}
    </div>
    <div class="buttons">
      ${canApplyDirect ? `<button class="primary" data-action="apply">Apply</button>` : ''}
      ${showAiButton ? `<button class="${canApplyDirect ? '' : 'primary'}" data-action="ai-refactor">✨ Apply with AI</button>` : ''}
    </div>
  </footer>

<script>
(() => {
  const vscode = acquireVsCodeApi();
  const id = ${JSON.stringify(s.id)};

  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'apply') {
      vscode.postMessage({ type: 'apply', id });
    } else if (action === 'ai-refactor') {
      vscode.postMessage({ type: 'ai-refactor', id });
    } else if (action === 'reveal') {
      vscode.postMessage({
        type: 'reveal',
        location: {
          filePath: target.getAttribute('data-filepath'),
          line: Number(target.getAttribute('data-line')),
          column: Number(target.getAttribute('data-col')),
        },
      });
    }
  });
})();
</script>
</body>
</html>`;
}

function renderSuggestionBody(s: Suggestion): string {
  if (s.kind === 'nesting') {
    return `
      <section>
        <h2>Proposed nested rule</h2>
        <pre><code>${escapeHtml(s.proposedText)}</code></pre>
      </section>
      <section>
        <h3>What this does</h3>
        <p>Combines ${s.locations.length} top-level rules that all extend
        <code>${escapeHtml(s.parentSelector)}</code> into one nested block.</p>
      </section>
    `;
  }
  if (s.kind === 'variable') {
    return `
      <section>
        <h2>Proposed variable</h2>
        <pre><code>${escapeHtml(s.proposedName)}: ${escapeHtml(s.value)};</code></pre>
        <p>Will replace <strong>${s.occurrences}</strong> literal occurrence${s.occurrences === 1 ? '' : 's'} of
        <code>${escapeHtml(s.value)}</code> with <code>${escapeHtml(s.proposedName)}</code>.</p>
      </section>
      <section>
        <h3>Naming</h3>
        <p>If AI is available and "ai.enableAutoNaming" is on, the name above
        may be replaced with a semantic suggestion (e.g. <code>$brand-primary</code>)
        when you click "Apply".</p>
      </section>
    `;
  }
  if (s.kind === 'duplicate') {
    const decls = s.sharedDeclarations
      .map((d) => `  ${escapeHtml(d.property)}: ${escapeHtml(d.value)};`)
      .join('\n');
    return `
      <section>
        <h2>Shared declarations</h2>
        <pre><code>${decls}</code></pre>
        <p>Similarity: <strong>${(s.similarity * 100).toFixed(0)}%</strong></p>
      </section>
      <section>
        <h3>Suggested strategy: <code>${s.strategy}</code></h3>
        ${strategyExplanation(s.strategy)}
      </section>
    `;
  }
  if (s.kind === 'redundancy') {
    return `
      <section>
        <h2>Issue</h2>
        <p>${escapeHtml(reasonText(s.reason))}</p>
      </section>
    `;
  }
  return '';
}

function strategyExplanation(strategy: 'extend' | 'merge' | 'mixin'): string {
  if (strategy === 'merge')
    return '<p>Both rules have identical declarations. They can be merged into one rule with a comma-separated selector list.</p>';
  if (strategy === 'extend')
    return '<p>The rules share most declarations. One can <code>@extend</code> the other so the shared declarations live in a single place.</p>';
  return '<p>The rules share many declarations. Extracting them into a <code>@mixin</code> keeps both rules independent while removing duplication.</p>';
}

function reasonText(r: 'duplicate-declaration' | 'empty-rule' | 'overridden-shorthand'): string {
  if (r === 'empty-rule') return 'This rule has no declarations and no nested rules. It produces no CSS output.';
  if (r === 'duplicate-declaration') return 'The same property and value appear twice in the same rule. The earlier line is dead code.';
  return 'The same property is declared multiple times with different values. The last one wins; verify the earlier ones are intentional fallbacks.';
}

function labelForKind(k: string): string {
  switch (k) {
    case 'nesting': return 'Nesting';
    case 'variable': return 'Variable';
    case 'duplicate': return 'Duplicate';
    case 'redundancy': return 'Redundancy';
    default: return k;
  }
}

function baseCss(): string {
  return `
:root { color-scheme: var(--vscode-color-scheme); }
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 0;
  line-height: 1.5;
}
header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
header h1 {
  font-size: 1.2em;
  font-weight: 600;
  margin: 6px 0 4px;
}
.description {
  color: var(--vscode-descriptionForeground);
  margin: 0;
}
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 8px;
  font-size: 0.8em;
  font-weight: 500;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.badge-warning { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.badge-error { background: var(--vscode-editorError-foreground); color: var(--vscode-editor-background); }
main {
  padding: 12px 20px 20px;
}
section { margin: 16px 0; }
h2 { font-size: 1em; font-weight: 600; margin: 0 0 8px; }
h3 { font-size: 0.95em; font-weight: 600; margin: 12px 0 4px; }
pre {
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.95em;
  white-space: pre;
}
code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.95em;
}
ul { padding-left: 0; list-style: none; }
li { margin: 4px 0; }
.loc {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  cursor: pointer;
}
.loc:hover { text-decoration: underline; }
.loc-line { color: var(--vscode-descriptionForeground); }
footer {
  position: sticky;
  bottom: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; display: flex; gap: 12px; }
.safe { color: var(--vscode-editorInfo-foreground); }
.ai-only { color: var(--vscode-editorWarning-foreground); }
.buttons { display: flex; gap: 8px; }
button {
  font-family: inherit;
  font-size: 0.95em;
  padding: 6px 14px;
  border-radius: 3px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
