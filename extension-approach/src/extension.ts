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

export function activate(context: vscode.ExtensionContext) {
    const memoryDir = path.join(context.globalStorageUri.fsPath, "memory");
    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    const memoryFile = path.join(memoryDir, "memories.json");
    if (!fs.existsSync(memoryFile)) {
        fs.writeFileSync(memoryFile, JSON.stringify([]));
    }

    const memoryProvider = new MemoryProvider(memoryFile);
    vscode.window.registerTreeDataProvider("copilot-mem-explorer", memoryProvider);

    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.refresh", () => memoryProvider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand("copilot-mem.delete", (node: MemoryItem) => {
        memoryProvider.deleteItem(node.index);
    }));

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
