import * as vscode from "vscode";
import * as path from "path";
import puppeteer from "puppeteer-core";
import * as os from "os";
import * as fs from "fs";

interface Base44Config {
  appId: string;
  appName?: string;
  token: string;
}

interface App {
  id: string;
  name: string;
  slug: string;
}

interface ChangedFile {
  localPath: string;
  relativePath: string;
  remoteContent: string;
}

interface PanelState {
  // Bootstrap/Auth states: loading, invalid-token, ready
  bootstrapState: "loading" | "invalid-token" | "ready";
  
  loggedIn: boolean;
  appName: string;
  apps: App[];
  selectedAppId: string;
  status: string;
  statusType: "idle" | "progress" | "success" | "error";
  progress: number; // 0-100, -1 = indeterminate
  lastAction: string;
  
  // Sync state tracking
  syncKnown: boolean; // true if we have a trusted remote baseline
  changedFiles: ChangedFile[];
}

let panel: vscode.WebviewView | undefined;
let panelState: PanelState = {
  bootstrapState: "loading",
  loggedIn: false,
  appName: "",
  apps: [],
  selectedAppId: "",
  status: "Bootstrapping...",
  statusType: "progress",
  progress: -1,
  lastAction: "",
  syncKnown: false,
  changedFiles: [],
};

// Track the remote file snapshot and watcher for monitoring
let remoteFileSnapshot: Record<string, string> = {};
let fileWatcher: vscode.FileSystemWatcher | undefined;

function postState() {
  panel?.webview.postMessage({ type: "state", state: panelState });
}

function setStatus(status: string, type: PanelState["statusType"], progress = -1) {
  panelState.status = status;
  panelState.statusType = type;
  panelState.progress = progress;
  postState();
}

function setIdle(message: string, type: "success" | "error" = "success") {
  const now = new Date().toLocaleString();
  panelState.status = `${message}`;
  panelState.statusType = type;
  panelState.progress = -1;
  panelState.lastAction = `${now} — ${message}`;
  postState();
}

// State transition helpers
function markBootstrapping() {
  panelState.bootstrapState = "loading";
  panelState.status = "Validating credentials...";
  panelState.statusType = "progress";
  panelState.progress = -1;
  postState();
}

function markTokenInvalid() {
  panelState.bootstrapState = "invalid-token";
  panelState.loggedIn = false;
  panelState.apps = [];
  panelState.selectedAppId = "";
  panelState.syncKnown = false;
  panelState.changedFiles = [];
  panelState.status = "Token expired or invalid";
  panelState.statusType = "error";
  postState();
}

function markReady() {
  panelState.bootstrapState = "ready";
  panelState.loggedIn = true;
  if (!panelState.status || panelState.statusType === "progress") {
    setIdle("Ready", "success");
  } else {
    postState();
  }
}

function markSyncKnown() {
  panelState.syncKnown = true;
  postState();
}

function markSyncUnknown() {
  panelState.syncKnown = false;
  panelState.changedFiles = [];
  remoteFileSnapshot = {};
  stopMonitoring();
  postState();
}

function stopMonitoring() {
  if (fileWatcher) {
    fileWatcher.dispose();
    fileWatcher = undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";

  // Do NOT restore persisted changed files; always start with sync unknown state

  // Bootstrap: validate config and token before showing normal UI
  (async () => {
    displayBootstrapValidation();
  })();

  function persistChangedFiles() {
    context.globalState.update("base44.changedFiles", panelState.changedFiles);
  }

  function normalize(content: string): string {
    return content.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
  }

  function loadBase44IgnorePatterns(): string[] {
    try {
      const ignoreFile = path.join(workspaceFolder, ".base44ignore");
      if (fs.existsSync(ignoreFile)) {
        const content = fs.readFileSync(ignoreFile, "utf-8");
        return content
          .split("\n")
          .map(line => line.trim())
          .filter(line => line && !line.startsWith("#")); // Remove empty lines and comments
      }
    } catch {
      // Ignore errors reading the file
    }
    return [];
  }

  function matchesPattern(relativePath: string, pattern: string): boolean {
    // Normalize paths for comparison
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // Exact match
    if (normalizedPath === normalizedPattern) return true;

    // Wildcard patterns
    if (normalizedPattern.includes("*")) {
      // Convert glob pattern to regex
      const regexPattern = normalizedPattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "<<DOUBLESTAR>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<DOUBLESTAR>>/g, ".*");
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(normalizedPath);
    }

    return false;
  }

  function shouldIgnoreFile(relativePath: string, patterns: string[]): boolean {
    return patterns.some(pattern => matchesPattern(relativePath, pattern));
  }

  function filterIgnoredFiles(files: ChangedFile[], patterns: string[]): ChangedFile[] {
    return files.filter(f => !shouldIgnoreFile(f.relativePath, patterns));
  }

  async function addToBase44Ignore(relativePath: string): Promise<void> {
    const ignoreFile = path.join(workspaceFolder, ".base44ignore");
    let content = "";

    try {
      if (fs.existsSync(ignoreFile)) {
        content = fs.readFileSync(ignoreFile, "utf-8");
        // Add newline if file doesn't end with one
        if (content && !content.endsWith("\n")) {
          content += "\n";
        }
      }
    } catch {
      // File doesn't exist or can't be read, start fresh
    }

    content += relativePath + "\n";
    fs.writeFileSync(ignoreFile, content, "utf-8");

    // Remove from changed files list
    const patterns = loadBase44IgnorePatterns();
    panelState.changedFiles = filterIgnoredFiles(panelState.changedFiles, patterns);
    persistChangedFiles();
    postState();
  }

  // ---- BOOTSTRAP & VALIDATION ----
  async function fetchAppsWithToken(token: string): Promise<App[] | null> {
    try {
      const appsResponse = await fetch(
        "https://app.base44.com/api/apps?q=%7B%22app_type%22%3A%22user_app%22%7D&sort=-updated_date&limit=50&fields=id,name,slug,status,updated_date",
        { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } }
      );
      if (!appsResponse.ok) return null;
      return (await appsResponse.json()) as App[];
    } catch {
      return null;
    }
  }

  async function displayBootstrapValidation() {
    markBootstrapping();
    
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    let savedConfig: Base44Config | null = null;
    
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      savedConfig = JSON.parse(content.toString()) as Base44Config;
    } catch {
      // No saved config, will show refresh token UI
    }

    if (savedConfig?.token && savedConfig?.appId) {
      // Try to validate the saved token by fetching apps
      const apps = await fetchAppsWithToken(savedConfig.token);
      
      if (apps && apps.length > 0) {
        // Token is valid
        panelState.apps = apps;
        panelState.selectedAppId = savedConfig.appId;
        panelState.appName = savedConfig.appName || savedConfig.appId;
        
        // Verify the selected app still exists
        if (!apps.find(a => a.id === savedConfig!.appId)) {
          // Selected app no longer exists, use first one
          panelState.selectedAppId = apps[0].id;
          panelState.appName = apps[0].name;
          // Update config file with new selection
          const newConfig = { ...savedConfig, appId: apps[0].id, appName: apps[0].name };
          await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(newConfig, null, 2), "utf8"));
        }
        
        markReady();
        // Start automatic baseline sync for the selected app
        await runSyncBaseline(savedConfig.token);
        return;
      }
    }

    // Token is missing or invalid
    markTokenInvalid();
  }

  async function runSyncBaseline(token: string): Promise<boolean> {
    setStatus("Syncing files...", "progress");
    try {
      let fileMap: Record<string, string>;
      try {
        const response = await fetch(`https://app.base44.com/api/apps/${panelState.selectedAppId}/sandbox/files`, {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        });
        if (response.status === 401) {
          markTokenInvalid();
          return false;
        }
        if (!response.ok) throw new Error(`Sync failed: ${response.statusText}`);
        const data = (await response.json()) as { files?: Record<string, string> };
        fileMap = {};
        const workspaceRoot = path.resolve(workspaceFolder);
        for (const [remotePath, content] of Object.entries(data.files || {})) {
          const rel = remotePath.replace(/^[/\\]+/, "").split(/[/\\]/).filter(s => s !== ".." && s !== ".").join(path.sep);
          const target = path.resolve(workspaceRoot, rel);
          if (target.startsWith(workspaceRoot + path.sep) || target === workspaceRoot) {
            fileMap[target] = content;
          }
        }
      } catch (err: any) {
        setIdle(`Sync check failed: ${err.message}`, "error");
        return false;
      }

      const total = Object.keys(fileMap).length;
      let done = 0;
      const newChangedFiles: ChangedFile[] = [];

      for (const [filePath, remoteContent] of Object.entries(fileMap)) {
        done++;
        setStatus(`Comparing files... (${done}/${total})`, "progress", Math.round((done / total) * 100));
        const localContent = normalize(
          await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(b => b.toString(), () => "")
        );
        if (normalize(remoteContent) !== localContent) {
          newChangedFiles.push({ localPath: filePath, relativePath: path.relative(workspaceFolder, filePath), remoteContent });
        }
      }

      // Store the remote snapshot for monitoring
      remoteFileSnapshot = fileMap;
      
      // Apply .base44ignore filter
      const ignorePatterns = loadBase44IgnorePatterns();
      panelState.changedFiles = filterIgnoredFiles(newChangedFiles, ignorePatterns);
      
      persistChangedFiles();
      markSyncKnown();
      startMonitoringFileChanges(token);
      setIdle(`Sync done — ${panelState.changedFiles.length} file(s) out of sync`, "success");
      return true;
    } catch (err: any) {
      setIdle(`Sync error: ${err.message}`, "error");
      return false;
    }
  }

  function startMonitoringFileChanges(token: string) {
    stopMonitoring();
    
    // Watch for saved file changes in the workspace
    fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    
    fileWatcher.onDidChange(async (uri) => {
      const filePath = uri.fsPath;
      if (remoteFileSnapshot.hasOwnProperty(filePath)) {
        // This file is in our tracked set, check if it differs from remote
        try {
          const relativePath = path.relative(workspaceFolder, filePath);
          
          // Check if file is ignored
          const ignorePatterns = loadBase44IgnorePatterns();
          if (shouldIgnoreFile(relativePath, ignorePatterns)) {
            // Remove from changed files if it was there
            panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== filePath);
            persistChangedFiles();
            postState();
            return;
          }
          
          const localContent = normalize(await vscode.workspace.fs.readFile(uri).then(b => b.toString()));
          const remoteContent = normalize(remoteFileSnapshot[filePath]);
          
          if (localContent !== remoteContent) {
            // File is out of sync, add to list if not already there
            if (!panelState.changedFiles.find(f => f.localPath === filePath)) {
              panelState.changedFiles.push({
                localPath: filePath,
                relativePath: relativePath,
                remoteContent: remoteFileSnapshot[filePath],
              });
              persistChangedFiles();
              postState();
            }
          } else {
            // File is now in sync, remove from list
            panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== filePath);
            persistChangedFiles();
            postState();
          }
        } catch {
          // Ignore errors reading files
        }
      }
    });

    context.subscriptions.push(fileWatcher);
  }

  // ---- SIDEBAR PROVIDER ----
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      panel = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getWebviewHtml();

      // Send current state when panel opens
      setTimeout(() => postState(), 100);

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case "login":
            await vscode.commands.executeCommand("extension.login");
            break;
          case "selectApp":
            await selectApp(msg.appId, msg.appName);
            break;
          case "pushFile":
            await vscode.commands.executeCommand("extension.deploy");
            break;
          case "pushAll":
            await vscode.commands.executeCommand("extension.deployAll");
            break;
          case "pull":
            await vscode.commands.executeCommand("extension.pull");
            break;
          case "checkSync":
            await vscode.commands.executeCommand("extension.checkSync");
            break;
          case "diffFile":
            await showDiff(msg.localPath, msg.remoteContent, msg.relativePath);
            break;
          case "pushChangedFile":
            await pushChangedFile(msg.localPath);
            break;
          case "pullChangedFile":
            await pullChangedFile(msg.localPath, msg.remoteContent);
            break;
          case "addToIgnore":
            await addToBase44Ignore(msg.relativePath);
            break;
          case "fileOpError":
            // no-op: error already sent via postMessage below
            break;
          case "ready":
            postState();
            break;
        }
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("base44Sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ---- HELPERS ----
  async function runLogin(): Promise<Base44Config | null> {
    setStatus("Opening login window...", "progress");

    const chromePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    const executablePath = chromePaths.find(p => fs.existsSync(p));
    if (!executablePath) {
      vscode.window.showErrorMessage("Google Chrome not found.");
      setIdle("Chrome not found", "error");
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

    setStatus("Waiting for login...", "progress");
    let token: string | null = null;
    while (!token) {
      await new Promise(r => setTimeout(r, 1500));
      try { token = await page.evaluate(() => localStorage.getItem("token")); } catch { }
    }
    await browser.close();

    if (!token) {
      setIdle("Login failed", "error");
      return null;
    }

    setStatus("Fetching apps...", "progress");
    const apps = await fetchAppsWithToken(token);
    if (!apps) {
      setIdle("Failed to fetch apps", "error");
      return null;
    }

    panelState.apps = apps;
    panelState.loggedIn = true;

    // Try to restore previously selected app
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    let existingConfig: Base44Config | null = null;
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      existingConfig = JSON.parse(content.toString());
    } catch { }

    const selectedApp = existingConfig?.appId
      ? apps.find(a => a.id === existingConfig!.appId) ?? apps[0]
      : apps[0];

    const config: Base44Config = { appId: selectedApp.id, appName: selectedApp.name, token };
    panelState.selectedAppId = selectedApp.id;
    panelState.appName = selectedApp.name;

    await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(config, null, 2), "utf8"));
    
    // Update bootstrap state and start sync
    markReady();
    await runSyncBaseline(token);
    return config;
  }

  async function selectApp(appId: string, appName: string) {
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      const config = JSON.parse(content.toString()) as Base44Config;
      config.appId = appId;
      config.appName = appName;
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(config, null, 2), "utf8"));
      panelState.selectedAppId = appId;
      panelState.appName = appName;
      
      // Mark sync as unknown for the new app and start baseline sync
      markSyncUnknown();
      setStatus(`Switching to ${appName}...`, "progress");
      await runSyncBaseline(config.token);
    } catch {
      vscode.window.showErrorMessage("Please login first.");
    }
  }

  async function getProjectConfig(): Promise<Base44Config | null> {
    const configUri = vscode.Uri.file(path.join(workspaceFolder, "base44-config.json"));
    try {
      const content = await vscode.workspace.fs.readFile(configUri);
      const config = JSON.parse(content.toString()) as Base44Config;
      if (config.appId && config.token) {
        panelState.loggedIn = true;
        panelState.selectedAppId = config.appId;
        panelState.appName = config.appName || config.appId;
        return config;
      }
    } catch { }
    return runLogin();
  }

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

    const response = await fetch(`https://app.base44.com/api/apps/${config.appId}/coding/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ file_path: apiPath, content: document.getText() }),
    });

    if (response.status === 401) { throw new Error("401 Unauthorized"); }
    if (!response.ok) { throw new Error(`Deploy failed for ${relativePath}: ${response.statusText}`); }

    // Remove from changed files list after successful push and update snapshot
    panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== filePath);
    remoteFileSnapshot[filePath] = document.getText();
    persistChangedFiles();
    postState();
  }

  async function fetchRemoteFiles(config: Base44Config): Promise<Record<string, string>> {
    const response = await fetch(`https://app.base44.com/api/apps/${config.appId}/sandbox/files`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    });
    if (response.status === 401) { throw new Error("401 Unauthorized"); }
    if (!response.ok) { throw new Error(`Pull failed: ${response.statusText}`); }

    const data = (await response.json()) as { files?: Record<string, string> };
    const fileMap: Record<string, string> = {};
    const workspaceRoot = path.resolve(workspaceFolder);
    for (const [remotePath, content] of Object.entries(data.files || {})) {
      const rel = remotePath.replace(/^[/\\]+/, "").split(/[/\\]/).filter(s => s !== ".." && s !== ".").join(path.sep);
      const target = path.resolve(workspaceRoot, rel);
      if (target.startsWith(workspaceRoot + path.sep) || target === workspaceRoot) {
        fileMap[target] = content;
      }
    }
    return fileMap;
  }

  async function ensureLocalFileExists(filePath: string, content: string) {
    const exists = await vscode.workspace.fs.stat(vscode.Uri.file(filePath)).then(() => true, () => false);
    if (!exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, "utf8"));
    }
  }

  async function showDiff(localPath: string, remoteContent: string, relativePath: string) {
    const scheme = "base44remote";
    const remoteUri = vscode.Uri.parse(`${scheme}:${localPath}`);
    const disposable = vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: () => remoteContent,
    });
    context.subscriptions.push(disposable);
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(localPath),
      remoteUri,
      `Local ⟷ Remote: ${path.basename(relativePath)}`
    );
  }

  async function pushChangedFile(localPath: string) {
    const config = await getProjectConfig();
    if (!config) {
      panel?.webview.postMessage({ type: "fileOpDone", localPath, error: "Not logged in" });
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(localPath);
      await deployFile(config, doc);
      setIdle(`Pushed ${path.basename(localPath)}`, "success");
      postState();
    } catch (err: any) {
      panel?.webview.postMessage({ type: "fileOpDone", localPath, error: err.message });
      setIdle(`Push failed: ${err.message}`, "error");
    }
  }

  async function pullChangedFile(localPath: string, remoteContent: string) {
    try {
      await ensureLocalFileExists(localPath, remoteContent);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(localPath), Buffer.from(remoteContent, "utf8"));
      panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== localPath);
      remoteFileSnapshot[localPath] = remoteContent;
      persistChangedFiles();
      setIdle(`Pulled ${path.basename(localPath)}`, "success");
      postState();
    } catch (err: any) {
      panel?.webview.postMessage({ type: "fileOpDone", localPath, error: err.message });
      setIdle(`Pull failed: ${err.message}`, "error");
    }
  }

  // ---- COMMANDS ----
  const loginCmd = vscode.commands.registerCommand("extension.login", async () => {
    await runLogin();
  });

  const deployCmd = vscode.commands.registerCommand("extension.deploy", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage("No file open."); return; }

    setStatus(`Pushing ${path.basename(editor.document.uri.fsPath)}...`, "progress");
    try {
      await deployFile(config, editor.document);
      setIdle(`Pushed ${path.relative(workspaceFolder, editor.document.uri.fsPath)}`, "success");
    } catch (err: any) {
      if (err.message?.includes("401")) {
        config = await runLogin();
        if (config) { await deployFile(config, editor.document); }
      } else {
        setIdle(`Push failed: ${err.message}`, "error");
      }
    }
  });

  const deployAllCmd = vscode.commands.registerCommand("extension.deployAll", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }
    const docs = vscode.workspace.textDocuments.filter(d => !d.isUntitled);
    if (!docs.length) { vscode.window.showErrorMessage("No files open."); return; }

    let done = 0, errors = 0;
    for (const doc of docs) {
      setStatus(`Pushing ${path.basename(doc.uri.fsPath)}... (${done + 1}/${docs.length})`, "progress",
        Math.round(((done) / docs.length) * 100));
      try {
        await deployFile(config!, doc);
        done++;
      } catch (err: any) {
        if (err.message?.includes("401")) { config = await runLogin() ?? config; }
        errors++;
      }
    }
    setIdle(errors === 0 ? `Pushed ${done} files` : `Pushed ${done}, failed ${errors}`, errors === 0 ? "success" : "error");
  });

  const checkSyncCmd = vscode.commands.registerCommand("extension.checkSync", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }
    
    await runSyncBaseline(config.token);
  });

  const pullCmd = vscode.commands.registerCommand("extension.pull", async () => {
    let config = await getProjectConfig();
    if (!config) { return; }

    setStatus("Fetching remote files...", "progress");
    try {
      let fileMap: Record<string, string>;
      try {
        fileMap = await fetchRemoteFiles(config);
      } catch (err: any) {
        if (err.message?.includes("401")) {
          config = await runLogin();
          if (!config) { return; }
          fileMap = await fetchRemoteFiles(config);
        } else { throw err; }
      }

      // Load ignore patterns
      const ignorePatterns = loadBase44IgnorePatterns();
      
      const total = Object.keys(fileMap).length;
      let done = 0;
      let ignoredCount = 0;
      const newChangedFiles: ChangedFile[] = [];

      for (const [filePath, remoteContent] of Object.entries(fileMap)) {
        done++;
        const relativePath = path.relative(workspaceFolder, filePath);
        
        // Check if file should be ignored
        if (shouldIgnoreFile(relativePath, ignorePatterns)) {
          ignoredCount++;
          continue; // Skip this file entirely - don't write, don't compare
        }
        
        setStatus(`Pulling files... (${done}/${total})`, "progress", Math.round((done / total) * 100));
        await ensureLocalFileExists(filePath, remoteContent);

        const localContent = normalize(
          await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(b => b.toString(), () => "")
        );

        if (normalize(remoteContent) !== localContent) {
          newChangedFiles.push({ localPath: filePath, relativePath, remoteContent });
        }
      }

      // Update remote snapshot and sync state
      remoteFileSnapshot = fileMap;
      panelState.changedFiles = newChangedFiles;
      persistChangedFiles();
      markSyncKnown();
      startMonitoringFileChanges(config.token);

      const pulledCount = total - ignoredCount;
      const statusMsg = ignoredCount > 0 
        ? `Pulled ${pulledCount} files, ${newChangedFiles.length} changed, ${ignoredCount} ignored`
        : `Pulled ${total} files, ${newChangedFiles.length} changed`;
      setIdle(statusMsg, newChangedFiles.length > 0 ? "success" : "success");
    } catch (err: any) {
      setIdle(`Pull error: ${err.message}`, "error");
    }
  });

  context.subscriptions.push(loginCmd, deployCmd, deployAllCmd, pullCmd, checkSyncCmd);
}

export function deactivate() {}

function getWebviewHtml(): string {
  const htmlPath = path.join(__dirname, '..', 'webview', 'index.html');
  return fs.readFileSync(htmlPath, 'utf-8');
}
