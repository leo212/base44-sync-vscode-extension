import * as vscode from "vscode";
import * as path from "path";
import puppeteer from "puppeteer-core";
import * as os from "os";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";

  interface Base44Config {
    appId: string;
    token: string;
  }

  async function runLogin(): Promise<Base44Config | null> {
    vscode.window.showInformationMessage("Opening Base44 login window...");

    const chromePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const executablePath = chromePaths.find(p => fs.existsSync(p));
    if (!executablePath) {
      vscode.window.showErrorMessage("Google Chrome not found. Please install Chrome and try again.");
      return null;
    }

    const userDataDir = path.join(os.tmpdir(), "base44-chrome-profile");
    const browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await page.goto("https://app.base44.com", { waitUntil: "networkidle2" });

    let token: string | null = null;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Waiting for Base44 login...", cancellable: false },
      async () => {
        while (!token) {
          await new Promise(r => setTimeout(r, 1500));
          try { token = await page.evaluate(() => localStorage.getItem("token")); } catch { }
        }
      }
    );
    await browser.close();

    if (!token) {
      vscode.window.showErrorMessage("Login failed: could not retrieve token.");
      return null;
    }

    const appsResponse = await fetch(
      "https://app.base44.com/api/apps?q=%7B%22app_type%22%3A%22user_app%22%7D&sort=-updated_date&limit=50&fields=id,name,slug,status,updated_date",
      { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } }
    );
    if (!appsResponse.ok) {
      vscode.window.showErrorMessage(`Failed to fetch apps: ${appsResponse.statusText}`);
      return null;
    }

    const apps = (await appsResponse.json()) as Array<{ id: string; name: string; slug: string }>;
    const picked = await vscode.window.showQuickPick(
      apps.map(a => ({ label: a.name, description: a.slug, id: a.id })),
      { placeHolder: "Select a Base44 app" }
    );
    if (!picked) { return null; }

    const config: Base44Config = { appId: picked.id, token };
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(config, null, 2), "utf8"));
    vscode.window.showInformationMessage(`Logged in! App "${picked.label}" selected and config saved.`);
    return config;
  }

  async function getProjectConfig(): Promise<Base44Config | null> {
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      const config = JSON.parse(content.toString()) as Base44Config;
      if (!config.appId || !config.token) { return runLogin(); }
      return config;
    } catch {
      return runLogin();
    }
  }

  interface PullResponse {
    pages: Record<string, string>;
    components: Record<string, string>;
    layout?: string;
    entities?: Record<string, object>;
  }

  console.log("Deploy-Pull Extension Activated!");

  async function deployFile(config: Base44Config, document: vscode.TextDocument) {
    const filePath = document.uri.fsPath;
    const relativePath = path.relative(path.join(workspaceFolder, "src"), filePath);
    let apiPath: string;

    if (relativePath.startsWith("entities" + path.sep)) {
      apiPath = `entities/${path.basename(filePath, ".json")}`;
    } else if (path.basename(filePath) === "Layout.js") {
      apiPath = "layout";
    } else {
      apiPath = relativePath.replace(/\.[^/.]+$/, "").replaceAll("\\", "/");
    }

    const content = document.getText();
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

    if (response.status === 401) { throw new Error(`401 Unauthorized`); }
    if (!response.ok) { throw new Error(`Deploy failed for ${relativePath}: ${response.statusText}`); }
  }

  // ---- DEPLOY COMMAND ----
  const deployCmd = vscode.commands.registerCommand("extension.deploy", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No file open.");
      return;
    }

    try {
      await deployFile(config, editor.document);
      const relativePath = path.relative(path.join(workspaceFolder, "src"), editor.document.uri.fsPath);
      vscode.window.showInformationMessage(`Deployed ${relativePath} successfully.`);
    } catch (err: any) {
      if (err.message?.includes("401") || err.message?.includes("Unauthorized")) {
        config = await runLogin();
        if (config) { await deployFile(config, editor.document); }
      } else {
        vscode.window.showErrorMessage(`Deploy error: ${err.message}`);
      }
    }
  });

  // ---- DEPLOY ALL OPENED EDITORS COMMAND ----
  const deployAllCmd = vscode.commands.registerCommand("extension.deployAll", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }

    const openedDocuments = vscode.workspace.textDocuments.filter(doc => !doc.isUntitled);
    if (openedDocuments.length === 0) {
      vscode.window.showErrorMessage("No files open.");
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const document of openedDocuments) {
      try {
        await deployFile(config, document);
        successCount++;
      } catch (err: any) {
        if (err.message?.includes("401") || err.message?.includes("Unauthorized")) {
          config = await runLogin() ?? config;
        }
        errorCount++;
      }
    }

    if (errorCount === 0) {
      vscode.window.showInformationMessage(`Deployed ${successCount} files successfully.`);
    } else {
      vscode.window.showWarningMessage(`Deployed ${successCount} files successfully, ${errorCount} failed.`);
    }
  });

  // ---- PULL COMMAND ----
const pullCmd = vscode.commands.registerCommand("extension.pull", async () => {
  let config = await getProjectConfig();
  if (!config) { return; }

  function normalize(content: string): string {
    return content
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n");
  }

  try {
    let fileMap: Record<string, string>;
    try {
      fileMap = await fetchRemoteFiles(config);
    } catch (err: any) {
      if (err.message?.includes("401") || err.message?.includes("Unauthorized")) {
        config = await runLogin();
        if (!config) { return; }
        fileMap = await fetchRemoteFiles(config);
      } else { throw err; }
    }
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


  // ---- LOGIN COMMAND ----
  const loginCmd = vscode.commands.registerCommand("extension.login", async () => {
    await runLogin();
  });

  context.subscriptions.push(deployCmd, deployAllCmd, pullCmd, loginCmd);

  // ---------------- SUB-FUNCTIONS ----------------
  async function fetchRemoteFiles(config: Base44Config): Promise<Record<string, string>> {
    const { appId, token } = config;
    console.log("Fetching remote files from sandbox endpoint...");

    const url = `https://app.base44.com/api/apps/${appId}/sandbox/files`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 401) { throw new Error(`401 Unauthorized`); }
    if (!response.ok) throw new Error(`Pull failed: ${response.statusText}`);
    const data = (await response.json()) as { app_id?: string; files?: Record<string, string> };

    const fileMap: Record<string, string> = {};

    for (const [remotePath, content] of Object.entries(data.files || {})) {
      // Remove any leading slashes
      const rel = remotePath.replace(/^[/\\]+/, "");
      // Resolve target path within workspace
      const target = path.resolve(workspaceFolder, rel);
      const workspaceRootResolved = path.resolve(workspaceFolder);

      // Prevent writing outside workspace
      if (!target.startsWith(workspaceRootResolved)) {
        console.warn(`Skipping path outside workspace: ${remotePath}`);
        continue;
      }

      fileMap[target] = content;
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
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document, { preview: false });
    } 
  }
}

export function deactivate() {}
