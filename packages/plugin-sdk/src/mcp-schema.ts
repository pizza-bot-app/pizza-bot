type JsonSchema = Record<string, unknown>;

/** Keys the adapter strips for provider compatibility; a restored variant must not reintroduce them. */
const ADAPTER_STRIPPED = ["$schema", "unevaluatedProperties", "not", "if", "then", "else"] as const;

/** Keys that describe a field rather than constrain it, so they survive the adapter's flattening intact. */
const ANNOTATIONS = ["description", "title", "default", "examples", "deprecated"] as const;

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unionVariants(schema: JsonSchema): JsonSchema[] | undefined {
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!union) return undefined;

  const variants = union.filter(isJsonSchema);
  return variants.length === union.length ? variants : undefined;
}

/**
 * mcp-adapters inlines `$ref`s before it flattens, so the source has to be inlined
 * the same way to line up with the adapted schema — including degrading a
 * self-referencing definition to a bare object, which is where its recursion stops.
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

/** The adapter merges `allOf` members into their parent, which can hide a union one level down. */
function collapseAllOf(schema: JsonSchema): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...base } = schema;
  return allOf
    .filter(isJsonSchema)
    .reduce<JsonSchema>((merged, member) => ({ ...merged, ...collapseAllOf(member) }), base);
}

function sanitizeVariant(schema: JsonSchema): JsonSchema {
  const collapsed = { ...collapseAllOf(schema) };
  for (const key of ADAPTER_STRIPPED) delete collapsed[key];

  if (isJsonSchema(collapsed.properties)) {
    collapsed.properties = Object.fromEntries(
      Object.entries(collapsed.properties).map(([name, value]) => [
        name,
        isJsonSchema(value) ? sanitizeVariant(value) : value,
      ]),
    );
  }
  if (isJsonSchema(collapsed.items)) collapsed.items = sanitizeVariant(collapsed.items);
  if (isJsonSchema(collapsed.additionalProperties)) {
    collapsed.additionalProperties = sanitizeVariant(collapsed.additionalProperties);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const union = collapsed[key];
    if (Array.isArray(union)) {
      collapsed[key] = union.map((variant) =>
        isJsonSchema(variant) ? sanitizeVariant(variant) : variant,
      );
    }
  }
  return collapsed;
}

/**
 * Restore the unions mcp-adapters flattens, keeping its other provider-compatibility
 * simplifications. It merges every variant of a union into one schema, which both
 * invents combinations the server rejects and drops constraints it enforces — so the
 * model is handed a contract its own tool description contradicts, and LangChain's
 * pre-flight validation rejects calls the server would have accepted.
 */
export function restoreFlattenedUnions(adaptedSchema: unknown, sourceSchema: unknown): unknown {
  if (!isJsonSchema(adaptedSchema) || !isJsonSchema(sourceSchema)) {
    return adaptedSchema;
  }
  return restore(adaptedSchema, dereference(sourceSchema));
}

function restore(adaptedSchema: JsonSchema, rawSourceSchema: JsonSchema): JsonSchema {
  const sourceSchema = collapseAllOf(rawSourceSchema);
  const variants = unionVariants(sourceSchema);
  const nonNull = variants?.filter((variant) => variant.type !== "null") ?? [];

  let restored: JsonSchema = { ...adaptedSchema };
  if (variants && nonNull.length > 1) {
    const annotations = Object.fromEntries(
      ANNOTATIONS.filter((key) => key in adaptedSchema).map((key) => [key, adaptedSchema[key]]),
    );
    return {
      ...annotations,
      anyOf: variants.map((variant) => restore(sanitizeVariant(variant), variant)),
    };
  }
  if (variants && nonNull.length === 1) {
    restored = { ...restore(nonNull[0]!, nonNull[0]!), ...restored };
  } else if (Array.isArray(sourceSchema.type)) {
    const nonNullTypes = sourceSchema.type.filter((type) => type !== "null");
    if (sourceSchema.type.includes("null") && nonNullTypes.length === 1) {
      restored.type = nonNullTypes[0];
    }
  }

  if (isJsonSchema(restored.properties) && isJsonSchema(sourceSchema.properties)) {
    const properties = { ...restored.properties };
    for (const [name, sourceProperty] of Object.entries(sourceSchema.properties)) {
      const adaptedProperty = properties[name];
      if (isJsonSchema(adaptedProperty) && isJsonSchema(sourceProperty)) {
        properties[name] = restore(adaptedProperty, sourceProperty);
      }
    }
    restored.properties = properties;
  }

  if (isJsonSchema(restored.items) && isJsonSchema(sourceSchema.items)) {
    restored.items = restore(restored.items, sourceSchema.items);
  }

  if (
    isJsonSchema(restored.additionalProperties) &&
    isJsonSchema(sourceSchema.additionalProperties)
  ) {
    restored.additionalProperties = restore(
      restored.additionalProperties,
      sourceSchema.additionalProperties,
    );
  }

  return restored;
}
