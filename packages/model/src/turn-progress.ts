/**
 * The transient data part a turn streams while it works, before its first token or during a
 * long wait such as a checkout (AGT-139). Its `data` is `{ label: string | null }`: the chat
 * draws the latest label instead of "thinking…", and `null` clears it. Being transient, the
 * conversation never stores it.
 */
export const TURN_PROGRESS_PART = "data-progress";
