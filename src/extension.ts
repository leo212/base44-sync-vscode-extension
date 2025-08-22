import * as vscode from "vscode";
import * as path from "path";
import * as Diff from "diff";

let nextChangeId = 1;

export interface PendingChange {
  id: number; // unique identifier
  kind: ChangeKind;
  range: vscode.Range; // sticky range
  remoteText: string;
}
type ChangeKind = "added" | "removed" | "changed";


const removedDecoType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: "rgba(255,0,0,0.18)",
  rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
});

const changedDecoType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: "rgba(128,128,128,0.18)",
  rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
});

const addedDecoType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: "rgba(0,128,0,0.12)",
  border: "1px dashed rgba(0,128,0,0.6)",
  rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
});

// docUri -> (line -> PendingChange)
export const pendingByDoc = new Map<string, PendingChange[]>();

function makeHover(ch: PendingChange, docUri: vscode.Uri) {
  const args = (o: any) => encodeURIComponent(JSON.stringify(o));
  
  // Create a code block for the remote text to preserve formatting and newlines
  const remoteTextFormatted = '```\n' + ch.remoteText + '\n```';
  
  const md = new vscode.MarkdownString(
    `**Remote:**\n` +
    remoteTextFormatted +
    `\n\n[✅ Accept](command:extension.acceptChange?${args({ uri: docUri.toString(), id: ch.id })})` +
    `  |  [❌ Reject](command:extension.rejectChange?${args({ uri: docUri.toString(), id: ch.id })})`
  );
  md.isTrusted = true;
  return md;
}


export async function refreshDecorationsFor(docUri: vscode.Uri) {
  const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === docUri.toString());
  if (!editor) return;

  const pending = pendingByDoc.get(docUri.toString()) || [];

  const removedDecos: vscode.DecorationOptions[] = [];
  const changedDecos: vscode.DecorationOptions[] = [];
  const addedDecos: vscode.DecorationOptions[] = [];

  for (const ch of pending) {
    var decoRange = ch.range;
    if (ch.range.end.character == 0) {
      // remove the last line from the range
      decoRange = new vscode.Range(ch.range.start, new vscode.Position(ch.range.end.line - 1, editor.document.lineAt(ch.range.end.line - 1).range.end.character));
    }

    const deco: vscode.DecorationOptions = { range: decoRange, hoverMessage: makeHover(ch, docUri) };
    if (ch.kind === "removed") removedDecos.push(deco);
    else if (ch.kind === "changed") changedDecos.push(deco);
    else if (ch.kind === "added") addedDecos.push(deco);
  }

  editor.setDecorations(removedDecoType, removedDecos);
  editor.setDecorations(changedDecoType, changedDecos);
  editor.setDecorations(addedDecoType, addedDecos);
}

export function markChanges(editor: vscode.TextEditor, diffs: Diff.ChangeObject<string>[]) {
  const docUri = editor.document.uri;
  const pending: PendingChange[] = [];

  let li = 0; // local line index
  let nextChangeIdLocal = nextChangeId;

  const removedDecos: vscode.DecorationOptions[] = [];
  const changedDecos: vscode.DecorationOptions[] = [];
  const addedDecos: vscode.DecorationOptions[] = [];

  for (let i = 0; i < diffs.length; i++) {
    const part = diffs[i];

    // Check for a 'removed' followed immediately by an 'added' block
    if (part.removed && diffs[i + 1]?.added) {
      const removedText = part.value;
      const addedText = diffs[i + 1].value;

      const removedLines = removedText.split('\n');
      const removedLinesCount = removedLines.length - (removedText.endsWith('\n') ? 1 : 0);

      const startLine = li;
      const endLine = li + removedLinesCount - 1;

      // Corrected: Create a range that includes the line break of the last line
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        editor.document.lineAt(endLine).rangeIncludingLineBreak.end
      );

      const ch: PendingChange = {
        id: nextChangeIdLocal++,
        kind: "changed",
        range: range,
        remoteText: addedText,
      };

      pending.push(ch);
      
      var decoRange = ch.range;
      if (ch.range.end.character == 0) {
        // remove the last line from the range
        decoRange = new vscode.Range(ch.range.start, new vscode.Position(ch.range.end.line - 1, editor.document.lineAt(ch.range.end.line - 1).range.end.character));
      }

      changedDecos.push({ range: decoRange, hoverMessage: makeHover(ch, docUri) });

      li += removedLinesCount;
      i++;
      continue;
    }

    if (part.removed) {
      const removedText = part.value;
      const linesCount = removedText.split('\n').length - (removedText.endsWith('\n') ? 1 : 0);
      const startLine = li;
      const endLine = li + linesCount - 1;

      // Corrected: Create a range that includes the line break of the last line
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        editor.document.lineAt(endLine).rangeIncludingLineBreak.end
      );

      const ch: PendingChange = {
        id: nextChangeIdLocal++,
        kind: "removed",
        range: range,
        remoteText: "",
      };

      pending.push(ch);
      
      var decoRange = ch.range;
      if (ch.range.end.character == 0) {
        // remove the last line from the range
        decoRange = new vscode.Range(ch.range.start, new vscode.Position(ch.range.end.line - 1, editor.document.lineAt(ch.range.end.line - 1).range.end.character));
      }
      removedDecos.push({ range: decoRange, hoverMessage: makeHover(ch, docUri) });
      li += linesCount;
      continue;
    }

    if (part.added) {
      const addedText = part.value;
      const insertLine = li;

      const ch: PendingChange = {
        id: nextChangeIdLocal++,
        kind: "added",
        range: new vscode.Range(insertLine, 0, insertLine, 0),
        remoteText: addedText,
      };

      pending.push(ch);
      var decoRange = ch.range;
      if (ch.range.end.character == 0 && ch.range.end.line > 0) {
        // remove the last line from the range
        decoRange = new vscode.Range(ch.range.start, new vscode.Position(ch.range.end.line - 1, editor.document.lineAt(ch.range.end.line - 1).range.end.character));
      }
      addedDecos.push({ range: decoRange, hoverMessage: makeHover(ch, docUri) });
      continue;
    }

    // unchanged
    const linesInPart = part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
    li += linesInPart;
  }

  nextChangeId = nextChangeIdLocal;
  pendingByDoc.set(docUri.toString(), pending);

  editor.setDecorations(removedDecoType, removedDecos);
  editor.setDecorations(changedDecoType, changedDecos);
  editor.setDecorations(addedDecoType, addedDecos);
}



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
      var changedFiles = 0;

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

        const changes = Diff.diffLines(localContent, remoteContentNormalized);
        if (changes.some((c) => c.added || c.removed)) {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(filePath)
          );
          const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
          });

          markChanges(editor, changes);

          changedFiles++;
        }
      }

      if (changedFiles > 0) {
        vscode.window.showInformationMessage(
          `Pull finished. ${changedFiles} files needs review.`
        );
      } else {
        vscode.window.showInformationMessage("No changes found.");
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Pull error: ${err.message}`);
      console.error("Pull error stack:", err);
    }
  });

  // ---- ACCEPT CHANGE COMMAND ----
  const acceptChangeCmd = vscode.commands.registerCommand(
    "extension.acceptChange",
    async (args: { uri: string; id: number }) => {
      try {
        const docUri = vscode.Uri.parse(args.uri);
        const pending = pendingByDoc.get(docUri.toString());
        if (!pending) return;

        const idx = pending.findIndex((ch) => ch.id === args.id);
        if (idx === -1) return;

        const ch = pending[idx];
        const doc = await vscode.workspace.openTextDocument(docUri);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
        });

        let lineDelta = 0;
        if (ch.kind === "removed") {
          const removedLinesCount = ch.range.end.line - ch.range.start.line + 1;
          lineDelta = -removedLinesCount;
        } else if (ch.kind === "changed") {
          const removedLinesCount = ch.range.end.line - ch.range.start.line;
          const addedLinesCount = ch.remoteText.split("\n").length - 1;
          lineDelta = addedLinesCount - removedLinesCount;
        } else if (ch.kind === "added") {
          const addedLinesCount = ch.remoteText.split("\n").length - 1;
          lineDelta = addedLinesCount;
        }

        await editor.edit((editBuilder) => {
          if (ch.kind === "removed") {
            editBuilder.delete(ch.range);
          } else if (ch.kind === "changed") {
            editBuilder.replace(ch.range, ch.remoteText);
          } else if (ch.kind === "added") {
            editBuilder.insert(ch.range.start, ch.remoteText);
          }
        });

        for (let i = idx + 1; i < pending.length; i++) {
          const other = pending[i];
          const newStart = other.range.start.line + lineDelta;
          const newEnd = other.range.end.line + lineDelta;

          other.range = new vscode.Range(
            newStart,
            other.range.start.character,
            newEnd,
            other.range.end.character
          );
        }

        pending.splice(idx, 1);
        if (pending.length === 0) pendingByDoc.delete(docUri.toString());
        else pendingByDoc.set(docUri.toString(), pending);

        const removed = pending.filter((c) => c.kind === "removed");
        const changed = pending.filter((c) => c.kind === "changed");
        const added = pending.filter((c) => c.kind === "added");

        editor.setDecorations(
          removedDecoType,
          removed.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );
        editor.setDecorations(
          changedDecoType,
          changed.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );
        editor.setDecorations(
          addedDecoType,
          added.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );

        if (pending.length === 0) {
          vscode.window.showInformationMessage(
            "All changes accepted for this file."
          );
        }
      } catch (err: any) {
        console.error("acceptChange error:", err);
      }
    }
  );

  const rejectChangeCmd = vscode.commands.registerCommand(
    "extension.rejectChange",
    async (args: { uri: string; id: number }) => {
      try {
        const docUri = vscode.Uri.parse(args.uri);
        const pending = pendingByDoc.get(docUri.toString());
        if (!pending) return;

        const idx = pending.findIndex((ch) => ch.id === args.id);
        if (idx === -1) return;

        pending.splice(idx, 1);
        if (pending.length === 0) pendingByDoc.delete(docUri.toString());
        else pendingByDoc.set(docUri.toString(), pending);

        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === docUri.toString()
        );
        if (!editor) return;

        const removed = pending.filter((c) => c.kind === "removed");
        const changed = pending.filter((c) => c.kind === "changed");
        const added = pending.filter((c) => c.kind === "added");

        editor.setDecorations(
          removedDecoType,
          removed.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );
        editor.setDecorations(
          changedDecoType,
          changed.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );
        editor.setDecorations(
          addedDecoType,
          added.map((c) => ({ range: c.range, hoverMessage: makeHover(c, docUri) }))
        );
      } catch (err: any) {
        console.error("rejectChange error:", err);
      }
    }
  );

  context.subscriptions.push(
    deployCmd,
    pullCmd,
    acceptChangeCmd,
    rejectChangeCmd
  );

  // When the active editor changes, refresh decorations for it.
  vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) {
        refreshDecorationsFor(editor.document.uri);
      }
    },
    null,
    context.subscriptions
  );

  // Also refresh for the currently active editor when the extension activates
  if (vscode.window.activeTextEditor) {
    refreshDecorationsFor(vscode.window.activeTextEditor.document.uri);
  }

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
