/**
 * Decoded text with a map back to raw offsets.
 *
 * Every nested encoding layer (XML entities, CDATA, JSON string escapes, HTML
 * character references, percent-encoding, CSS escapes) is decoded into a
 * DecodedText. `map[i]` is the raw offset where decoded code unit `i` starts
 * and `map[text.length]` is the raw length. An edit expressed in decoded
 * coordinates can therefore be lifted to the raw text without re-encoding
 * anything outside the edited range.
 */
export interface DecodedText {
  readonly text: string;
  readonly map: readonly number[];
}

/** A replacement of [start, end) with `text`, in some layer's coordinates. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Builds an identity DecodedText (raw and decoded are the same). */
export function identity(raw: string): DecodedText {
  const map = new Array<number>(raw.length + 1);
  for (let i = 0; i <= raw.length; i++) map[i] = i;
  return { text: raw, map };
}

/** Incrementally builds a DecodedText while scanning raw input. */
export class DecodedBuilder {
  private text = '';
  private readonly map: number[] = [];

  /** Appends decoded characters that all originate at `rawStart`. */
  push(decoded: string, rawStart: number): void {
    for (let i = 0; i < decoded.length; i++) this.map.push(rawStart);
    this.text += decoded;
  }

  /** Appends a run of characters copied verbatim from raw offset `rawStart`. */
  pushVerbatim(chunk: string, rawStart: number): void {
    for (let i = 0; i < chunk.length; i++) this.map.push(rawStart + i);
    this.text += chunk;
  }

  /** Finalizes with the raw length as the end sentinel. */
  finish(rawLength: number): DecodedText {
    this.map.push(rawLength);
    return { text: this.text, map: this.map };
  }
}

/**
 * Lifts an edit from a decoded layer to its raw text. The layer's raw text
 * starts at `rawOffset` in the parent coordinates, and `encode` converts the
 * replacement text into the layer's raw syntax. Returns undefined when the
 * edit boundaries fall inside a single escape sequence (cannot be lifted
 * without re-encoding neighbours).
 */
export function liftEdit(edit: TextEdit, layer: DecodedText, rawOffset: number, encode: (text: string) => string): TextEdit | undefined {
  const { map } = layer;
  if (edit.start < 0 || edit.end > layer.text.length || edit.start > edit.end) return undefined;
  const rawStart = map[edit.start]!;
  const rawEnd = map[edit.end]!;
  // A boundary splitting a multi-unit escape shows up as equal raw starts.
  if (edit.start > 0 && map[edit.start - 1] === rawStart) return undefined;
  if (edit.end > 0 && edit.end < layer.text.length && map[edit.end - 1] === rawEnd) return undefined;
  return { start: rawOffset + rawStart, end: rawOffset + rawEnd, text: encode(edit.text) };
}

/** Applies non-overlapping edits to a string. Throws when edits overlap. */
export function applyEdits(raw: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) throw new Error('Overlapping text edits');
    out += raw.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + raw.slice(cursor);
}
