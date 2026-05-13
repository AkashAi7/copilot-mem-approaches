import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const memoryDir = path.join(context.globalStorageUri.fsPath, 'memory');
    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    const memoryFile = path.join(memoryDir, 'memories.json');
    if (!fs.existsSync(memoryFile)) {
        fs.writeFileSync(memoryFile, JSON.stringify([]));
    }

    const searchTool = vscode.lm.registerTool('copilot_mem_search', {
        async invoke(options, _token) {
            const data = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
            const query = (options.parameters.query as string).toLowerCase();
            const results = data.filter((m: string) => m.toLowerCase().includes(query));
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Search results for "${query}":\n` + (results.length > 0 ? results.join('\n- ') : "No memories found."))
            ]);
        },
        async prepareInvocation(options, _token) {
            return {
                invocationMessage: 'Searching persistent memory...',
            };
        }
    });

    const saveTool = vscode.lm.registerTool('copilot_mem_save', {
        async invoke(options, _token) {
            const data = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
            const content = options.parameters.content as string;
            data.push(`[${new Date().toISOString()}] ${content}`);
            fs.writeFileSync(memoryFile, JSON.stringify(data, null, 2));
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Successfully saved to memory.`)
            ]);
        },
        async prepareInvocation(options, _token) {
            return {
                invocationMessage: 'Saving context to persistent memory...',
            };
        }
    });

    context.subscriptions.push(searchTool, saveTool);
}

export function deactivate() {}
