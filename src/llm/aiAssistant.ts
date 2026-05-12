import * as vscode from 'vscode';
import { logger } from '../utils/logger';

const LM_ID = 'scss-manager';

/**
 * Select a language model based on user preferences. Falls through a chain:
 *   preferred → claude-3.5-sonnet → gpt-4o → gpt-4 → any copilot → any.
 * Returns undefined if no LM provider is installed.
 */
export async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  // Some older VS Code builds may not expose vscode.lm.
  const lm = (vscode as unknown as { lm?: typeof vscode.lm }).lm;
  if (!lm || typeof lm.selectChatModels !== 'function') return undefined;

  const cfg = vscode.workspace.getConfiguration('scssManager');
  const preference = cfg.get<string>('ai.languageModel', 'auto');

  const tryPick = async (selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat | undefined> => {
    try {
      const models = await vscode.lm.selectChatModels(selector);
      return models[0];
    } catch (e) {
      logger.warn('selectChatModels failed', e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };

  // Explicit preference first.
  if (preference === 'copilot-claude') {
    const m = await tryPick({ vendor: 'copilot', family: 'claude-3.5-sonnet' });
    if (m) return m;
  } else if (preference === 'copilot-gpt-4o') {
    const m = await tryPick({ vendor: 'copilot', family: 'gpt-4o' });
    if (m) return m;
  } else if (preference === 'copilot-gpt-4') {
    const m = await tryPick({ vendor: 'copilot', family: 'gpt-4' });
    if (m) return m;
  }

  // Fallback chain.
  for (const sel of [
    { vendor: 'copilot', family: 'claude-3.5-sonnet' },
    { vendor: 'copilot', family: 'gpt-4o' },
    { vendor: 'copilot', family: 'gpt-4' },
    { vendor: 'copilot' },
    {},
  ] satisfies vscode.LanguageModelChatSelector[]) {
    const m = await tryPick(sel);
    if (m) return m;
  }

  return undefined;
}

/**
 * Whether AI features are currently available (model + extension API present).
 */
export async function isAiAvailable(): Promise<boolean> {
  const model = await selectModel();
  return model !== undefined;
}

/**
 * Send messages, accumulate the streamed text response, and return it.
 */
async function streamRequest(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<string> {
  const response = await model.sendRequest(messages, {}, token);
  let out = '';
  for await (const fragment of response.text) {
    if (token.isCancellationRequested) break;
    out += fragment;
  }
  return out;
}

function stripCodeFences(text: string): string {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/m;
  const m = t.match(fence);
  if (m) t = m[1];
  return t.trim();
}

/**
 * Suggest a semantic variable name for a value with sample contexts.
 */
export async function suggestVariableName(
  value: string,
  contexts: Array<{ property: string; selector: string }>,
  existingNames: string[],
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  const model = await selectModel();
  if (!model) return undefined;

  const ctxSample = contexts
    .slice(0, 5)
    .map((c) => `  - selector "${c.selector}" → property "${c.property}"`)
    .join('\n');

  const prompt = `You are naming an SCSS variable. The value "${value}" is used in these contexts:
${ctxSample}

Existing variable names in this project (do not collide): ${existingNames.slice(0, 30).join(', ') || '(none)'}

Propose a single semantic variable name in kebab-case, starting with $.
Examples: $brand-primary, $spacing-md, $shadow-card, $font-display.
Respond with ONLY the variable name, nothing else.`;

  try {
    const text = await streamRequest(
      model,
      [vscode.LanguageModelChatMessage.User(prompt)],
      token,
    );
    const cleaned = text.trim().split(/\s/)[0];
    if (!cleaned.startsWith('$')) return undefined;
    if (!/^\$[a-z][a-z0-9_-]*$/i.test(cleaned)) return undefined;
    return cleaned;
  } catch (e) {
    logger.warn('suggestVariableName failed', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/**
 * Ask the model to refactor an arbitrary SCSS snippet. Returns the refactored
 * code or undefined on failure. Goal is broad: nest where natural, extract
 * variables, deduplicate, but do NOT change visual behavior.
 */
export async function refactorSnippet(
  scssSource: string,
  context: string,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  const model = await selectModel();
  if (!model) {
    promptInstallCopilot();
    return undefined;
  }

  const prompt = `You are an SCSS refactoring assistant.

Refactor the SCSS below to be more idiomatic. Apply these transformations where appropriate:
- Use nesting to remove repeated parent selectors (and "&" for pseudo-classes/compound selectors)
- Extract repeated literal values into variables declared at the top of the snippet
- Use @extend or @mixin when two rule blocks share many declarations
- Remove duplicate declarations within a single rule
- DO NOT change visual behavior: same selectors must produce the same computed styles

Context: ${context || 'general project SCSS'}

INPUT:
\`\`\`scss
${scssSource}
\`\`\`

Respond with ONLY the refactored SCSS in a single fenced code block. Do NOT include explanations.`;

  try {
    const text = await streamRequest(
      model,
      [vscode.LanguageModelChatMessage.User(prompt)],
      token,
    );
    const out = stripCodeFences(text);
    if (out.length === 0) return undefined;
    return out;
  } catch (e) {
    logger.error('refactorSnippet failed', e);
    if (e instanceof vscode.LanguageModelError) {
      vscode.window.showWarningMessage(`AI request failed: ${e.message}`);
    }
    return undefined;
  }
}

let installPromptShown = false;
function promptInstallCopilot(): void {
  if (installPromptShown) return;
  installPromptShown = true;
  vscode.window
    .showWarningMessage(
      'SCSS Manager: No language model available. Install GitHub Copilot Chat to enable AI features.',
      'Install Copilot Chat',
      'Dismiss',
    )
    .then((choice) => {
      if (choice === 'Install Copilot Chat') {
        vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          'GitHub.copilot-chat',
        );
      }
    });
}

export { LM_ID };
