/**
 * extension.js — VS Code extension entry point for the sdn-flow editor.
 *
 * Provides:
 *   1. Custom editor for .flow.json files (webview panel)
 *   2. Commands: sdnFlow.openEditor, sdnFlow.openFile
 *   3. Message passing between webview and extension host for:
 *      - File import/export
 *      - Deployment artifact saving
 *      - Wallet integration
 */

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

function activate(context) {
  // Register custom editor provider
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "sdnFlow.flowEditor",
      new SDNFlowEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Command: Open blank flow editor
  context.subscriptions.push(
    vscode.commands.registerCommand("sdnFlow.openEditor", () => {
      SDNFlowEditorProvider.createPanel(context);
    })
  );

  // Command: Open specific flow file
  context.subscriptions.push(
    vscode.commands.registerCommand("sdnFlow.openFile", async (uri) => {
      if (!uri) {
        const files = await vscode.window.showOpenDialog({
          filters: { "Flow JSON": ["json"] },
          canSelectMany: false,
        });
        if (!files || files.length === 0) return;
        uri = files[0];
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "sdnFlow.flowEditor"
      );
    })
  );
}

function deactivate() {}

class SDNFlowEditorProvider {
  constructor(context) {
    this.context = context;
  }

  // Called when VS Code opens a .flow.json file with our custom editor
  async resolveCustomTextEditor(document, webviewPanel) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "..", "docs")),
      ],
    };

    webviewPanel.webview.html = this._getWebviewContent(
      webviewPanel.webview
    );

    // Load the document content into the webview
    const flowData = document.getText();
    webviewPanel.webview.postMessage({
      command: "loadFlow",
      data: flowData,
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "importFlow": {
          const files = await vscode.window.showOpenDialog({
            filters: { "Flow JSON": ["json"] },
            canSelectMany: false,
          });
          if (files && files.length > 0) {
            const content = await vscode.workspace.fs.readFile(files[0]);
            webviewPanel.webview.postMessage({
              command: "loadFlow",
              data: new TextDecoder().decode(content),
            });
          }
          break;
        }

        case "exportFlow": {
          const uri = await vscode.window.showSaveDialog({
            filters: { "Flow JSON": ["json"] },
            defaultUri: vscode.Uri.file("flow.json"),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(
              uri,
              new TextEncoder().encode(message.data)
            );
            vscode.window.showInformationMessage(
              `Flow exported to ${uri.fsPath}`
            );
          }
          break;
        }

        case "deploy": {
          const uri = await vscode.window.showSaveDialog({
            filters: { "Deployment JSON": ["json"] },
            defaultUri: vscode.Uri.file("deployment.json"),
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(
              uri,
              new TextEncoder().encode(message.data)
            );
            vscode.window.showInformationMessage(
              `Deployment artifact saved to ${uri.fsPath}`
            );
          }
          break;
        }

        case "saveFlow": {
          // Update the underlying text document
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            message.data
          );
          await vscode.workspace.applyEdit(edit);
          break;
        }
      }
    });

    // When the text document changes externally, reload into webview
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({
          command: "loadFlow",
          data: e.document.getText(),
        });
      }
    });
    webviewPanel.onDidDispose(() => changeDisposable.dispose());
  }

  _getWebviewContent(webview) {
    const docsPath = path.join(this.context.extensionPath, "..", "docs");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(docsPath, "css", "style.css"))
    );
    const appUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(docsPath, "js", "app.mjs"))
    );

    // Read the index.html and rewrite asset paths for webview
    const indexPath = path.join(docsPath, "index.html");
    let html = fs.readFileSync(indexPath, "utf-8");

    // Replace relative paths with webview URIs
    html = html.replace(
      'href="css/style.css"',
      `href="${cssUri}"`
    );
    html = html.replace(
      'src="js/app.mjs"',
      `src="${appUri}"`
    );

    // Add CSP for webview
    const nonce = getNonce();
    html = html.replace(
      "</head>",
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' 'unsafe-eval' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net;">\n</head>`
    );

    return html;
  }

  static createPanel(context) {
    const panel = vscode.window.createWebviewPanel(
      "sdnFlow.flowEditor",
      "SDN Flow Editor",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(
            path.join(context.extensionPath, "..", "docs")
          ),
        ],
      }
    );

    const provider = new SDNFlowEditorProvider(context);
    panel.webview.html = provider._getWebviewContent(panel.webview);
    return panel;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = { activate, deactivate };
