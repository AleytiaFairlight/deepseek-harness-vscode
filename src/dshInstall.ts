import * as child_process from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DshAcp } from './dshAcp';

export const DSH_NPM_SPEC = '@deepseek-ai/dsh@0.2.2-rc.5';
const REQUIRED_NODE_MAJOR = 24;

/** `dsh` if runnable, else '' (never throws). */
export function probeDsh(cliPath: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const child = child_process.spawn(cliPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? out.trim().slice(0, 60) : ''));
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve('');
    }, timeoutMs + 2000);
  });
}

function execProbe(cmd: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    child_process.execFile(cmd, args, { timeout: timeoutMs }, (err: any, stdout: any) => {
      if (err) return resolve('');
      resolve(String(stdout || '').trim());
    });
  });
}

async function nodeMajor(): Promise<number> {
  const out = await execProbe('node', ['--version']);
  const m = out.match(/v(\d+)\./);
  return m ? parseInt(m[1], 10) : 0;
}

/** Ensure the dsh CLI exists on boot; install globally via npm when missing. Never throws. */
export async function ensureDshOnBoot(
  context: vscode.ExtensionContext,
  dsh: DshAcp,
  output: vscode.OutputChannel,
  onReady: () => void
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('deepseekHarness');
  if (cfg.get<boolean>('autoInstallDsh', true) === false) {
    output.appendLine('[dsh] auto-install disabled (deepseekHarness.autoInstallDsh=false).');
    return;
  }
  const cliPath = cfg.get<string>('cliPath', 'dsh') || 'dsh';
  const existing = await probeDsh(cliPath);
  if (existing) {
    output.appendLine(`[dsh] CLI ready: ${cliPath} (${existing})`);
    return;
  }
  output.appendLine(`[dsh] CLI not runnable ("${cliPath}"). Attempting global install: npm i -g ${DSH_NPM_SPEC}`);
  const major = await nodeMajor();
  if (major && major < REQUIRED_NODE_MAJOR) {
    const msg = `dsh needs Node.js >=${REQUIRED_NODE_MAJOR}, but "node --version" reports ${major}. Install Node 24 LTS from https://nodejs.org, restart VS Code, then run DSH: Install dsh CLI. Falling back until then.`;
    output.appendLine(`[dsh] ${msg}`);
    const open = 'Download Node.js';
    void vscode.window.showWarningMessage(`DeepSeek Harness: ${msg}`, open, 'DSH: Install dsh CLI Anyway').then((v) => {
      if (v === open) void vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
      else if (v === 'DSH: Install dsh CLI Anyway') void vscode.commands.executeCommand('deepseekHarness.installDsh');
    });
    return;
  }
  await installDsh(context, dsh, output, onReady, false);
}

/** Manual (or retried) global install of the dsh CLI. Never throws. */
export async function installDsh(
  context: vscode.ExtensionContext,
  dsh: DshAcp,
  output: vscode.OutputChannel,
  onReady: () => void,
  interactive = true
): Promise<void> {
  const npmCmd = await findNpm();
  if (!npmCmd) {
    const msg = 'npm not found on PATH. Install Node.js 24 LTS from https://nodejs.org/ (includes npm), restart VS Code, and retry.';
    output.appendLine(`[dsh] ${msg}`);
    if (interactive) void vscode.window.showWarningMessage(`DeepSeek Harness: ${msg}`);
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing dsh CLI (${DSH_NPM_SPEC})…`, cancellable: true },
      async (_progress, token) => {
        await new Promise<void>((resolve, reject) => {
          output.appendLine(`[dsh] running: ${npmCmd} install -g ${DSH_NPM_SPEC} --no-audit --no-fund`);
          const child = child_process.spawn(npmCmd, ['install', '-g', DSH_NPM_SPEC, '--no-audit', '--no-fund'], {
            shell: process.platform === 'win32',
            timeout: 6 * 60 * 1000,
          });
          token.onCancellationRequested(() => {
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error('cancelled by user'));
          });
          child.stdout?.on('data', (d) => output.append(String(d).slice(0, 2000)));
          child.stderr?.on('data', (d) => output.append(String(d).slice(0, 2000)));
          child.on('error', (e) => reject(e));
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm exited with code ${code}`))));
        });
      }
    );
  } catch (e) {
    const msg = `dsh install failed: ${(e as Error).message}. See Output → DeepSeek Harness for npm output.`;
    output.appendLine(`[dsh] ${msg}`);
    if (interactive) void vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`);
    return;
  }
  // Validate: bare `dsh` first (global bin dir is usually on PATH)…
  const direct = await probeDsh('dsh');
  if (direct) {
    output.appendLine(`[dsh] installed + verified: dsh (${direct})`);
    await finishInstall(context, dsh, 'dsh', direct, onReady, interactive);
    return;
  }
  // …else resolve the global bin dir and point deepseekHarness.cliPath at the full path.
  const binDir = await execProbe(npmCmd, ['bin', '-g']).catch(() => '');
  const full = binDir ? path.join(binDir.trim(), process.platform === 'win32' ? 'dsh.cmd' : 'dsh') : '';
  const validated = full ? await probeDsh(full) : '';
  if (validated) {
    output.appendLine(`[dsh] installed at ${full} (${validated}); global bin dir is not on PATH, saving full path to deepseekHarness.cliPath.`);
    await vscode.workspace.getConfiguration('deepseekHarness').update('cliPath', full, vscode.ConfigurationTarget.Global);
    await finishInstall(context, dsh, full, validated, onReady, interactive);
    return;
  }
  const msg = 'dsh installed but `dsh --version` still fails (likely Node <24 at runtime). Install Node 24 LTS, restart VS Code, and retry.';
  output.appendLine(`[dsh] ${msg}`);
  if (interactive) void vscode.window.showWarningMessage(`DeepSeek Harness: ${msg}`);
}

async function finishInstall(
  context: vscode.ExtensionContext,
  dsh: DshAcp,
  cliPath: string,
  version: string,
  onReady: () => void,
  interactive: boolean
): Promise<void> {
  const { refreshDshEnv } = await import('./settingsPanel.js');
  await refreshDshEnv(context, dsh);
  onReady();
  if (interactive) {
    void vscode.window.showInformationMessage(`DeepSeek Harness: dsh CLI ready (${version}). Sessions now use the real ACP transport.`);
  } else {
    outputOf(dsh).appendLine(`[dsh] auto-install complete (${version}); real ACP transport active.`);
  }
}

async function findNpm(): Promise<string> {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const direct = await execProbe(process.platform === 'win32' ? 'where' : 'which', [cmd]).catch(() => '');
  if (direct) return cmd;
  const bare = await execProbe(process.platform === 'win32' ? 'where' : 'which', ['npm']).catch(() => '');
  return bare ? 'npm' : '';
}

// Small indirection so finishInstall stays dependency-light for tests.
function outputOf(dsh: DshAcp): vscode.OutputChannel {
  return (dsh as any).output as vscode.OutputChannel;
}
