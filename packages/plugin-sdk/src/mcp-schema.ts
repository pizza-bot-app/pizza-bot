type JsonSchema = Record<string, unknown>;

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableVariant(schema: JsonSchema): JsonSchema | undefined {
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!union) return undefined;

  const variants = union.filter(isJsonSchema);
  const nonNull = variants.filter((variant) => variant.type !== "null");
  const hasNull = variants.some((variant) => variant.type === "null");
  return hasNull && nonNull.length === 1 && variants.length === union.length
    ? nonNull[0]
    : undefined;
}

/**
 * Restore the non-null type that mcp-adapters drops from nullable non-object
 * unions while retaining its other provider-compatibility simplifications.
 */
export function restoreNullableSchemaTypes(
  adaptedSchema: unknown,
  sourceSchema: unknown,
): unknown {
  if (!isJsonSchema(adaptedSchema) || !isJsonSchema(sourceSchema)) {
    return adaptedSchema;
  }

  let restored: JsonSchema = { ...adaptedSchema };
  const variant = nullableVariant(sourceSchema);
  if (variant) {
    restored = {
      ...(restoreNullableSchemaTypes(variant, variant) as JsonSchema),
      ...restored,
    };
  } else if (Array.isArray(sourceSchema.type)) {
    const nonNullTypes = sourceSchema.type.filter((type) => type !== "null");
    if (sourceSchema.type.includes("null") && nonNullTypes.length === 1) {
      restored.type = nonNullTypes[0];
    }
  }

  if (isJsonSchema(restored.properties) && isJsonSchema(sourceSchema.properties)) {
    const properties = { ...restored.properties };
    for (const [name, sourceProperty] of Object.entries(sourceSchema.properties)) {
      if (name in properties) {
        properties[name] = restoreNullableSchemaTypes(properties[name], sourceProperty);
      }
    }
    restored.properties = properties;
  }

  if (restored.items !== undefined && sourceSchema.items !== undefined) {
    restored.items = restoreNullableSchemaTypes(restored.items, sourceSchema.items);
  }

  if (
    isJsonSchema(restored.additionalProperties) &&
    isJsonSchema(sourceSchema.additionalProperties)
  ) {
    restored.additionalProperties = restoreNullableSchemaTypes(
      restored.additionalProperties,
      sourceSchema.additionalProperties,
    );
  }

  return restored;
}
