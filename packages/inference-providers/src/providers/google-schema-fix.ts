/**
 * Gemini function declarations take a narrow OpenAPI subset, and its parser
 * rejects the whole request on the first field it does not know. LangChain only
 * strips `additionalProperties`, so anything else JSON Schema allows — a
 * `z.number().positive()` becoming `exclusiveMinimum` — reaches the wire as
 * `Unknown name "exclusiveMinimum" ... Cannot find field`.
 */

type JsonSchema = Record<string, unknown>;

/** The fields `Gemini.Schema` names; the parser rejects the request on anything else. */
const SUPPORTED_KEYS = new Set([
  "anyOf",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

/**
 * The only `format` values Gemini documents. AI Studio's parser tolerates others,
 * but Vertex is stricter, so an unhonored hint is not worth a hard failure there.
 */
const SUPPORTED_FORMATS: Record<string, ReadonlySet<string>> = {
  string: new Set(["enum", "date-time"]),
  number: new Set(["float", "double"]),
  integer: new Set(["int32", "int64"]),
};

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sanitize the parameter schemas of already-converted Gemini tools, leaving other tool kinds alone. */
export function sanitizeGeminiTools<T>(tools: readonly T[]): T[] {
  return tools.map((tool) => {
    if (!isJsonSchema(tool) || !Array.isArray(tool.functionDeclarations)) return tool;
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) =>
        isJsonSchema(declaration) && isJsonSchema(declaration.parameters)
          ? { ...declaration, parameters: sanitizeGeminiSchema(declaration.parameters) }
          : declaration,
      ),
    } as T;
  });
}

export function sanitizeGeminiSchema(schema: JsonSchema): JsonSchema {
  return sanitizeNode(dereference(schema));
}

function sanitizeNode(schema: JsonSchema): JsonSchema {
  const merged = collapseAllOf(schema);
  const sanitized: JsonSchema = {};

  for (const [key, value] of Object.entries(merged)) {
    switch (key) {
      case "oneOf":
        sanitized.anyOf = value;
        break;
      case "const":
        // Gemini has no `const`; a single-value enum says the same thing.
        if (typeof value === "string") sanitized.enum = [value];
        break;
      case "exclusiveMinimum":
        if (typeof value === "number") {
          sanitized.minimum = tightest(
            sanitized.minimum,
            exclusiveBound(value, merged.type, 1),
            Math.max,
          );
        }
        break;
      case "exclusiveMaximum":
        if (typeof value === "number") {
          sanitized.maximum = tightest(
            sanitized.maximum,
            exclusiveBound(value, merged.type, -1),
            Math.min,
          );
        }
        break;
      case "minimum":
        sanitized.minimum = tightest(sanitized.minimum, value, Math.max);
        break;
      case "maximum":
        sanitized.maximum = tightest(sanitized.maximum, value, Math.min);
        break;
      case "enum":
        // The field is repeated string; anything else fails the parser outright.
        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          sanitized.enum = value;
        }
        break;
      case "format":
        if (typeof value === "string" && supportedFormat(merged.type, value)) {
          sanitized.format = value;
        }
        break;
      case "properties":
        if (isJsonSchema(value)) sanitized.properties = sanitizeProperties(value);
        break;
      case "items":
        if (isJsonSchema(value)) sanitized.items = sanitizeNode(value);
        break;
      default:
        if (SUPPORTED_KEYS.has(key)) sanitized[key] = value;
    }
  }

  if (Array.isArray(sanitized.anyOf)) sanitized.anyOf = sanitizeVariants(sanitized.anyOf);
  return sanitized;
}

function sanitizeProperties(properties: JsonSchema): JsonSchema {
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      isJsonSchema(value) ? sanitizeNode(value) : value,
    ]),
  );
}

function sanitizeVariants(variants: unknown[]): unknown[] {
  return variants.map((variant) =>
    isJsonSchema(variant) ? sanitizeNode(variant) : variant,
  );
}

/** Gemini only has inclusive bounds, so an integer's exclusive bound moves by one. */
function exclusiveBound(value: number, type: unknown, step: number): number {
  return type === "integer" ? value + step : value;
}

function tightest(
  current: unknown,
  candidate: unknown,
  choose: (left: number, right: number) => number,
): unknown {
  if (typeof candidate !== "number") return current;
  return typeof current === "number" ? choose(current, candidate) : candidate;
}

function supportedFormat(type: unknown, format: string): boolean {
  return typeof type === "string" && (SUPPORTED_FORMATS[type]?.has(format) ?? false);
}

/** Gemini has no `allOf`; merging members into the parent keeps their constraints. */
function collapseAllOf(schema: JsonSchema): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...base } = schema;
  return allOf
    .filter(isJsonSchema)
    .reduce<JsonSchema>((merged, member) => ({ ...merged, ...collapseAllOf(member) }), base);
}

/**
 * Gemini has no `$ref`/`$defs`, so a reference has to be inlined or the field it
 * describes is dropped entirely. Recursion stops at a bare object, the most a
 * self-referencing definition can say in a schema without references.
 */
function dereference(schema: JsonSchema): JsonSchema {
  const definitions = isJsonSchema(schema.$defs)
    ? schema.$defs
    : isJsonSchema(schema.definitions)
      ? schema.definitions
      : {};

  function resolve(node: unknown, seen: ReadonlySet<string>): unknown {
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen));
    if (!isJsonSchema(node)) return node;

    const ref = typeof node.$ref === "string" ? node.$ref : undefined;
    const name = ref?.match(/^#\/(?:\$defs|definitions)\/(.+)$/)?.[1];
    const definition = name === undefined ? undefined : definitions[name];
    if (ref !== undefined && isJsonSchema(definition)) {
      if (seen.has(ref)) return { type: "object" };
      const { $ref: _ref, ...siblings } = node;
      const resolved = resolve(definition, new Set([...seen, ref])) as JsonSchema;
      return { ...resolved, ...siblings };
    }

    const result: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs" || key === "definitions") continue;
      result[key] = resolve(value, seen);
    }
    return result;
  }

  return resolve(schema, new Set()) as JsonSchema;
}
