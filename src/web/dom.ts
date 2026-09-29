/**
 * Tiny DOM builder. Text is always set with textContent and attributes with
 * setAttribute, so names and messages from a project are never interpreted
 * as HTML.
 */
type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

/** Creates an element with attributes, event listeners (on*) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') el.className = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

/** Appends children, converting primitives to text nodes. */
export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replaces all children of an element. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}
