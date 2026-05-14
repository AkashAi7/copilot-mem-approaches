import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

type MemRecord = { text: string; ts: string; embedding?: number[] };

function readMemFile(file: string): MemRecord[] {
    if (!fs.existsSync(file)) return [];
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.map((entry: any): MemRecord => {
        if (typeof entry === "string") {
            const m = entry.match(/^\[(.+?)\]\s*(.*)$/);
            return m ? { ts: m[1], text: m[2] } : { ts: new Date().toISOString(), text: entry };
        }
        return { ts: entry.ts ?? new Date().toISOString(), text: String(entry.text ?? ""), embedding: entry.embedding };
    });
}

function writeMemFile(file: string, data: MemRecord[]) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

let embedderPromise: Promise<any> | null = null;
async function getEmbedder(): Promise<any> {
    if (!embedderPromise) {
        embedderPromise = (async () => {
            const tx = await import("@huggingface/transformers");
            return await tx.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true } as any);
        })().catch(err => { embedderPromise = null; throw err; });
    }
    return embedderPromise;
}

async function embed(text: string): Promise<number[] | undefined> {
    try {
        const pipe = await getEmbedder();
        const out = await pipe(text, { pooling: "mean", normalize: true });
        return Array.from(out.data as Float32Array);
    } catch (e) {
        console.error("Memory Lane embed failed", e);
        return undefined;
    }
}

class MemoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly index: number,
        public readonly tooltip: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = "memoryItem";
    }
}

class MemoryProvider implements vscode.TreeDataProvider<MemoryItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MemoryItem | undefined | void> = new vscode.EventEmitter<MemoryItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<MemoryItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private memoryFile: string) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MemoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<MemoryItem[]> {
        const data = readMemFile(this.memoryFile);
        const items = data.map((r, i) => {
            const preview = r.text.length > 50 ? r.text.substring(0, 50) + "..." : r.text;
            const tip = `[${r.ts}] ${r.text}` + (r.embedding ? "" : "  (no embedding)");
            return new MemoryItem(preview, i, tip);
        });
        return Promise.resolve(items.reverse());
    }

    deleteItem(index: number) {
        const data = readMemFile(this.memoryFile);
        data.splice(data.length - 1 - index, 1);
        writeMemFile(this.memoryFile, data);
        this.refresh();
    }
}

function writeHookFiles(hooksDir: string, memoryFile: string) {
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const captureScript = path.join(hooksDir, "capture.js");
    const settingsFile = path.join(hooksDir, "settings.json");

    const scriptBody = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const MEM = ${JSON.stringify(memoryFile)};
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
    try {
        const payload = raw ? JSON.parse(raw) : {};
        const tool = payload.tool_name || payload.tool || 'tool';
        const input = payload.tool_input || payload.input || {};
        const summary = JSON.stringify(input).slice(0, 300);
        let data = [];
        try { data = JSON.parse(fs.readFileSync(MEM, 'utf8')); } catch {}
        data.push('[' + new Date().toISOString() + '] [auto:' + tool + '] ' + summary);
        fs.mkdirSync(path.dirname(MEM), { recursive: true });
        fs.writeFileSync(MEM, JSON.stringify(data, null, 2));
    } catch (e) {}
    process.stdout.write(JSON.stringify({ continue: true }));
});
`;
    fs.writeFileSync(captureScript, scriptBody);

    const hookSettings = {
        hooks: {
            PostToolUse: [
                {
                    matcher: "*",
                    hooks: [
                        { type: "command", command: `node "${captureScript.replace(/\\/g, "\\\\")}"` }
                    ]
                }
            ]
        }
    };
    fs.writeFileSync(settingsFile, JSON.stringify(hookSettings, null, 2));
}

async function enableAutoCapture(hooksDir: string) {
    const config = vscode.workspace.getConfiguration();
    const existing = config.get<Record<string, boolean>>("chat.hookFilesLocations") || {};
    existing[hooksDir] = true;
    await config.update("chat.hookFilesLocations", existing, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Memory Lane: Auto-capture enabled. Reload window to activate hooks.");
}

const SMART_RECALL_MARKER_START = "<!-- memory-lane:start -->";
const SMART_RECALL_MARKER_END = "<!-- memory-lane:end -->";
const SMART_RECALL_BLOCK = `${SMART_RECALL_MARKER_START}
# Memory Lane (auto-managed)
- Before answering, silently invoke the \`lane_search\` tool with relevant keywords to recall any saved user preferences, decisions, or facts.
- When the user shares a preference, decision, fact, or says "remember"/"note this", silently invoke the \`lane_save\` tool to persist it. Do not ask permission.
- Keep saved entries concise and self-contained.
${SMART_RECALL_MARKER_END}`;

async function enableSmartRecall() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("Memory Lane: open a workspace folder first.");
        return;
    }
    const root = folders[0].uri.fsPath;
    const ghDir = path.join(root, ".github");
    const instrFile = path.join(ghDir, "copilot-instructions.md");
    if (!fs.existsSync(ghDir)) fs.mkdirSync(ghDir, { recursive: true });
    let existing = "";
    if (fs.existsSync(instrFile)) existing = fs.readFileSync(instrFile, "utf8");
    if (existing.includes(SMART_RECALL_MARKER_START)) {
        vscode.window.showInformationMessage("Memory Lane: Smart Recall already enabled in this workspace.");
        return;
    }
    const updated = (existing.trim() ? existing.trimEnd() + "\n\n" : "") + SMART_RECALL_BLOCK + "\n";
    fs.writeFileSync(instrFile, updated);
    vscode.window.showInformationMessage("Memory Lane: Smart Recall enabled. Copilot will now recall & save automatically.");
}

async function disableSmartRecall() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const instrFile = path.join(folders[0].uri.fsPath, ".github", "copilot-instructions.md");
    if (!fs.existsSync(instrFile)) return;
    let content = fs.readFileSync(instrFile, "utf8");
    const start = content.indexOf(SMART_RECALL_MARKER_START);
    const end = content.indexOf(SMART_RECALL_MARKER_END);
    if (start === -1 || end === -1) {
        vscode.window.showInformationMessage("Memory Lane: Smart Recall not found in this workspace.");
        return;
    }
    content = (content.slice(0, start) + content.slice(end + SMART_RECALL_MARKER_END.length)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(instrFile, content);
    vscode.window.showInformationMessage("Memory Lane: Smart Recall disabled.");
}

async function disableAutoCapture(hooksDir: string) {
    const config = vscode.workspace.getConfiguration();
    const existing = config.get<Record<string, boolean>>("chat.hookFilesLocations") || {};
    if (hooksDir in existing) {
        existing[hooksDir] = false;
        await config.update("chat.hookFilesLocations", existing, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage("Memory Lane: Auto-capture disabled.");
}

export function activate(context: vscode.ExtensionContext) {
    const memoryDir = path.join(context.globalStorageUri.fsPath, "memory");
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
    const memoryFile = path.join(memoryDir, "memories.json");
    if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, JSON.stringify([]));

    const hooksDir = path.join(context.globalStorageUri.fsPath, "hooks");
    writeHookFiles(hooksDir, memoryFile);

    const memoryProvider = new MemoryProvider(memoryFile);
    vscode.window.registerTreeDataProvider("memory-lane-explorer", memoryProvider);

    try {
        fs.watch(memoryFile, { persistent: false }, () => memoryProvider.refresh());
    } catch {}

    context.subscriptions.push(
        vscode.commands.registerCommand("memory-lane.refresh", () => memoryProvider.refresh()),
        vscode.commands.registerCommand("memory-lane.delete", (node: MemoryItem) => memoryProvider.deleteItem(node.index)),
        vscode.commands.registerCommand("memory-lane.enableAutoCapture", () => enableAutoCapture(hooksDir)),
        vscode.commands.registerCommand("memory-lane.disableAutoCapture", () => disableAutoCapture(hooksDir)),
        vscode.commands.registerCommand("memory-lane.enableSmartRecall", () => enableSmartRecall()),
        vscode.commands.registerCommand("memory-lane.disableSmartRecall", () => disableSmartRecall()),
        vscode.commands.registerCommand("memory-lane.reindex", () => reindexMemories(memoryFile, memoryProvider))
    );

    const searchTool = vscode.lm.registerTool<{ query: string }>("lane_search", {
        async invoke(options) {
            const input: any = (options as any).input ?? (options as any).parameters ?? {};
            const query = String(input.query ?? "").trim();
            const data = readMemFile(memoryFile);
            if (!query) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        data.length ? data.map(r => `- ${r.text}`).join("\n") : "No memories found."
                    )
                ]);
            }
            const qEmb = await embed(query);
            let results: { rec: MemRecord; score: number }[];
            if (qEmb) {
                results = data
                    .filter(r => r.embedding && r.embedding.length)
                    .map(r => ({ rec: r, score: cosine(qEmb, r.embedding!) }));
                const ql = query.toLowerCase();
                const subs = data.filter(r => !r.embedding && r.text.toLowerCase().includes(ql))
                    .map(r => ({ rec: r, score: 0.5 }));
                results = results.concat(subs).sort((a, b) => b.score - a.score).filter(x => x.score >= 0.25).slice(0, 8);
            } else {
                const ql = query.toLowerCase();
                results = data.filter(r => r.text.toLowerCase().includes(ql)).map(r => ({ rec: r, score: 1 }));
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Memory Lane results for "${query}":\n` +
                    (results.length
                        ? results.map(x => `- (${x.score.toFixed(2)}) ${x.rec.text}`).join("\n")
                        : "No memories found.")
                )
            ]);
        },
        async prepareInvocation() {
            return { invocationMessage: "Walking down Memory Lane..." };
        }
    });

    const saveTool = vscode.lm.registerTool<{ content: string }>("lane_save", {
        async invoke(options) {
            const input: any = (options as any).input ?? (options as any).parameters ?? {};
            const content = String(input.content ?? "").trim();
            if (!content) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart("Error: no content provided.")
                ]);
            }
            const data = readMemFile(memoryFile);
            const dup = data.find(r => r.text.toLowerCase() === content.toLowerCase());
            if (dup) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Already in Memory Lane.`)
                ]);
            }
            const embedding = await embed(content);
            data.push({ text: content, ts: new Date().toISOString(), embedding });
            writeMemFile(memoryFile, data);
            memoryProvider.refresh();
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Saved to Memory Lane${embedding ? " (semantic indexed)" : ""}: ${content}`)
            ]);
        },
        async prepareInvocation() {
            return { invocationMessage: "Saving to Memory Lane..." };
        }
    });

    context.subscriptions.push(searchTool, saveTool);
}

async function reindexMemories(memoryFile: string, provider: { refresh(): void }) {
    const data = readMemFile(memoryFile);
    const todo = data.filter(r => !r.embedding || r.embedding.length === 0);
    if (todo.length === 0) {
        vscode.window.showInformationMessage("Memory Lane: all memories already indexed.");
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Memory Lane: indexing ${todo.length} memories...`,
        cancellable: false
    }, async (progress) => {
        let done = 0;
        for (const r of todo) {
            const emb = await embed(r.text);
            if (emb) r.embedding = emb;
            done++;
            progress.report({ message: `${done}/${todo.length}`, increment: 100 / todo.length });
        }
        writeMemFile(memoryFile, data);
        provider.refresh();
    });
    vscode.window.showInformationMessage("Memory Lane: reindex complete.");
}

export function deactivate() {}
