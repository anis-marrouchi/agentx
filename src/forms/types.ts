import { z } from "zod"

// --- Form schema ---
//
// Forms are the structured-input primitive for user tasks. A form has a
// title, a list of typed fields, and optional primary/secondary action
// labels (for approve/reject-style flows).
//
// Forms can live inline on a userTask node's config OR be factored out to
// .agentx/forms/<id>.json and referenced by id.
//
// Rendering happens in channel adapters (Telegram inline keyboards, Slack
// Block Kit, WhatsApp list messages) and on the web inbox. Capability
// negotiation is per-renderer — a date field on a channel without native
// date input falls back to a validated text prompt.

export const formFieldTypeSchema = z.enum([
  "text",
  "long-text",
  "number",
  "boolean",
  "date",
  "select",
  "multi-select",
  "file",
])
export type FormFieldType = z.infer<typeof formFieldTypeSchema>

export const formFieldValidateSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
}).strict()
export type FormFieldValidate = z.infer<typeof formFieldValidateSchema>

export const formFieldSchema = z.object({
  key: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "field key must be identifier-safe"),
  label: z.string().min(1),
  type: formFieldTypeSchema,
  required: z.boolean().default(false),
  /** Options for select / multi-select. Ignored for other types. */
  options: z.array(z.string()).optional(),
  hint: z.string().optional(),
  defaultValue: z.unknown().optional(),
  validate: formFieldValidateSchema.optional(),
})
export type FormField = z.infer<typeof formFieldSchema>

export const formActionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
})
export type FormAction = z.infer<typeof formActionSchema>

export const formSchemaSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(formFieldSchema).default([]),
  /** Primary button label. Default "Submit". */
  submitLabel: z.string().default("Submit"),
  /** Optional secondary action — used for approve/reject-style flows. */
  secondaryAction: formActionSchema.optional(),
})
export type FormSchema = z.infer<typeof formSchemaSchema>

// --- Submission ---

export const formSubmissionSchema = z.object({
  /** Which button the user clicked: "primary" (default) or "secondary". */
  action: z.enum(["primary", "secondary"]).default("primary"),
  /** Field values keyed by field.key. Types match FormField.type. */
  values: z.record(z.unknown()).default({}),
})
export type FormSubmission = z.infer<typeof formSubmissionSchema>
