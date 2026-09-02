#!/usr/bin/env node
/** Advertises the recursive `anyOf` filter shape common to record-search MCP tools. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "union-schema", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_records",
      description: "Search records with a simple or compound filter.",
      inputSchema: {
        type: "object",
        properties: {
          queryTerm: { type: "string", description: "Free-text search" },
          condition: {
            allOf: [
              { description: "simple or compound conditions", $ref: "#/definitions/__schema0" },
            ],
          },
          aliases: {
            description: "One alias or several",
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
        },
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: {
          __schema0: {
            anyOf: [
              {
                type: "object",
                properties: {
                  field: { type: "string", minLength: 1 },
                  operator: { type: "string", enum: ["EXACT_MATCH", "CONTAINS", "GT"] },
                  value: { type: "string", minLength: 1 },
                },
                required: ["field", "operator"],
              },
              {
                type: "object",
                properties: {
                  operator: { type: "string", enum: ["AND", "OR"] },
                  conditions: { type: "array", items: { $ref: "#/definitions/__schema0" } },
                },
                required: ["operator", "conditions"],
              },
            ],
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
}));

await server.connect(new StdioServerTransport());
process.stderr.write("[union-schema] stdio server ready\n");
