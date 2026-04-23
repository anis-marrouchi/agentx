import type { FormField, FormSchema, FormSubmission } from "./types"

// --- Engine-side form validation ---
//
// One validator shared by all renderers. Channel adapters capture raw
// strings; the engine coerces to the declared type and enforces required /
// pattern / min / max rules. Returns a list of human-readable errors — an
// empty list means the submission is valid.

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  /** Coerced values — numbers as numbers, booleans as booleans, etc. Only
   *  populated when ok === true; partial on failure so callers can show
   *  per-field state. */
  values: Record<string, unknown>
}

export function validateSubmission(schema: FormSchema, submission: FormSubmission): ValidationResult {
  const errors: ValidationError[] = []
  const coerced: Record<string, unknown> = {}

  for (const field of schema.fields) {
    const raw = submission.values[field.key]
    const present = raw !== undefined && raw !== null && raw !== ""

    if (!present) {
      if (field.required) {
        errors.push({ field: field.key, message: `"${field.label}" is required` })
      } else if (field.defaultValue !== undefined) {
        coerced[field.key] = field.defaultValue
      }
      continue
    }

    const result = coerceField(field, raw)
    if (result.error) {
      errors.push({ field: field.key, message: result.error })
      continue
    }
    coerced[field.key] = result.value
  }

  return { ok: errors.length === 0, errors, values: coerced }
}

function coerceField(field: FormField, raw: unknown): { value?: unknown; error?: string } {
  const label = field.label
  switch (field.type) {
    case "text":
    case "long-text": {
      const str = String(raw)
      if (field.validate?.min !== undefined && str.length < field.validate.min) {
        return { error: `"${label}" must be at least ${field.validate.min} characters` }
      }
      if (field.validate?.max !== undefined && str.length > field.validate.max) {
        return { error: `"${label}" must be at most ${field.validate.max} characters` }
      }
      if (field.validate?.pattern) {
        const re = new RegExp(field.validate.pattern)
        if (!re.test(str)) return { error: `"${label}" does not match the expected format` }
      }
      return { value: str }
    }
    case "number": {
      const num = typeof raw === "number" ? raw : Number(String(raw))
      if (!Number.isFinite(num)) return { error: `"${label}" must be a number` }
      if (field.validate?.min !== undefined && num < field.validate.min) {
        return { error: `"${label}" must be at least ${field.validate.min}` }
      }
      if (field.validate?.max !== undefined && num > field.validate.max) {
        return { error: `"${label}" must be at most ${field.validate.max}` }
      }
      return { value: num }
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw }
      const str = String(raw).toLowerCase()
      if (["true", "yes", "y", "1"].includes(str)) return { value: true }
      if (["false", "no", "n", "0"].includes(str)) return { value: false }
      return { error: `"${label}" must be yes/no` }
    }
    case "date": {
      const d = typeof raw === "string" || typeof raw === "number" ? new Date(raw) : null
      if (!d || Number.isNaN(d.getTime())) return { error: `"${label}" is not a valid date` }
      return { value: d.toISOString() }
    }
    case "select": {
      const str = String(raw)
      const options = field.options ?? []
      if (options.length && !options.includes(str)) {
        return { error: `"${label}" must be one of: ${options.join(", ")}` }
      }
      return { value: str }
    }
    case "multi-select": {
      const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(",").map((s) => s.trim()).filter(Boolean)
      const options = field.options ?? []
      if (options.length) {
        const bad = arr.filter((v) => !options.includes(v))
        if (bad.length) return { error: `"${label}" contains invalid values: ${bad.join(", ")}` }
      }
      return { value: arr }
    }
    case "file": {
      // For MVP, "file" is a URL or path string; channel adapters upload and
      // substitute before submission. Deeper validation is deferred.
      return { value: String(raw) }
    }
  }
  return { error: `unknown field type: ${field.type}` }
}
