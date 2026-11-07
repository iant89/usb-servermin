/**
 * Module configuration schema (§24). A module declares its settings in the manifest; the core
 * validates every change, stores the values, emits `module.config.changed` and renders a
 * settings form in the Module Manager automatically.
 */
export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'secret';

export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  /** number: inclusive bounds. string: length bounds. */
  min?: number;
  max?: number;
  /** enum: allowed values. */
  options?: string[];
  /** string/secret: regular expression the value must match. */
  pattern?: string;
}

export type ConfigValues = Record<string, string | number | boolean | undefined>;

export function configDefaults(fields: readonly ConfigField[] = []): ConfigValues {
  const out: ConfigValues = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** Validates (and coerces) a partial update. Returns the merged values or a map of errors. */
export function validateConfig(
  fields: readonly ConfigField[] = [],
  current: ConfigValues,
  update: Record<string, unknown>,
): { ok: true; values: ConfigValues } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: ConfigValues = { ...configDefaults(fields), ...current };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(update)) {
    const field = byKey.get(key);
    if (!field) {
      errors[key] = 'Unknown setting';
      continue;
    }
    if (raw === null || raw === undefined || raw === '') {
      if (field.required) errors[key] = 'This setting is required';
      else values[key] = field.default;
      continue;
    }
    switch (field.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) errors[key] = 'Enter a number';
        else if (field.min !== undefined && n < field.min) errors[key] = `Must be at least ${field.min}`;
        else if (field.max !== undefined && n > field.max) errors[key] = `Must be at most ${field.max}`;
        else values[key] = n;
        break;
      }
      case 'boolean':
        if (typeof raw === 'boolean') values[key] = raw;
        else if (raw === 'true' || raw === 'false') values[key] = raw === 'true';
        else errors[key] = 'Must be true or false';
        break;
      case 'enum':
        if (typeof raw !== 'string' || !field.options?.includes(raw)) errors[key] = `Choose one of: ${(field.options ?? []).join(', ')}`;
        else values[key] = raw;
        break;
      default: {
        if (typeof raw !== 'string') {
          errors[key] = 'Must be text';
          break;
        }
        if (field.min !== undefined && raw.length < field.min) errors[key] = `Must be at least ${field.min} characters`;
        else if (field.max !== undefined && raw.length > field.max) errors[key] = `Must be at most ${field.max} characters`;
        else if (field.pattern && !new RegExp(field.pattern).test(raw)) errors[key] = 'Invalid format';
        else values[key] = raw;
      }
    }
  }
  for (const f of fields) {
    if (f.required && (values[f.key] === undefined || values[f.key] === '') && !errors[f.key]) errors[f.key] = 'This setting is required';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** Removes secret values before sending configuration to a browser. */
export function redactConfig(fields: readonly ConfigField[] = [], values: ConfigValues): ConfigValues {
  const out = { ...values };
  for (const f of fields) if (f.type === 'secret' && out[f.key]) out[f.key] = '••••••••';
  return out;
}
