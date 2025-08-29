const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

let autoCommitInterval = null;
let isRunning = false;

function activate(context) {
    console.log('Auto Git Commit extension is now active!');
    
    // Create initial tag when VSCode opens
    createInitialTag();
    
    // Register commands
    const startCommand = vscode.commands.registerCommand('autoGitCommit.start', () => {
        startAutoCommit();
    });
    
    const stopCommand = vscode.commands.registerCommand('autoGitCommit.stop', () => {
        stopAutoCommit();
    });
    
    const statusCommand = vscode.commands.registerCommand('autoGitCommit.status', () => {
        showStatus();
    });
    
    context.subscriptions.push(startCommand, stopCommand, statusCommand);
    
    // Auto-start if enabled in settings
    const config = vscode.workspace.getConfiguration('autoGitCommit');
    if (config.get('enabled')) {
        startAutoCommit();
    }
}

function createInitialTag() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder found');
        return;
    }
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tagName = `vscode-session-${timestamp}`;
    
    exec(`git tag ${tagName}`, { cwd: rootPath }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error creating tag: ${error}`);
            return;
        }
        console.log(`Created tag: ${tagName}`);
        vscode.window.showInformationMessage(`Created session tag: ${tagName}`);
    });
}

function startAutoCommit() {
    if (isRunning) {
        vscode.window.showWarningMessage('Auto Git Commit is already running');
        return;
    }
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }
    
    const config = vscode.workspace.getConfiguration('autoGitCommit');
    const interval = config.get('interval', 120000); // Default 2 minutes
    const commitMessage = config.get('commitMessage', 'vscode autocommit');
    const rootPath = workspaceFolders[0].uri.fsPath;
    
    isRunning = true;
    
    autoCommitInterval = setInterval(() => {
        performAutoCommit(rootPath, commitMessage);
    }, interval);
    
    vscode.window.showInformationMessage(`Auto Git Commit started (${interval/1000}s interval)`);
}

function stopAutoCommit() {
    if (!isRunning) {
        vscode.window.showWarningMessage('Auto Git Commit is not running');
        return;
    }
    
    if (autoCommitInterval) {
        clearInterval(autoCommitInterval);
        autoCommitInterval = null;
    }
    
    isRunning = false;
    vscode.window.showInformationMessage('Auto Git Commit stopped');
}

function showStatus() {
    const config = vscode.workspace.getConfiguration('autoGitCommit');
    const interval = config.get('interval', 120000);
    const status = isRunning ? 'Running' : 'Stopped';
    
    vscode.window.showInformationMessage(
        `Auto Git Commit Status: ${status} (Interval: ${interval/1000}s)`
    );
}

function performAutoCommit(rootPath, commitMessage) {
    // First add all files
    exec('git add .', { cwd: rootPath }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error adding files: ${error}`);
            return;
        }
        
        // Then commit
        exec(`git commit -m "${commitMessage}"`, { cwd: rootPath }, (error, stdout, stderr) => {
            if (error) {
                // Don't show error for "nothing to commit" - that's normal
                if (!error.message.includes('nothing to commit')) {
                    console.error(`Error committing: ${error}`);
                    vscode.window.showErrorMessage(`Git commit failed: ${error.message}`);
                }
                return;
            }
            
            console.log(`Auto commit successful: ${stdout}`);
            // Show a subtle status bar message instead of popup
            vscode.window.setStatusBarMessage('✓ Auto commit completed', 2000);
        });
    });
}

function deactivate() {
    if (autoCommitInterval) {
        clearInterval(autoCommitInterval);
    }
}

module.exports = {
    activate,
    deactivate
};