export interface ArgRejection {
  error: string;
}

const MAX_DEPTH = 8;
const MAX_ARG_BYTES = 256 * 1024;

type JsonSchema = Record<string, unknown>;

function typeMatches(schema: JsonSchema, value: unknown): boolean {
  const declared = schema.type;
  if (typeof declared !== "string") return true;
  if (declared === "string") return typeof value === "string";
  if (declared === "number") return typeof value === "number" && Number.isFinite(value);
  if (declared === "integer") return typeof value === "number" && Number.isInteger(value);
  if (declared === "boolean") return typeof value === "boolean";
  if (declared === "array") return Array.isArray(value);
  if (declared === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  return true;
}

function checkNode(schema: JsonSchema, value: unknown, path: string, depth: number): ArgRejection | null {
  if (depth > MAX_DEPTH) return { error: `${path} nests deeper than ${MAX_DEPTH} levels` };
  if (value === undefined || value === null) return null;
  if (!typeMatches(schema, value)) return { error: `${path} must be of type ${String(schema.type)}` };
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    return { error: `${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}` };
  }
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const declaredKeys = Object.keys(properties);
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const record = value as Record<string, unknown>;
    for (const key of required) {
      if (!(key in record)) return { error: `${path}.${key} is required` };
    }
    for (const [key, entry] of Object.entries(record)) {
      if (declaredKeys.length > 0 && !declaredKeys.includes(key)) {
        return { error: `${path}.${key} is not a declared parameter` };
      }
      const child = properties[key];
      if (child) {
        const rejection = checkNode(child, entry, `${path}.${key}`, depth + 1);
        if (rejection) return rejection;
      }
    }
    return null;
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    const items = schema.items as JsonSchema;
    const list = value as unknown[];
    for (let index = 0; index < list.length; index += 1) {
      const rejection = checkNode(items, list[index], `${path}[${index}]`, depth + 1);
      if (rejection) return rejection;
    }
  }
  return null;
}

export function checkArgs(toolName: string, schema: unknown, args: unknown): ArgRejection | null {
  if (args === undefined || args === null) return null;
  if (typeof args !== "object" || Array.isArray(args)) return { error: `${toolName} arguments must be an object` };
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    return { error: `${toolName} arguments are not serializable` };
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARG_BYTES) {
    return { error: `${toolName} arguments exceed the ${MAX_ARG_BYTES} byte relay limit` };
  }
  if (!schema || typeof schema !== "object") return null;
  return checkNode(schema as JsonSchema, args, toolName, 0);
}
