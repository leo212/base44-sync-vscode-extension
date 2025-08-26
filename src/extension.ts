import * as vscode from "vscode";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";

  interface Base44Config {
    appId: string;
    token: string;
  }

  async function getProjectConfig(workspaceFolder: string): Promise<Base44Config | null> {
    const configPath = path.join(workspaceFolder, "base44-config.json");
    const configUri = vscode.Uri.file(configPath);
  
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      const config = JSON.parse(content.toString()) as Base44Config;
      if (
        !config.appId || config.appId === "YOUR_APPLICATION_ID_FROM_BASE44" ||
        !config.token || config.token === "YOUR_AUTHENTICATION_TOKEN_FROM_BASE44"
      ) {
        vscode.window.showErrorMessage("Base44 Sync is not configured. Please set your App ID and Token in base44-config.json file.");
        vscode.workspace.openTextDocument(configUri).then(doc => vscode.window.showTextDocument(doc));
        return null;
      }
      return config;
    } catch (error) {
      // File does not exist or is invalid JSON, create it.
      const defaultConfig: Base44Config = {
        appId: "YOUR_APPLICATION_ID_FROM_BASE44",
        token: "YOUR_AUTHENTICATION_TOKEN_FROM_BASE44"
      };
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(defaultConfig, null, 2), "utf8"));
      vscode.window.showInformationMessage("Created base44-config.json file. Please configure your App ID and Token.");
      vscode.workspace.openTextDocument(configUri).then(doc => vscode.window.showTextDocument(doc));
      return null;
    }
  }

  interface PullResponse {
    pages: Record<string, string>;
    components: Record<string, string>;
    layout?: string;
    entities?: Record<string, object>;
  }

  console.log("Deploy-Pull Extension Activated!");

  // ---- DEPLOY COMMAND ----
  const deployCmd = vscode.commands.registerCommand("extension.deploy", async () => {
    const config = await getProjectConfig(workspaceFolder);
    if (!config) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No file open.");
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const relativePath = path.relative(path.join(workspaceFolder, "src"), filePath);
    let apiPath: string;

    if (relativePath.startsWith("entities" + path.sep)) {
      apiPath = `entities/${path.basename(filePath, ".json")}`;
    } else if (path.basename(filePath) === "Layout.js") {
      apiPath = "layout";
    } else {
      apiPath = relativePath.replace(/\.[^/.]+$/, "").replaceAll("\\", "/");
    }

    const content = editor.document.getText();

    try {
      const { appId, token } = config;

      const response = await fetch(
        `https://app.base44.com/api/apps/${appId}/coding/write`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            file_path: apiPath,
            content: content,
          }),
        }
      );

      if (response.ok) {
        vscode.window.showInformationMessage(
          `Deployed ${relativePath} successfully.`
        );
      } else {
        vscode.window.showErrorMessage(`Deploy failed: ${response.statusText}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Deploy error: ${err.message}`);
    }
  });

  // ---- PULL COMMAND ----
const pullCmd = vscode.commands.registerCommand("extension.pull", async () => {
  const config = await getProjectConfig(workspaceFolder);
  if (!config) {
    return;
  }

  function normalize(content: string): string {
    return content
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n");
  }

  try {
    const fileMap: Record<string, string> = await fetchRemoteFiles(config);
    let changedFiles = 0;

    for (const [filePath, remoteContent] of Object.entries(fileMap)) {
      await ensureLocalFileExists(filePath, remoteContent);

      const remoteContentNormalized = normalize(remoteContent);
      const localContent = normalize(
        await vscode.workspace.fs
          .readFile(vscode.Uri.file(filePath))
          .then(
            (buf) => buf.toString(),
            () => ""
          )
      );

      if (remoteContentNormalized !== localContent) {
        changedFiles++;

        // Step 1: keep local content in memory
        const oldUri = vscode.Uri.parse(`memfs:${filePath}.old`);
        const provider = new (class implements vscode.TextDocumentContentProvider {
          onDidChange?: vscode.Event<vscode.Uri> | undefined;
          provideTextDocumentContent(uri: vscode.Uri): string {
            return localContent;
          }
        })();

        context.subscriptions.push(
          vscode.workspace.registerTextDocumentContentProvider("memfs", provider)
        );

        // Step 2: replace local file with remote content
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          (await vscode.workspace.openTextDocument(filePath)).lineAt(
            (await vscode.workspace.openTextDocument(filePath)).lineCount - 1
          ).range.end
        );
        edit.replace(vscode.Uri.file(filePath), fullRange, remoteContent);
        await vscode.workspace.applyEdit(edit);

        // Step 3: open diff
        await vscode.commands.executeCommand(
          "vscode.diff",
          oldUri,
          vscode.Uri.file(filePath),
          `Before ⟷ After: ${path.basename(filePath)}`
        );
      }
    }

    if (changedFiles > 0) {
      vscode.window.showInformationMessage(
        `Pull finished. ${changedFiles} files changed.`
      );
    } else {
      vscode.window.showInformationMessage("No changes found.");
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Pull error: ${err.message}`);
    console.error("Pull error stack:", err);
  }
});


  // ---------------- SUB-FUNCTIONS ----------------
  async function fetchRemoteFiles(config: Base44Config): Promise<Record<string, string>> {
    const { appId, token } = config;
    console.log("Fetching remote files...");
    const response = await fetch(
      `https://app.base44.com/api/apps/${appId}/coding/write`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ file_path: "", content: "" }),
      }
    );

    if (!response.ok) throw new Error(`Pull failed: ${response.statusText}`);
    const data = (await response.json()) as PullResponse;
    console.log(
      "Remote files received:",
      Object.keys(data.pages || {}),
      Object.keys(data.components || {}),
      Object.keys(data.entities || {})
    );

    const fileMap: Record<string, string> = {};
    // Pages
    for (const [pageName, code] of Object.entries(data.pages || {})) {
      fileMap[path.join(workspaceFolder, "src", "pages", `${pageName}.jsx`)] =
        code;
    }
    // Components
    for (const [compName, code] of Object.entries(data.components || {})) {
      fileMap[
        path.join(workspaceFolder, "src", "components", `${compName}.jsx`)
      ] = code;
    }
    // Layout
    if (data.layout) {
      fileMap[path.join(workspaceFolder, "src", "Layout.js")] = data.layout;
    }
    // Entities
    if (data.entities) {
      for (const [entityName, entityJson] of Object.entries(data.entities)) {
        fileMap[
          path.join(workspaceFolder, "src", "entities", `${entityName}.json`)
        ] = JSON.stringify(entityJson, null, 2);
      }
    }
    return fileMap;
  }

  async function ensureLocalFileExists(filePath: string, content: string) {
    const exists = await vscode.workspace.fs
      .stat(vscode.Uri.file(filePath))
      .then(
        () => true,
        () => false
      );
    if (!exists) {
      const dir = path.dirname(filePath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(filePath),
        Buffer.from(content, "utf8")
      );
      vscode.window.showInformationMessage(`New file created: ${filePath}`);
    }
  }
}

export function deactivate() {}
