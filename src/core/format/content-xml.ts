import { ElpxError } from '../errors.js';
import { diagnostic, type Diagnostic } from '../diagnostics.js';
import {
  attributeValue,
  childElement,
  childElements,
  localName,
  parseXml,
  textContent,
  type XmlDocument,
  type XmlElement,
  type XmlTextContent,
} from '../parse/xml.js';
import type { PackageVariant } from './detect.js';

/**
 * Model of an ODE content.xml (the editable representation). The XML tree
 * and raw offsets are kept so references can be rewritten in place.
 */

export const ODE_NAMESPACE = 'http://www.intef.es/xsd/ode';

export interface OdeComponent {
  readonly id: string;
  readonly type: string;
  readonly pageId: string;
  readonly blockId: string;
  readonly element: XmlElement;
  readonly htmlView: XmlTextContent | undefined;
  readonly jsonProperties: XmlTextContent | undefined;
}

export interface OdeBlock {
  readonly id: string;
  readonly name: string;
  readonly pageId: string;
  readonly components: readonly OdeComponent[];
}

export interface OdePage {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly order: string;
  readonly blocks: readonly OdeBlock[];
}

export interface OdeProperty {
  readonly key: string;
  readonly value: XmlTextContent;
}

export interface OdeDocument {
  readonly xml: XmlDocument;
  readonly variant: PackageVariant;
  readonly hasDoctype: boolean;
  readonly properties: readonly OdeProperty[];
  readonly resources: Readonly<Record<string, string>>;
  readonly pages: readonly OdePage[];
  readonly components: readonly OdeComponent[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Parses content.xml text; structural XML errors throw ElpxError (fatal). */
export function parseContentXml(text: string, maxDepth: number): OdeDocument {
  const xml = parseXml(text, { maxDepth });
  const root = xml.root;
  const rootName = localName(root.name);
  if (rootName === 'instance' || rootName === 'dictionary') {
    throw new ElpxError('legacy-elp', 'content.xml contains a legacy eXeLearning 2.x document');
  }
  if (rootName !== 'ode') throw new ElpxError('content-xml-invalid', `Unexpected root element <${root.name}> (expected <ode>)`);
  const diagnostics: Diagnostic[] = [];
  const entry = 'content.xml';
  const text1 = (el: XmlElement | undefined): string => (el ? textContent(el).text : '');
  const keyValues = (container: XmlElement | undefined, item: string): { key: string; value: XmlTextContent; el: XmlElement }[] =>
    container
      ? childElements(container, item).map((el) => {
          const valueEl = childElement(el, 'value');
          return { key: text1(childElement(el, 'key')).trim(), value: valueEl ? textContent(valueEl) : { text: '', chunks: [] }, el };
        })
      : [];

  const resources: Record<string, string> = {};
  for (const r of keyValues(childElement(root, 'odeResources'), 'odeResource')) resources[r.key] = r.value.text;
  const properties = keyValues(childElement(root, 'odeProperties'), 'odeProperty').map((p) => ({ key: p.key, value: p.value }));

  const pages: OdePage[] = [];
  const components: OdeComponent[] = [];
  const nav = childElement(root, 'odeNavStructures');
  const navItems = nav ? childElements(nav, 'odeNavStructure') : [];
  if (navItems.length === 0) diagnostics.push(diagnostic('ode-missing-nav', 'The project has no pages', { location: { entry } }));
  const seen = new Map<string, string>();
  const noteId = (kind: string, id: string): void => {
    if (!id) return;
    const prev = seen.get(id);
    if (prev) diagnostics.push(diagnostic('ode-duplicate-id', `Id "${id}" is used by more than one ${kind}/${prev}`, { location: { entry } }));
    else seen.set(id, kind);
  };
  for (const pageEl of navItems) {
    const pageId = text1(childElement(pageEl, 'odePageId')).trim();
    const name = text1(childElement(pageEl, 'pageName'));
    if (!pageId) diagnostics.push(diagnostic('ode-structure', 'A page has no odePageId', { location: { entry, pageName: name } }));
    noteId('page', pageId);
    const blocks: OdeBlock[] = [];
    const pag = childElement(pageEl, 'odePagStructures');
    for (const blockEl of pag ? childElements(pag, 'odePagStructure') : []) {
      const blockId = text1(childElement(blockEl, 'odeBlockId')).trim();
      if (!blockId) diagnostics.push(diagnostic('ode-structure', 'A block has no odeBlockId', { location: { entry, pageId } }));
      noteId('block', blockId);
      const blockComponents: OdeComponent[] = [];
      const comps = childElement(blockEl, 'odeComponents');
      for (const compEl of comps ? childElements(comps, 'odeComponent') : []) {
        const id = text1(childElement(compEl, 'odeIdeviceId')).trim();
        const type = text1(childElement(compEl, 'odeIdeviceTypeName')).trim();
        if (!id || !type) {
          diagnostics.push(diagnostic('ode-structure', 'A component has no odeIdeviceId or odeIdeviceTypeName', { location: { entry, pageId, blockId } }));
        }
        noteId('component', id);
        const htmlEl = childElement(compEl, 'htmlView');
        const jsonEl = childElement(compEl, 'jsonProperties');
        const component: OdeComponent = {
          id,
          type,
          pageId,
          blockId,
          element: compEl,
          htmlView: htmlEl ? textContent(htmlEl) : undefined,
          jsonProperties: jsonEl ? textContent(jsonEl) : undefined,
        };
        blockComponents.push(component);
        components.push(component);
      }
      blocks.push({ id: blockId, name: text1(childElement(blockEl, 'blockName')), pageId, components: blockComponents });
    }
    pages.push({
      id: pageId,
      parentId: text1(childElement(pageEl, 'odeParentPageId')).trim(),
      name,
      order: text1(childElement(pageEl, 'odeNavStructureOrder')).trim(),
      blocks,
    });
  }
  const pageIds = new Set(pages.map((p) => p.id));
  for (const p of pages) {
    if (p.parentId && !pageIds.has(p.parentId)) {
      diagnostics.push(
        diagnostic('ode-orphan-page', `Page "${p.name}" points to a missing parent page`, { location: { entry, pageId: p.id, pageName: p.name } }),
      );
    }
  }
  const namespace = attributeValue(root, 'xmlns');
  const usesCdata = components.some((c) => c.htmlView?.chunks.some((ch) => ch.chunk.kind === 'cdata'));
  const variant: PackageVariant = namespace === ODE_NAMESPACE || attributeValue(root, 'version') !== undefined || usesCdata ? 'v4' : 'v3';
  return { xml, variant, hasDoctype: xml.doctype !== undefined, properties, resources, pages, components, diagnostics };
}

/** Looks up page and block names for a component, for diagnostics. */
export function componentLocation(
  doc: OdeDocument,
  component: OdeComponent,
): { pageId: string; pageName: string; blockId: string; ideviceId: string; ideviceType: string } {
  const page = doc.pages.find((p) => p.id === component.pageId);
  return {
    pageId: component.pageId,
    pageName: page?.name ?? '',
    blockId: component.blockId,
    ideviceId: component.id,
    ideviceType: component.type,
  };
}
