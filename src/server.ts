import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";

export const SERVER_NAME = "bxhealth-fhir-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fresh MCP Server with the FHIR tool set wired up.
 *
 * A Server instance can only be connected to one transport, and the
 * Streamable HTTP transport is per-session, so the HTTP entrypoint calls
 * this once per session rather than sharing a single module-level server.
 */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  // ── List Tools ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodSchemaToJsonSchema(tool.inputSchema),
      })),
    };
  });

  // ── Call Tool ───────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // Validate input
    const parseResult = tool.inputSchema.safeParse(args ?? {});
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters for tool '${name}': ${parseResult.error.message}`
      );
    }

    try {
      const result = await tool.handler(parseResult.data);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Zod → JSON Schema (simple conversion for MCP) ────────────────────────────

function zodSchemaToJsonSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  // Use the Zod schema's _def to build a minimal JSON Schema
  return buildJsonSchema(schema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildJsonSchema(schema: any): Record<string, unknown> {
  const typeName = schema._def?.typeName as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = schema._def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fieldSchema = value as any;
        properties[key] = buildJsonSchema(fieldSchema);
        // If not optional/default, mark as required
        if (
          fieldSchema._def?.typeName !== "ZodOptional" &&
          fieldSchema._def?.typeName !== "ZodDefault"
        ) {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    case "ZodOptional":
      return buildJsonSchema(schema._def.innerType);
    case "ZodDefault": {
      const inner = buildJsonSchema(schema._def.innerType);
      inner.default = schema._def.defaultValue();
      return inner;
    }
    case "ZodString":
      return { type: "string", description: schema.description };
    case "ZodNumber":
      return { type: "number", description: schema.description };
    case "ZodBoolean":
      return { type: "boolean", description: schema.description };
    case "ZodArray":
      return {
        type: "array",
        items: buildJsonSchema(schema._def.type),
        description: schema.description,
      };
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: buildJsonSchema(schema._def.valueType),
        description: schema.description,
      };
    case "ZodEnum":
      return { type: "string", enum: schema._def.values, description: schema.description };
    case "ZodUnion":
      return { oneOf: schema._def.options.map(buildJsonSchema), description: schema.description };
    case "ZodUnknown":
    case "ZodAny":
      return { description: schema.description };
    default:
      return { description: schema.description };
  }
}
