import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('SCSS Manager');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    getChannel().appendLine(`[${ts()}] [info] ${msg}${formatArgs(args)}`);
  },
  warn(msg: string, ...args: unknown[]): void {
    getChannel().appendLine(`[${ts()}] [warn] ${msg}${formatArgs(args)}`);
  },
  error(msg: string, err?: unknown): void {
    const detail =
      err instanceof Error ? `\n  ${err.stack ?? err.message}` : err !== undefined ? ` ${JSON.stringify(err)}` : '';
    getChannel().appendLine(`[${ts()}] [error] ${msg}${detail}`);
  },
  show(preserveFocus = true): void {
    getChannel().show(preserveFocus);
  },
};

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}
