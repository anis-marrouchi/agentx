import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"
import type { Transform } from "@/clipboard/transforms"

// Which shape a paste should arrive in.
//
// The same shape as voice-narration and ui-element, because it is the same
// problem: a bounded set of options, scored against one situation, where
// the per-option probabilities ARE the ranking. Jev writes nothing here.
// It picks, and deterministic code in clipboard/transforms.ts does the
// work — so nothing generated ever lands in the clipboard.
//
// The companion Noul is not optional and is read FIRST. A Choice must
// return something: asked how to reshape a password on its way into a
// login field, it will name a transform, with a confident-looking
// probability. `worthChanging` is the question that can say "paste it
// exactly as it is", which is the right answer almost every time.
//
// What makes the choice informed rather than a guess about text in the
// abstract is the DESTINATION. The same three lines want to be a bullet
// list in a markdown editor, a quote in a message, and left strictly alone
// in a terminal. We already know where the caret is — the helper's
// `focused` verb reports the role and label of whatever has keyboard
// focus, built for the type-safety gate — so the destination costs nothing
// extra to include and is most of the signal.

export const PASTE_TRANSFORM_SEAT = "paste-transform"

export interface PasteInput {
  /** A bounded preview of the clipboard, never the whole of it. */
  preview: string
  /** Full length, so the model knows what the preview stands for. */
  length: number
  lineCount: number
  /** Where it is going. */
  app: string
  /** Role of the focused control, in plain words: "a text field". */
  destination: string
  /** The focused control's own label, when it has one. */
  destinationLabel?: string | null
}

export function pasteState(input: PasteInput): StateValue {
  return {
    pastingInto: {
      app: input.app,
      control: input.destination,
      label: input.destinationLabel || null,
    },
    clipboard: {
      characters: input.length,
      lines: input.lineCount,
      preview: input.preview,
    },
  }
}

/** Built per call — the option set IS the set of transforms that apply. */
export function pasteQuestions(options: Transform[]) {
  const criteria: Record<string, string> = {}
  for (const option of options) criteria[option.id] = option.criterion

  return {
    // State the boundary, not a preference.
    //
    // An earlier version of `false` read "this is the default and the safe
    // answer". That is an instruction to answer false, not a description of
    // when false is true, and it behaved exactly as told: a URL heavy with
    // utm parameters going into a markdown note scored 0.18, and prose
    // hard-wrapped out of a PDF scored 0.20. Both are cases this seat
    // exists for. A criterion that argues for its own side stops measuring
    // anything.
    worthChanging: noul(
      "The text is in the wrong shape for where it is being pasted, and a mechanical reshaping would fix it.",
      {
        true:
          "The destination renders or stores formatted text, and the clipboard arrived in a shape that will not come out right: lines hard-wrapped mid-sentence going into prose, a link carrying campaign or tracking parameters, JSON collapsed onto one line, separate items going somewhere that renders a list, text padded with stray whitespace from a web page. The fix is mechanical and is what the person would have done by hand after pasting.",
        false:
          "The text is already in the right shape for this destination, OR its exact bytes carry meaning that reformatting would destroy — a credential, a command, a path, code, an identifier, a search query — OR the destination is a terminal, a password field, a URL bar or a code editor, where introduced formatting would corrupt what is pasted.",
      },
    ),
    shape: choice(criteria, "What shape should this paste arrive in?"),
  }
}

export type PasteAnswers = AnswersFor<ReturnType<typeof pasteQuestions>>

export interface PasteChoice {
  /** P(reshaping this paste is right). Read before `id`. */
  worthChanging: number
  /** Chosen transform id. */
  id: string
  /** Derived from the shape of the probabilities, never self-reported. */
  confidence: number
  ranked: Array<{ id: string; p: number }>
}

export function toPasteChoice(answers: PasteAnswers): PasteChoice {
  const worth = answers.worthChanging as NoulAnswer
  const shape = answers.shape as ChoiceAnswer
  const ranked = Object.entries(shape.probabilities ?? {})
    .map(([id, p]) => ({ id, p: Number(p) || 0 }))
    .sort((a, b) => b.p - a.p)
  return {
    worthChanging: worth.noul,
    id: shape.choice,
    confidence: shape.confidence,
    ranked,
  }
}
