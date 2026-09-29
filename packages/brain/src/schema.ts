export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface ValidateOptions {
  /**
   * Reject properties the schema does not list (default true). Models invent
   * parameters; a tool should never receive one it didn't declare.
   */
  strict?: boolean;
}

/** Returns a list of problems; empty means the value fits the schema. */
export function validateArgs(schema: JsonSchema, value: unknown, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  walk(schema, value, "$", options.strict ?? true, errors);
  return errors;
}

function walk(schema: JsonSchema, value: unknown, path: string, strict: boolean, errors: string[]): void {
  if (schema.enum && !schema.enum.some((e) => Object.is(e, value) || JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  switch (schema.type) {
    case undefined:
      return;
    case "null":
      if (value !== null) errors.push(`${path}: must be null`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: must be a boolean`);
      return;
    case "string": {
      if (typeof value !== "string") return void errors.push(`${path}: must be a string`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return void errors.push(`${path}: must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return void errors.push(`${path}: must be an array`);
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      if (schema.items) value.forEach((item, i) => walk(schema.items!, item, `${path}[${i}]`, strict, errors));
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return void errors.push(`${path}: must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${path}.${key}: is required`);
      }
      const known = schema.properties ?? {};
      for (const [key, v] of Object.entries(record)) {
        const sub = known[key];
        if (sub) walk(sub, v, `${path}.${key}`, strict, errors);
        else if (strict && schema.additionalProperties !== true) errors.push(`${path}.${key}: is not a known parameter`);
      }
      return;
    }
  }
}
