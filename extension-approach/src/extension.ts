import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

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

    getChildren(element?: MemoryItem): Thenable<MemoryItem[]> {
        if (!fs.existsSync(this.memoryFile)) return Promise.resolve([]);
        const data = JSON.parse(fs.readFileSync(this.memoryFile, "utf8"));
        
        const items = data.map((mem: string, i: number) => {
            const preview = mem.length > 50 ? mem.substring(0, 50) + "..." : mem;
            return new MemoryItem(preview, i, mem);
        });
        
        return Promise.resolve(items.reverse()); // Show newest first
    }

    deleteItem(index: number) {
        const data = JSON.parse(fs.readFileSync(this.memoryFile, "utf8"));
        data.splice(index, 1);
        fs.writeFileSync(this.memoryFile, JSON.stringify(data, null, 2));
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
    return { settingsFile, captureScript };
}

async function enableAutoCapture(hooksDir: string) {
    const config = vscode.workspace.getConfiguration();
    const existing = config.get<Record<string, boolean>>("chat.hookFilesLocations") || {};
    existing[hooksDir] = true;
    await config.update("chat.hookFilesLocations", existing, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Copilot Mem: Auto-capture enabled. Reload window if hooks don't pick up.");
}

async function disableAutoCapture(hooksDir: string) {
    const config = vscode.workspace.getConfiguration();
    const existing = config.get<Record<string, boolean>>("chat.hookFilesLocations") || {};
    if (hooksDir in existing) {
        existing[hooksDir] = false;
        await config.update("chat.hookFilesLocations", existing, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage("Copilot Mem: Auto-capture disabled.");
}

export function activate(context: vscode.ExtensionContext) {
    const memoryDir = path.join(context.globalStorageUri.fsPath, "memory");
    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    const memoryFile = path.join(memoryDir, "memories.json");
    if (!fs.existsSync(memoryFile)) {
        fs.writeFileSync(memoryFile, JSON.stringify([]));
    }

    const hooksDir = path.join(context.globalStorageUri.fsPath, "hooks");
    writeHookFiles(hooksDir, memoryFile);

    const memoryProvider = new MemoryProvider(memoryFile);
    vscode.window.registerTreeDataProvider("copilot-mem-explorer", memoryProvider);

    // Auto-refresh tree when memory file changes (catches hook-driven writes)
    try {
        fs.watch(memoryFile, { persistent: false }, () => memoryProvider.refresh());
    } catch {}

    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.refresh", () => memoryProvider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.delete", (node: MemoryItem) => {
        memoryProvider.deleteItem(node.index);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.enableAutoCapture", () => enableAutoCapture(hooksDir)));
    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.disableAutoCapture", () => disableAutoCapture(hooksDir)));

    const searchTool = vscode.lm.registerTool("copilot_mem_search", {
        async invoke(options, _token) {
            const data = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
            const query = (options.parameters.query as string).toLowerCase();
            const results = data.filter((m: string) => m.toLowerCase().includes(query));
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Search results for "${query}":\n` + (results.length > 0 ? results.join("\n- ") : "No memories found."))
            ]);
        },
        async prepareInvocation(options, _token) {
            return {
                invocationMessage: "Searching persistent memory...",
            };
        }
    });

    const saveTool = vscode.lm.registerTool("copilot_mem_save", {
        async invoke(options, _token) {
            const data = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
            const content = options.parameters.content as string;
            data.push(`[${new Date().toISOString()}] ${content}`);
            fs.writeFileSync(memoryFile, JSON.stringify(data, null, 2));
            memoryProvider.refresh();
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Successfully saved to memory.`)
            ]);
        },
        async prepareInvocation(options, _token) {
            return {
                invocationMessage: "Saving context to persistent memory...",
            };
        }
    });

    context.subscriptions.push(searchTool, saveTool);
}

export function deactivate() {}
