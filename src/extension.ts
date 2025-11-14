import * as vscode from "vscode";
import { ensureIndex, rebuildIndex } from "./indexer";
import { runPlanningPipeline } from "./pipeline";

export async function activate(context: vscode.ExtensionContext) {
  const generateTicket = vscode.commands.registerCommand(
    "aiPipeline.generateTicket",
    async () => {
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

        const index = await ensureIndex(workspace);
        const ticket = await runPlanningPipeline(goal, index, workspace);

        if (!ticket) {
          vscode.window.showErrorMessage(
            "Planning pipeline did not return a ticket."
          );
          return;
        }

        const doc = await vscode.workspace.openTextDocument({
          content: ticket,
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage("Ticket.md draft generated.");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        vscode.window.showErrorMessage(`AI Pipeline failed: ${message}`);
        console.error(error);
      }
    }
  );

  const rebuild = vscode.commands.registerCommand(
    "aiPipeline.rebuildIndex",
    async () => {
      try {
        const workspace = getWorkspaceFolder();
        await rebuildIndex(workspace);
        vscode.window.showInformationMessage("AI pipeline index rebuilt.");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred";
        vscode.window.showErrorMessage(`Index rebuild failed: ${message}`);
        console.error(error);
      }
    }
  );

  registerAutoIndexing(context);

  context.subscriptions.push(generateTicket, rebuild);
}

export function deactivate() {
  // no-op
}

function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Open a workspace to use the AI pipeline extension.");
  }
  return folders[0];
}

function registerAutoIndexing(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );
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
    let workspace: vscode.WorkspaceFolder;
    try {
      workspace = getWorkspaceFolder();
    } catch {
      pending.clear();
      return;
    }

    running = true;
    statusItem.show();
    const affected = Array.from(pending);
    pending.clear();
    try {
      await rebuildIndex(workspace, {
        silent: true,
        touchedFiles: affected,
      });
      statusItem.text = "AI Context: Indexed";
      setTimeout(() => {
        statusItem.text = "$(sync~spin) AI Context: Updating…";
        statusItem.hide();
      }, 2000);
    } catch (error) {
      console.error("Background index refresh failed", error);
      vscode.window.setStatusBarMessage(
        "AI pipeline index refresh failed (see console)",
        4000
      );
      statusItem.text = "$(error) AI Context: Index failed";
      setTimeout(() => {
        statusItem.text = "$(sync~spin) AI Context: Updating…";
        statusItem.hide();
      }, 4000);
    } finally {
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

  context.subscriptions.push(
    statusItem,
    saveDisposable,
    renameDisposable,
    createDisposable,
    deleteDisposable
  );
}

