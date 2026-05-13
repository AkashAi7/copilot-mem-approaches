import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";

const server = new Server(
  { name: "copilot-mem-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const memDir = path.join(os.homedir(), ".copilot-mem");
if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
const memFile = path.join(memDir, "memory.json");
if (!fs.existsSync(memFile)) fs.writeFileSync(memFile, "[]");

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_memory",
        description: "Search persistent context across sessions.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      },
      {
        name: "save_memory",
        description: "Save a new observation to memory.",
        inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const data = JSON.parse(fs.readFileSync(memFile, "utf-8"));
  if (request.params.name === "search_memory") {
    const query = String(request.params.arguments?.query || "").toLowerCase();
    const results = data.filter((m: string) => m.toLowerCase().includes(query));
    return { content: [{ type: "text", text: results.length ? results.join("\n") : "No results" }] };
  } else if (request.params.name === "save_memory") {
    const content = String(request.params.arguments?.content || "");
    data.push(`[${new Date().toISOString()}] ${content}`);
    fs.writeFileSync(memFile, JSON.stringify(data, null, 2));
    return { content: [{ type: "text", text: "Saved." }] };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("MCP Server running on stdio");
});
