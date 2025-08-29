const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');

let autoCommitInterval = null;
let isRunning = false;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function gitOk(cwd) {
  const v = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return v.code === 0 && v.stdout.trim() === 'true';
}

async function getConfig() {
  const cfg = vscode.workspace.getConfiguration('autoGitCommit');
  return {
    enabled: cfg.get('enabled', false),
    interval: cfg.get('interval', 120000),
    message: cfg.get('commitMessage', 'vscode autocommit'),
    separateBranch: cfg.get('separateBranch', true),
    branchName: cfg.get('branchName', 'autogit/diary'),
  };
}

function getRootPath() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

/** Return current ref for our separate branch (or empty string if none) */
async function getAutoRef(cwd, branchName) {
  const r = await run('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd });
  return r.code === 0 ? r.stdout.trim() : '';
}

/** Create a commit from the **current index** (not checkout) and update refs/heads/<branchName> */
async function commitToSeparateBranch(cwd, branchName, message) {
  // Stage changes as usual
  let res = await run('git', ['add', '.'], { cwd });
  if (res.code !== 0) {
    console.error(`[auto-git-commit] git add failed in ${cwd}: ${res.stderr || res.stdout}`);
    return false;
  }

  // If nothing staged, porcelain is empty; early exit
  const porcelain = await run('git', ['status', '--porcelain'], { cwd });
  if (porcelain.code === 0 && porcelain.stdout.trim() === '') {
    return false; // nothing to commit
  }

  // Write the current index to a tree
  const wt = await run('git', ['write-tree'], { cwd });
  if (wt.code !== 0) {
    console.error(`[auto-git-commit] write-tree failed: ${wt.stderr || wt.stdout}`);
    return false;
  }
  const tree = wt.stdout.trim();

  // Find parent (tip of our separate branch, if exists)
  const parent = await getAutoRef(cwd, branchName);

  // Create the commit object (without checkout)
  const args = parent ? ['commit-tree', tree, '-p', parent] : ['commit-tree', tree];
  // Pass message via stdin (avoids shell quoting issues)
  const ct = await new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.write(message + '\n');
    child.stdin.end();
  });

  if (ct.code !== 0) {
    console.error(`[auto-git-commit] commit-tree failed: ${ct.stderr || ct.stdout}`);
    return false;
  }
  const commitSha = ct.stdout.trim();

  // Update branch ref to point to the new commit
  const ur = await run('git', ['update-ref', `refs/heads/${branchName}`, commitSha], { cwd });
  if (ur.code !== 0) {
    console.error(`[auto-git-commit] update-ref failed: ${ur.stderr || ur.stdout}`);
    return false;
  }

  vscode.window.setStatusBarMessage(`✓ Auto commit → ${branchName}`, 2000);
  return true;
}

/** Create a session tag on the current tip of the separate branch */
async function createSessionTag(cwd, branchName) {
  const tip = await getAutoRef(cwd, branchName);
  if (!tip) {
    // If the branch doesn’t exist yet, create an initial empty commit from HEAD tree
    // Fallback: base first commit on current HEAD (or empty if no HEAD)
    const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    if (head.code === 0) {
      // Use HEAD tree as initial snapshot (no parent)
      const tree = (await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd })).stdout.trim();
      const ct = await new Promise((resolve) => {
        const child = spawn('git', ['commit-tree', tree], { cwd });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('close', code => resolve({ code, stdout, stderr }));
        child.stdin.write('auto-git-commit: init branch\n');
        child.stdin.end();
      });
      if (ct.code === 0) {
        const sha = ct.stdout.trim();
        await run('git', ['update-ref', `refs/heads/${branchName}`, sha], { cwd });
      }
    } else {
      // repo without commits: create an empty commit
      const ec = await new Promise((resolve) => {
        const child = spawn('git', ['commit-tree', ('' + '').trim()], { cwd }); // will fail; empty tree is tricky
        child.on('close', code => resolve({ code }));
      });
      // Simpler: do nothing until first commitToSeparateBranch runs
      // (we’ll get a real tree then)
    }
  }

  const refNow = await getAutoRef(cwd, branchName);
  if (!refNow) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tagName = `vscode-session-${timestamp}`;

  // Tag the branch tip
  const tag = await run('git', ['tag', tagName, refNow], { cwd });
  if (tag.code === 0) {
    vscode.window.showInformationMessage(`Created session tag on ${branchName}: ${tagName}`);
  }
}

async function performAutoCommit(rootPath, commitMessage, branchName, separateBranch) {
  if (!(await gitOk(rootPath))) return;

  if (separateBranch) {
    await commitToSeparateBranch(rootPath, branchName, commitMessage);
  } else {
    // Fallback: your original behavior (normal commits on current branch)
    await run('git', ['add', '.'], { cwd: rootPath });
    const res = await run('git', ['commit', '-m', commitMessage], { cwd: rootPath });
    const out = (res.stderr + '\n' + res.stdout).toLowerCase();
    if (res.code !== 0 && !out.includes('nothing to commit') && !out.includes('no changes added to commit')) {
      vscode.window.showErrorMessage(`Git commit failed in ${path.basename(rootPath)} (see console)`);
    }
  }
}

function activate(context) {
  console.log('Auto Git Commit extension is now active!');

  const start = vscode.commands.registerCommand('autoGitCommit.start', async () => {
    if (isRunning) {
      vscode.window.showWarningMessage('Auto Git Commit is already running');
      return;
    }
    const rootPath = getRootPath();
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const cfg = await getConfig();
    isRunning = true;

    // Create a session tag pointing at the separate branch tip (or initialize it) at startup
    if (cfg.separateBranch) {
      await createSessionTag(rootPath, cfg.branchName);
    } else {
      // Your original session-tag-on-start behavior
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await run('git', ['tag', `vscode-session-${ts}`], { cwd: rootPath });
    }

    autoCommitInterval = setInterval(() => {
      performAutoCommit(rootPath, cfg.message, cfg.branchName, cfg.separateBranch);
    }, Math.max(5000, cfg.interval));

    vscode.window.showInformationMessage(`Auto Git Commit started (${Math.round(cfg.interval / 1000)}s)`);
  });

  const stop = vscode.commands.registerCommand('autoGitCommit.stop', () => {
    if (!isRunning) {
      vscode.window.showWarningMessage('Auto Git Commit is not running');
      return;
    }
    if (autoCommitInterval) clearInterval(autoCommitInterval);
    autoCommitInterval = null;
    isRunning = false;
    vscode.window.showInformationMessage('Auto Git Commit stopped');
  });

  const status = vscode.commands.registerCommand('autoGitCommit.status', async () => {
    const cfg = await getConfig();
    const status = isRunning ? 'Running' : 'Stopped';
    vscode.window.showInformationMessage(
      `Auto Git Commit Status: ${status} (Interval: ${Math.round(cfg.interval / 1000)}s) → ${cfg.separateBranch ? cfg.branchName : 'current branch'}`
    );
  });

  context.subscriptions.push(start, stop, status);

  // Auto-start if enabled globally
  getConfig().then(cfg => { if (cfg.enabled) vscode.commands.executeCommand('autoGitCommit.start'); });
}

function deactivate() {
  if (autoCommitInterval) clearInterval(autoCommitInterval);
}

module.exports = { activate, deactivate };
