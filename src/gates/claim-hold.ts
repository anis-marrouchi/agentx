/**
 * G3 (#2085 v3 T, v4 T′, v5 T″): hold a streamed answer from its first
 * claim word.
 *
 * While the `status-claim` seat is active, an owner's turn streams as
 * usual until a claim word (merged, live, deployed, released, closed)
 * appears. That piece and everything after it are held. Once the run
 * returns, with G3's check and any correction done, the caller sends the
 * rest from the final text. What went out before had no claim word, so
 * nothing already sent needs correcting.
 *
 * One class for the router's block stream and the /task SSE text events.
 */
import { hasClaimWord } from "./status-claim"

export class ClaimHold {
  private passed = ""
  private holding = false

  /** Text sent so far. */
  get sent(): string {
    return this.passed
  }

  /** True once a claim word was seen: nothing more goes out until `rest`. */
  get held(): boolean {
    return this.holding
  }

  /** A streamed piece: returns it when it may go out now, else "".
   *  The claim word is looked for across the piece boundary, so a word
   *  split over two deltas is still caught. */
  push(piece: string): string {
    if (this.holding || !piece) return ""
    const tail = this.passed.slice(-12)
    if (hasClaimWord(tail + piece)) {
      this.holding = true
      return ""
    }
    this.passed += piece
    return piece
  }

  /** What is left to send from the final text: the part after what went
   *  out, or, when the final text was rewritten, all of it after a break. */
  rest(finalText: string): string {
    if (!this.passed) return finalText
    if (finalText.startsWith(this.passed)) return finalText.slice(this.passed.length)
    return `\n\n${finalText}`
  }
}
