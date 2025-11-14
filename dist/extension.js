"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const indexer_1 = require("./indexer");
const pipeline_1 = require("./pipeline");
async function activate(context) {
    const generateTicket = vscode.commands.registerCommand("aiPipeline.generateTicket", async () => {
        try {
            const workspace = getWorkspaceFolder();
            const goal = await vscode.window.showInputBox({
                prompt: "Describe the product goal or feature you want to plan",
                placeHolder: "Build AI insights page",
            });
            if (!goal) {
                vscode.window.showInformationMessage("AI Pipeline cancelled.");
                return;
            }
            const index = await (0, indexer_1.ensureIndex)(workspace);
            const ticket = await (0, pipeline_1.runPlanningPipeline)(goal, index, workspace);
            if (!ticket) {
                vscode.window.showErrorMessage("Planning pipeline did not return a ticket.");
                return;
            }
            const doc = await vscode.workspace.openTextDocument({
                content: ticket,
                language: "markdown",
            });
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage("Ticket.md draft generated.");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error occurred";
            vscode.window.showErrorMessage(`AI Pipeline failed: ${message}`);
            console.error(error);
        }
    });
    const rebuild = vscode.commands.registerCommand("aiPipeline.rebuildIndex", async () => {
        try {
            const workspace = getWorkspaceFolder();
            await (0, indexer_1.rebuildIndex)(workspace);
            vscode.window.showInformationMessage("AI pipeline index rebuilt.");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error occurred";
            vscode.window.showErrorMessage(`Index rebuild failed: ${message}`);
            console.error(error);
        }
    });
    registerAutoIndexing(context);
    context.subscriptions.push(generateTicket, rebuild);
}
function deactivate() {
    // no-op
}
function getWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error("Open a workspace to use the AI pipeline extension.");
    }
    return folders[0];
}
function registerAutoIndexing(context) {
    if (!vscode.workspace.workspaceFolders?.length) {
        return;
    }
    const pending = new Set();
    let timer;
    let running = false;
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusItem.name = "AI Pipeline Index";
    statusItem.text = "$(sync~spin) AI Context: Updating…";
    statusItem.tooltip = "AI Pipeline is refreshing the semantic index.";
    statusItem.hide();
    const schedule = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(async () => {
            timer = undefined;
            if (running) {
                schedule();
                return;
            }
            await flush();
        }, 1500);
    };
    const flush = async () => {
        if (pending.size === 0) {
            return;
        }
        let workspace;
        try {
            workspace = getWorkspaceFolder();
        }
        catch {
            pending.clear();
            return;
        }
        running = true;
        statusItem.show();
        const affected = Array.from(pending);
        pending.clear();
        try {
            await (0, indexer_1.rebuildIndex)(workspace, {
                silent: true,
                touchedFiles: affected,
            });
            statusItem.text = "AI Context: Indexed";
            setTimeout(() => {
                statusItem.text = "$(sync~spin) AI Context: Updating…";
                statusItem.hide();
            }, 2000);
        }
        catch (error) {
            console.error("Background index refresh failed", error);
            vscode.window.setStatusBarMessage("AI pipeline index refresh failed (see console)", 4000);
            statusItem.text = "$(error) AI Context: Index failed";
            setTimeout(() => {
                statusItem.text = "$(sync~spin) AI Context: Updating…";
                statusItem.hide();
            }, 4000);
        }
        finally {
            running = false;
            if (pending.size > 0) {
                schedule();
            }
        }
    };
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return;
        }
        pending.add(document.uri.fsPath);
        schedule();
    });
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            pending.add(file.oldUri.fsPath);
            pending.add(file.newUri.fsPath);
        });
        schedule();
    });
    const createDisposable = vscode.workspace.onDidCreateFiles((event) => {
        event.files.forEach((file) => pending.add(file.fsPath));
        schedule();
    });
    const deleteDisposable = vscode.workspace.onDidDeleteFiles((event) => {
        event.files.forEach((file) => pending.add(file.fsPath));
        schedule();
    });
    context.subscriptions.push(statusItem, saveDisposable, renameDisposable, createDisposable, deleteDisposable);
}
//# sourceMappingURL=extension.js.map