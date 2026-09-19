// Authoritative facts, pulled from the systems that actually hold them.
//
// The field grader found `contactValue` missing from 18 of 52 person
// articles, and the obvious reading — absorb summarised the phone number
// away — is wrong. The number was never in the input. A wiki entry
// carries `context: Mohannad Sedrani` and a block of conversation text;
// nobody types their own phone number into a chat. No prompt can recover
// a fact that was never present.
//
// Related, but not the same thing: `src/wiki/ingest-whatsapp.ts` pushes
// the contact book in as raw entries for absorb to read. This pulls, and
// only for entities a batch already names — so it needs no sweep to have
// been run, stays current, and never puts an unrelated person's details
// in a prompt. The two compose: a swept contact is one more entry, a
// resolved fact is a value the writer is told to copy.
//
// It was, however, one command away the whole time:
//
//   $ wacli contacts search "<name>"
//   ALIAS  NAME          PHONE           JID
//          <name>        <e164>          <e164>@s.whatsapp.net
//
// So the fix is not a better instruction, it is a second input. Each
// source is a read-only lookup against a system of record — WhatsApp for
// numbers, GitLab for emails and handles, Google for contact cards, the
// ERP for billing and contracts — resolved for the entities that appear
// in the batch and injected into the absorb prompt as facts the writer
// must copy rather than infer.

/** An entity named in the batch, for which we want identifiers. */
export interface EntityHint {
  name: string
  /** Where the name came from, so a source can skip hints it cannot serve. */
  origin?: "context" | "body" | "article"
  /** Narrows the lookup when absorb already knows the type. */
  type?: string
}

/**
 * Fields are deliberately open. A source reports what it holds; the
 * prompt renders whatever arrives. Constraining this to the graded field
 * keys would discard an ERP contract number because no rubric asked for
 * one yet.
 */
export interface FactRecord {
  /** The entity this describes, as the source spells it. */
  name: string
  source: string
  fields: Record<string, string>
  /** Set when the source matched on something looser than an exact name. */
  fuzzy?: boolean
}

/** Why a source could not answer — the three cases need different replies. */
export type Unavailable =
  /** The tool is not installed. Tell the operator how to install it. */
  | { kind: "not-installed"; hint: string }
  /** Installed but not usable yet — unauthenticated, API disabled, no token. */
  | { kind: "not-configured"; hint: string }
  /** Installed, configured, and it failed anyway. */
  | { kind: "failed"; hint: string }

export interface FactSourceResult {
  source: string
  records: FactRecord[]
  /** Populated instead of records when the source could not answer. A
   *  source that cannot answer must not stop the absorb. */
  unavailable?: Unavailable
  ms: number
}

export interface FactSource {
  name: string
  /** What this source contributes, for the install prompt. */
  provides: string[]
  /**
   * Cheap check so a missing binary is reported once for the batch
   * rather than as a failed lookup on every entity in it.
   *
   * Returns null when healthy. A source that is merely absent is not an
   * error to swallow: the operator cannot install what nobody told them
   * was missing, so the reason and the remedy travel together and the
   * caller decides whether to surface or ignore them.
   */
  available(): Promise<Unavailable | null>
  lookup(hints: EntityHint[], signal?: AbortSignal): Promise<FactRecord[]>
}
