import { applyEdits, type TextEdit } from '../parse/text-map.js';
import { encodePathLike } from '../parse/uri.js';
import { decodeHtmlRefs } from '../parse/html.js';
import { DecodingMode } from 'entities/decode';
import type { ReferenceInternal } from '../analyze/model.js';
import { CONTEXT_PATH } from './resolve.js';

/**
 * Reference retargeting: computes, for a reference, the value that points to
 * a new path in the reference's own form. src/core/refs/restructure.ts
 * decides which references change and verifies the result.
 */

/** Computes the replacement URL for a reference so that it points to `target`. */
export function retargetValue(ref: ReferenceInternal, target: string): string | undefined {
  const suffixIndex = ref.value.search(/[?#]/);
  const suffix = suffixIndex >= 0 && ref.lenient !== 'literal-special' ? ref.value.slice(suffixIndex) : '';
  const editable = ref.representation === 'editable' || ref.representation === 'search-index';
  if (editable) {
    // eXeLearning looks placeholders up literally; characters that end its regexes, or an "&" that
    // HTML would read as a character reference, cannot be expressed so that both it and browsers agree.
    if (/[\s"'<>\\]/.test(target)) return undefined;
    if (decodeHtmlRefs(target, DecodingMode.Attribute).text !== target) return undefined;
    if (ref.form === 'resources-legacy' && target.startsWith('content/resources/')) {
      return `resources/${target.slice('content/resources/'.length)}${suffix}`;
    }
    if (ref.form === 'context-path' || ref.form === 'resources-legacy' || ref.form === 'relative') {
      return `${CONTEXT_PATH}/${target}${suffix}`;
    }
    return undefined;
  }
  if (ref.form !== 'relative') return undefined;
  const source = ref.location.entry ?? '';
  const fromDir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')).split('/') : [];
  const to = target.split('/');
  let common = 0;
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common++;
  const rel = [...fromDir.slice(common).map(() => '..'), ...to.slice(common)].join('/');
  const escapeNonAscii = /%[89A-Fa-f][0-9A-Fa-f]/.test(ref.value);
  return encodePathLike(rel, escapeNonAscii) + suffix;
}

/** Applies edits to the text sources, returning the new texts by entry. */
export function applyTextEdits(texts: ReadonlyMap<string, { text: string }>, edits: ReadonlyMap<string, readonly TextEdit[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [entry, list] of edits) {
    const source = texts.get(entry);
    if (!source) throw new Error(`No text for ${entry}`);
    out.set(entry, applyEdits(source.text, list));
  }
  return out;
}
