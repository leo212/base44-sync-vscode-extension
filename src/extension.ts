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
  status: "modified" | "added" | "deleted";
  isPushing?: boolean;
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

class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFile> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangedFile | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getChildren(element?: ChangedFile): ChangedFile[] {
    if (!element) {
      return panelState.changedFiles;
    }
    return [];
  }

  getTreeItem(element: ChangedFile): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.relativePath,
      vscode.TreeItemCollapsibleState.None
    );

    const shortStatus = element.status === "added" ? "A" : element.status === "deleted" ? "D" : "M";
    item.description = element.isPushing ? "uploading..." : shortStatus;
    item.contextValue = element.isPushing 
      ? "base44ChangedFilePushing" 
      : element.status === "deleted" 
        ? "base44DeletedFile" 
        : element.status === "added"
          ? "base44AddedFile"
          : "base44ChangedFile";

    // Strikeout for deleted files using combining strikethrough characters (or Unicode strikethrough)
    if (element.status === "deleted") {
      const strikedLabel = element.relativePath.split("").map(c => c + "\u0336").join("");
      item.label = strikedLabel;
      item.iconPath = new vscode.ThemeIcon("file", new vscode.ThemeColor("charts.red"));
      item.tooltip = `Remote file missing locally (Deleted): ${element.localPath}\nClick to view remote content. Revert to create locally.`;
      item.command = {
        command: "extension.openChangedFileDiff",
        title: "View Content",
        arguments: [element],
      };
    } else if (element.status === "added") {
      item.iconPath = new vscode.ThemeIcon("file-added", new vscode.ThemeColor("charts.green"));
      item.tooltip = `Local file added: ${element.localPath}\nThis file is not present on the remote server.`;
      item.command = {
        command: "extension.openAddedFile",
        title: "Open File",
        arguments: [element],
      };
    } else if (!element.isPushing && element.status === "modified") {
      item.iconPath = new vscode.ThemeIcon("file-code");
      item.tooltip = `Local: ${element.localPath}\nRemote version differs from your workspace file.`;
      item.command = {
        command: "extension.openChangedFileDiff",
        title: "Open Diff",
        arguments: [element],
      };
    } else {
      item.tooltip = `Uploading ${element.relativePath} to Base44...`;
    }

    return item;
  }
}

let panel: vscode.WebviewView | undefined;
let changedFilesProvider: ChangedFilesProvider | undefined;
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
  changedFilesProvider?.refresh();
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
  changedFilesProvider?.refresh();
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
  changedFilesProvider = new ChangedFilesProvider();

  // Do NOT restore persisted changed files; always start with sync unknown state

  // Bootstrap: validate config and token before showing normal UI
  (async () => {
    displayBootstrapValidation();
  })();

  function persistChangedFiles() {
    context.globalState.update("base44.changedFiles", panelState.changedFiles);
    changedFilesProvider?.refresh();
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
    const normalizedPath = relativePath.replace(/\\/g, "/");
    let normalizedPattern = pattern.replace(/\\/g, "/");

    const isDirectoryPattern = normalizedPattern.endsWith("/");
    if (isDirectoryPattern) {
      normalizedPattern = normalizedPattern.slice(0, -1);
    }

    // Split paths into segments
    const pathSegments = normalizedPath.split("/");
    const patternSegments = normalizedPattern.split("/");

    if (isDirectoryPattern) {
      // If pattern ends with /, e.g., "backend/", it matches if normalizedPath starts with pattern segments
      if (pathSegments.length >= patternSegments.length) {
        let matches = true;
        for (let i = 0; i < patternSegments.length; i++) {
          if (pathSegments[i] !== patternSegments[i]) {
            matches = false;
            break;
          }
        }
        if (matches) return true;
      }
    } else {
      // If pattern does not end with /, e.g., "backend", every file under backend folder and subfolders AND every file starting with backend is ignored
      // 1. Exact match or folder prefix match
      if (pathSegments.length >= patternSegments.length) {
        let matches = true;
        for (let i = 0; i < patternSegments.length; i++) {
          if (pathSegments[i] !== patternSegments[i]) {
            matches = false;
            break;
          }
        }
        if (matches) return true;
      }

      // 2. File or path starting with pattern (e.g. filename starting with backend or path segment starting with backend)
      const fileName = pathSegments[pathSegments.length - 1];
      if (fileName.startsWith(normalizedPattern) || normalizedPath.startsWith(normalizedPattern)) {
        return true;
      }
    }

    // Glob pattern fallback if contains *
    if (normalizedPattern.includes("*")) {
      const regexPattern = normalizedPattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "<<DOUBLESTAR>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<DOUBLESTAR>>/g, ".*");
      const regex = new RegExp(`^${regexPattern}(/|$)`);
      const strictRegex = new RegExp(`^${regexPattern}$`);
      return strictRegex.test(normalizedPath) || regex.test(normalizedPath) || normalizedPath.includes(normalizedPattern);
    }

    return false;
  }

  function shouldIgnoreFile(relativePath: string, patterns: string[]): boolean {
    return patterns.some(pattern => matchesPattern(relativePath, pattern));
  }

  function filterIgnoredFiles(files: ChangedFile[], patterns: string[]): ChangedFile[] {
    return files.filter(f => !shouldIgnoreFile(f.relativePath, patterns));
  }

  async function refreshChangedFilesFromSnapshot(message = "Changes updated"): Promise<void> {
    if (!panelState.syncKnown) {
      return;
    }

    const workspaceFiles = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,.vscode}/**", 20000);
    const localFiles = new Set<string>();
    for (const uri of workspaceFiles) {
      const filePath = uri.fsPath;
      const relativePath = path.relative(workspaceFolder, filePath);
      if (!relativePath || relativePath.startsWith("..")) continue;
      localFiles.add(filePath);
    }

    const changedFiles: ChangedFile[] = [];
    const seenRemotePaths = new Set<string>();
    for (const [filePath, remoteContent] of Object.entries(remoteFileSnapshot)) {
      seenRemotePaths.add(filePath);
      const relativePath = path.relative(workspaceFolder, filePath);
      if (!localFiles.has(filePath)) {
        changedFiles.push({ localPath: filePath, relativePath, remoteContent, status: "deleted" });
        continue;
      }

      const localContent = normalize(
        await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(b => b.toString(), () => "")
      );
      if (normalize(remoteContent) !== localContent) {
        changedFiles.push({ localPath: filePath, relativePath, remoteContent, status: "modified" });
      }
    }

    for (const filePath of localFiles) {
      if (seenRemotePaths.has(filePath)) continue;
      const relativePath = path.relative(workspaceFolder, filePath);
      changedFiles.push({ localPath: filePath, relativePath, remoteContent: "", status: "added" });
    }

    panelState.changedFiles = filterIgnoredFiles(changedFiles, loadBase44IgnorePatterns());
    persistChangedFiles();
    setIdle(`${message} — ${panelState.changedFiles.length} file(s) out of sync`, "success");
  }

  async function addToBase44Ignore(relativePath: string): Promise<void> {
    const ignoreFile = path.join(workspaceFolder, ".base44ignore");
    let content = "";

    try {
      if (fs.existsSync(ignoreFile)) {
        content = fs.readFileSync(ignoreFile, "utf-8");
        if (content && !content.endsWith("\n")) {
          content += "\n";
        }
      }
    } catch {
      // File doesn't exist or can't be read, start fresh
    }

    content += relativePath + "\n";
    fs.writeFileSync(ignoreFile, content, "utf-8");

    await refreshChangedFilesFromSnapshot("Ignore rules updated");
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

      const workspaceFiles = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,.vscode}/**", 20000);
      const localFiles = new Set<string>();
      for (const uri of workspaceFiles) {
        const filePath = uri.fsPath;
        const relativePath = path.relative(workspaceFolder, filePath);
        if (!relativePath || relativePath.startsWith("..")) continue;
        localFiles.add(filePath);
      }

      const total = Object.keys(fileMap).length;
      let done = 0;
      const newChangedFiles: ChangedFile[] = [];
      const seenRemotePaths = new Set<string>();

      for (const [filePath, remoteContent] of Object.entries(fileMap)) {
        done++;
        seenRemotePaths.add(filePath);
        setStatus(`Comparing files... (${done}/${total})`, "progress", Math.round((done / total) * 100));

        const relativePath = path.relative(workspaceFolder, filePath);
        const localExists = localFiles.has(filePath);
        if (!localExists) {
          newChangedFiles.push({ localPath: filePath, relativePath, remoteContent, status: "deleted" });
          continue;
        }

        const localContent = normalize(
          await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(b => b.toString(), () => "")
        );
        if (normalize(remoteContent) !== localContent) {
          newChangedFiles.push({ localPath: filePath, relativePath, remoteContent, status: "modified" });
        }
      }

      for (const filePath of localFiles) {
        if (seenRemotePaths.has(filePath)) continue;
        const relativePath = path.relative(workspaceFolder, filePath);
        if (!relativePath || relativePath.startsWith("..")) continue;
        newChangedFiles.push({ localPath: filePath, relativePath, remoteContent: "", status: "added" });
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
    
    // Watch for saved file changes and .base44ignore changes in the workspace
    fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    
    fileWatcher.onDidChange(async (uri) => {
      const filePath = uri.fsPath;
      const relativePath = path.relative(workspaceFolder, filePath);
      
      // Check if .base44ignore was modified
      if (path.basename(filePath) === ".base44ignore") {
        await refreshChangedFilesFromSnapshot("Ignore rules updated");
        return;
      }

      if (remoteFileSnapshot.hasOwnProperty(filePath)) {
        // This file is in our tracked set, check if it differs from remote
        try {
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
                status: "modified",
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

    fileWatcher.onDidCreate(async (uri) => {
      const filePath = uri.fsPath;
      const relativePath = path.relative(workspaceFolder, filePath);
      if (path.basename(filePath) === ".base44ignore") {
        await refreshChangedFilesFromSnapshot("Ignore rules updated");
        return;
      }
      const ignorePatterns = loadBase44IgnorePatterns();
      if (shouldIgnoreFile(relativePath, ignorePatterns)) return;

      if (!relativePath || relativePath.startsWith("..") || relativePath.includes(".git") || relativePath.includes("node_modules")) return;

      // If it exists in remote snapshot, check if modified, otherwise it's added
      if (remoteFileSnapshot.hasOwnProperty(filePath)) {
        // Handled or check
      } else {
        if (!panelState.changedFiles.find(f => f.localPath === filePath)) {
          panelState.changedFiles.push({
            localPath: filePath,
            relativePath,
            remoteContent: "",
            status: "added",
          });
          persistChangedFiles();
          postState();
        }
      }
    });

    fileWatcher.onDidDelete(async (uri) => {
      const filePath = uri.fsPath;
      const relativePath = path.relative(workspaceFolder, filePath);
      if (path.basename(filePath) === ".base44ignore") {
        await refreshChangedFilesFromSnapshot("Ignore rules updated");
        return;
      }
      const ignorePatterns = loadBase44IgnorePatterns();
      if (shouldIgnoreFile(relativePath, ignorePatterns)) return;

      // If it was in remote snapshot, it's now deleted locally
      if (remoteFileSnapshot.hasOwnProperty(filePath)) {
        if (!panelState.changedFiles.find(f => f.localPath === filePath)) {
          panelState.changedFiles.push({
            localPath: filePath,
            relativePath,
            remoteContent: remoteFileSnapshot[filePath],
            status: "deleted",
          });
          persistChangedFiles();
          postState();
        }
      } else {
        // Was an added local file that got deleted
        panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== filePath);
        persistChangedFiles();
        postState();
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
          case "syncStatus":
            await vscode.commands.executeCommand("extension.syncStatus");
            break;
          case "diffFile":
            await showDiff(msg.localPath, msg.remoteContent, msg.relativePath);
            break;
          case "pushChangedFile":
            await pushChangedFile(msg.localPath);
            break;
          case "pullChangedFile":
          case "revertChangedFile":
            await revertChangedFile(msg.localPath, msg.remoteContent);
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

  const changedFilesTree = vscode.window.createTreeView("base44ChangedFiles", {
    treeDataProvider: changedFilesProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("base44Sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    changedFilesTree
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
    } else if (path.basename(filePath).endsWith(".js") || 
    path.basename(filePath).endsWith(".css") || 
    path.basename(filePath).endsWith(".json") ||     
    path.basename(filePath) === "index.jsx" || 
    path.basename(filePath) === "App.jsx") {
      apiPath = "src/" + relativePath.replaceAll("\\", "/");
    } else if (relativePath.startsWith("..\\base44\\entities")) {
      apiPath = relativePath.replaceAll("\\", "/").replace(/^(\.\.\/)+/, "");
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

    const changedFile = panelState.changedFiles.find(f => f.localPath === localPath);
    if (!changedFile || changedFile.status === "deleted") {
      return; // Deleted files cannot be pushed
    }

    changedFile.isPushing = true;
    changedFilesProvider?.refresh();

    try {
      const doc = await vscode.workspace.openTextDocument(localPath);
      await deployFile(config, doc);
      setIdle(`Pushed ${path.basename(localPath)}`, "success");
      postState();
    } catch (err: any) {
      panel?.webview.postMessage({ type: "fileOpDone", localPath, error: err.message });
      setIdle(`Push failed: ${err.message}`, "error");
    } finally {
      const file = panelState.changedFiles.find(f => f.localPath === localPath);
      if (file) { file.isPushing = false; }
      changedFilesProvider?.refresh();
      postState();
    }
  }

  async function revertChangedFile(localPath: string, remoteContent: string) {
    const file = panelState.changedFiles.find(f => f.localPath === localPath);
    if (!file) { return; }

    const choice = await vscode.window.showWarningMessage(
      `Revert ${file.relativePath} to the server version?`,
      { modal: true },
      "Revert",
      "Cancel"
    );
    if (choice !== "Revert") { return; }

    try {
      await ensureLocalFileExists(localPath, remoteContent);
      await vscode.workspace.fs.writeFile(vscode.Uri.file(localPath), Buffer.from(remoteContent, "utf8"));
      panelState.changedFiles = panelState.changedFiles.filter(f => f.localPath !== localPath);
      remoteFileSnapshot[localPath] = remoteContent;
      persistChangedFiles();
      setIdle(`Reverted ${path.basename(localPath)}`, "success");
      postState();
    } catch (err: any) {
      panel?.webview.postMessage({ type: "fileOpDone", localPath, error: err.message });
      setIdle(`Revert failed: ${err.message}`, "error");
    }
  }

  // ---- COMMANDS ----
  const openChangedFileDiffCmd = vscode.commands.registerCommand("extension.openChangedFileDiff", async (file: ChangedFile) => {
    if (!file) { return; }
    if (file.status === "deleted") {
      // Show remote content directly in a read-only document / preview
      const scheme = "base44remote";
      const remoteUri = vscode.Uri.parse(`${scheme}:${file.localPath}`);
      const disposable = vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: () => file.remoteContent,
      });
      context.subscriptions.push(disposable);
      const doc = await vscode.workspace.openTextDocument(remoteUri);
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    await showDiff(file.localPath, file.remoteContent, file.relativePath);
  });

  const openAddedFileCmd = vscode.commands.registerCommand("extension.openAddedFile", async (file: ChangedFile) => {
    if (!file) { return; }
    const doc = await vscode.workspace.openTextDocument(file.localPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  const pushChangedFileFromTreeCmd = vscode.commands.registerCommand("extension.pushChangedFileFromTree", async (file: ChangedFile) => {
    if (!file) { return; }
    await pushChangedFile(file.localPath);
    changedFilesProvider?.refresh();
  });

  const revertChangedFileFromTreeCmd = vscode.commands.registerCommand("extension.revertChangedFileFromTree", async (file: ChangedFile) => {
    if (!file) { return; }
    await revertChangedFile(file.localPath, file.remoteContent);
    changedFilesProvider?.refresh();
  });

  const ignoreChangedFileFromTreeCmd = vscode.commands.registerCommand("extension.ignoreChangedFileFromTree", async (file: ChangedFile) => {
    if (!file) { return; }
    await addToBase44Ignore(file.relativePath);
    changedFilesProvider?.refresh();
  });

  const syncStatusCmd = vscode.commands.registerCommand("extension.syncStatus", async () => {
    const config = await getProjectConfig();
    if (!config) { return; }
    await runSyncBaseline(config.token);
    changedFilesProvider?.refresh();
  });

  const pushAllChangesCmd = vscode.commands.registerCommand("extension.pushAllChangedFiles", async () => {
    if (!panelState.changedFiles.length) { return; }

    const config = await getProjectConfig();
    if (!config) { return; }

    for (const file of panelState.changedFiles) {
      if (file.status === "deleted") {
        continue;
      }

      const existing = panelState.changedFiles.find(f => f.localPath === file.localPath);
      if (!existing) { continue; }
      existing.isPushing = true;
      changedFilesProvider?.refresh();

      try {
        const doc = await vscode.workspace.openTextDocument(file.localPath);
        await deployFile(config, doc);
      } catch (err: any) {
        existing.isPushing = false;
        changedFilesProvider?.refresh();
        setIdle(`Push failed: ${err.message}`, "error");
        return;
      } finally {
        existing.isPushing = false;
        changedFilesProvider?.refresh();
      }
    }

    setIdle(`Pushed ${panelState.changedFiles.filter(f => f.status !== "deleted").length} changed files`, "success");
  });

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
          newChangedFiles.push({ localPath: filePath, relativePath, remoteContent, status: "modified" });
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

  context.subscriptions.push(
    openChangedFileDiffCmd,
    openAddedFileCmd,
    pushChangedFileFromTreeCmd,
    revertChangedFileFromTreeCmd,
    ignoreChangedFileFromTreeCmd,
    syncStatusCmd,
    pushAllChangesCmd,
    loginCmd,
    deployCmd,
    deployAllCmd,
    pullCmd,
    checkSyncCmd
  );
}

export function deactivate() {}

function getWebviewHtml(): string {
  const htmlPath = path.join(__dirname, '..', 'webview', 'index.html');
  return fs.readFileSync(htmlPath, 'utf-8');
}
