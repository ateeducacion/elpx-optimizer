# Upstream eXeLearning review: the `.elpx` format as implemented

This review records what upstream eXeLearning actually does with `.elpx` packages, so that
`elpx-optimizer` can shrink them without breaking import, rendering or re-export. It separates
**documented claims** (upstream `doc/`, `llms.txt`, `AGENTS.md`) from **verified code behaviour**.
Where they disagree, the code wins, and the disagreement is listed in [§16](#16-documentation-vs-code-discrepancies).

Every `path:line` citation refers to the pinned upstream commit below, unless another revision
is named. "Verified" means the code was read and, where marked, executed against real fixtures.

---

## 1. Pinned upstream revision

| Item | Value |
|---|---|
| Repository | https://github.com/exelearning/exelearning |
| Pinned SHA | `406a2158623da1862e9f50fdfd5e358b818c9aa8` |
| Commit date | 2026-09-28T16:23:45+02:00 (`build(deps-dev): bump @types/node from 26.2.0 to 26.6.2 (#2452)`) |
| Nearest tag | `v4.0.5` (2026-09-16); `git describe` = `v4.0.5-16-g406a2158` |
| Other recent tags | `v4.0.3` (2026-08-06), `v4.0.2`, `v4.0.1`, `v4.0.0` (2026-04-30), `v3.0.2` and earlier |
| Upstream license | AGPL-3.0-or-later (`LICENSE`, `package.json:4`) |
| Local clone | `.cache/upstream/exelearning` (blobless clone, working tree checked out at the pinned SHA, clean) |

**Why this SHA.** On 2026-09-29, `git ls-remote origin HEAD` and `refs/heads/main` both
resolve to `406a2158`, so current `main` HEAD **is** the commit used by the previous review.
There is therefore no diff between "previous review" and "pinned".

Relevant changes in `v4.0.5..406a2158`, limited to import, export, XML, asset, iDevice and doc paths:

| Commit | Summary | Impact on the format |
|---|---|---|
| `4f5789eb` (#2417) | SCORM 1.2, SCORM 2004 and IMS now honour `exportSource`. It adds `shipsEditableSource()` (`src/shared/export/exporters/BaseExporter.ts:1425-1427`) and `forceEditableSource` (`src/shared/export/interfaces.ts:492-506`). | None for `.elpx`, which always ships `content.xml`. SCORM, IMS and website ZIPs carry `content.xml` only when `exportSource !== false`. |
| `5d12b43e` (#2441) | Inline LaTeX is pre-rendered as a single SVG. | Rendered HTML only. |
| `86ed31d6` (#2301) | iDevice edition resource lifecycle. | Editor only. |
| `b8844f4b` (#2442) | Bun 1.4. | Tooling only. |

`ElpxImporter`, `ElpxExporter`, `OdeXmlGenerator`, the asset handlers and `exe_elpx_download.js`
are unchanged since `v4.0.5`.

Earlier history that matters for packages found in the wild:

| Commit | Date | Change |
|---|---|---|
| `6af7fa43` (#933) | 2026-01-13 | Image optimizer (Pixo) added. |
| `87dfc566` (#1651) | 2026-04-09 | `screenshot.png` added to `.elpx`. |
| `155b950c` (#2196) | 2026-08-03 | `libs/elpx-manifest.js` is generated **last**, so it also lists `content.xml`, `content.dtd` and `screenshot.png`. This landed in `v4.0.3`. `v4.0.0` built the manifest before those files existed (`git show v4.0.0:src/shared/export/exporters/ElpxExporter.ts`, lines 314-324). |

---

## 2. Package variants and how to tell them apart

The importer never looks at the file extension. It inspects the ZIP contents
(`src/shared/import/ElpxImporter.ts:340-448`). `.elp` files in upstream fixtures are sometimes
modern packages; see the fixture inventory in `test/fixtures/upstream/PROVENANCE.md`.

| Variant | Typical ext. | Content file / root | Formatting | Assets | Other markers |
|---|---|---|---|---|---|
| **v4 current** (≥ 4.0.3) | `.elpx` | `content.xml`, `<!DOCTYPE ode SYSTEM "content.dtd">`, `<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">` | Pretty-printed. `htmlView` and `jsonProperties` always in CDATA (`OdeXmlGenerator.ts:301,308,311`). | `content/resources/<folderPath>/<file>`, referenced in XML with the **long** form `{{context_path}}/content/resources/<exportPath>` (see §8). | `content.dtd`. `screenshot.png` if metadata had one. `libs/elpx-manifest.js` when a download link exists; it lists all entries. `odeResources/exe_version` is present but may be empty (CLI). |
| **v4.0.0–4.0.2** | `.elpx` | Same as above. | Same. | Same writer. Real fixtures show a short form after upstream's `flatten-elpx.ts` post-processing. | The manifest omits `content.xml`, `content.dtd` and `screenshot.png`. |
| **v3.0-era** (PHP/Symfony 3.0.x) | `.elpx` **or** `.elp` | `content.xml`, bare `<ode>`, no DOCTYPE, no namespace, no `version` | One line. `htmlView` and `jsonProperties` are **entity-escaped** text, no CDATA. | `content/resources/<ODE-ID>/<file>` with ODE-ID `[0-9]{14}[A-Z0-9]{6}`, referenced as `{{context_path}}/<ODE-ID>/<file>`. Extra `custom/` folder (File Manager). | `odeResources` holds `odeVersionName`, `isDownload`, sometimes `eXeVersion` (e.g. `v3.0.2`). No `content.dtd`, no `screenshot.png`. Either a full web export or source-only (`content.xml` + `content/` + `custom/`). |
| **Legacy eXe ≤ 2.x** | `.elp` | `contentv3.xml`, root `<instance xmlns="http://www.exelearning.org/content/v0.3" … class="exe.engine.package.Package">` | Python-object XML (`<dictionary>`, `<unicode>`, `<string role="key">`). | Flat at the archive root, referenced as `resources/<file>`. | `content.data` (binary, starts `03 80 09 82` then `reference`, a serialized `exe.engine.package.Package`) and `content.xsd`. Some also have `index.html` and site files at the root (`old_epvelp_udl.elp`). |
| **Web / SCORM / IMS export ZIP** | `.zip` | `content.xml` at the root when `exportSource` was on | Per version. | Per version. | Upstream imports these as projects. `download-elpx-link.zip` is a v4 website export with `content.xml` and `content.dtd` but no screenshot. |
| **EPUB3** | `.epub` | `EPUB/content.xml` | — | Under `EPUB/`. | The importer strips the `EPUB/` prefix (`ElpxImporter.ts:389-411`). |
| **Nested** | `.zip` | A single `*.elp`/`*.elpx` at the root and no `content.xml`/`contentv3.xml` | — | — | Recursively unzipped. More than one nested package is an error (`ElpxImporter.ts:362-377`). |
| **Wrapped** | `.zip` | Every entry under one top-level directory (GitHub-style) | — | — | The prefix is stripped first (`ElpxImporter.ts:292-317`). |

### Upstream detection order

Implemented in `ElpxImporter.importFromBuffer`, `src/shared/import/ElpxImporter.ts:340-448`:

1. `safeUnzip` enforces the ZIP limits (§10.1).
2. `unwrapSingleTopLevelDirectory`.
3. If there is no `content.xml` and no `contentv3.xml`, look for exactly one root `.elp`/`.elpx` and unzip it (nested).
4. Try `content.xml`, then `contentv3.xml`, then `EPUB/content.xml`.
5. If none is found, throw `Unable to open this file: content.xml is missing…` (`:413-417`).
6. Parse with `@xmldom/xmldom`. Any `<parsererror>` throws `XML parsing error: …` (`:422-429`).
7. If the root tag is `instance` or `dictionary`, use `LegacyXmlParser` (legacy path, `:431-441`). Otherwise `importStructure()`.

**Legacy markers for our rejection logic:** `contentv3.xml` at the root, or root element
`instance`/`dictionary`, or `content.data` beside it. Upstream **does** import legacy `.elp`,
converting it on the fly. Rejecting it is our design choice, not an upstream rule.

---

## 3. v4 archive layout

The layout comes from `ElpxExporter.export()` (`src/shared/export/exporters/ElpxExporter.ts:98-463`),
which extends `Html5Exporter`:

```
project.elpx
├── content.xml              # ElpxExporter.ts:366-379 (generateOdeXml + validateXml; export aborts if invalid)
├── content.dtd              # ElpxExporter.ts:382 (ODE_DTD_CONTENT, constants.ts:1050-1056)
├── screenshot.png           # ElpxExporter.ts:384-406 — ONLY if meta.screenshot is a valid PNG or a generateScreenshot hook returns one
├── index.html               # first page (ElpxExporter.ts:163-211, written at :347-359)
├── html/<slug>.html         # other pages; slug from BaseExporter.buildPageFilenameMap (:1141+)
├── search_index.js          # only if pp_addSearchBox (ElpxExporter.ts:216-220)
├── content/css/base.css     # :222-245 (+ pre-rendered LaTeX/Mermaid CSS appended)
├── content/css/icons/*.svg
├── content/img/exe_powered_logo.png   # :247-255
├── content/resources/<folderPath>/<file>   # project assets (BaseExporter.addAssetsToZipWithResourcePath :643-675)
├── theme/…                  # :257-266 (embedded or installed theme; fallback style.css/style.js)
├── libs/…                   # base libs (:268-280), material icons (:282-285), common_i18n.js (:287-289),
│                            #   detected libs (:291-316), incl. libs/fflate/fflate.umd.js + libs/exe_elpx_download/…
├── libs/elpx-manifest.js    # LAST, only when a download-source-file / exe-package:elp link exists (:418-424)
├── idevices/<type>/…        # per used iDevice type (:318-338)
└── custom/…                 # seen in v3.0-era packages; see §3.1
```

**ZIP encoding.** `FflateZipProvider` (`src/shared/export/providers/FflateZipProvider.ts:21-52,162-177`)
DEFLATEs (level 6) only these extensions: `css csv dtd htm html js json map mjs ncx opf svg txt xhtml xlf xml xsl`.
Everything else is STORED: images, audio, video, fonts (`woff`/`woff2`/`ttf`), `wasm`, `ico`, `pdf`
and extensionless files. `flatten-elpx.ts:288` instead re-zips everything with `zipSync(…, {level: 6})`.
Paths always use `/`.

### 3.1 `custom/`

The v3.0 File Manager stored uploads in `custom/`. File names there keep their **spaces**, while
XML references use underscores; the browser importer adds both mappings
(`public/app/yjs/AssetManager.js:3516-3536`, `:3645-3656`, `:3722-3752`). No code at the pinned
SHA *writes* `custom/`; a grep of `src/shared/export` for `custom/` finds nothing.
`doc/elpx-format/container.md:65,86` says it is written for `pp_customStyles`; that claim is
unverified.

---

## 4. `content.xml` grammar

### 4.1 Writer output

`src/shared/export/generators/OdeXmlGenerator.ts:46-335`. Values are shown inline; line breaks
and indentation follow the generator exactly.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ode SYSTEM "content.dtd">                       <!-- omitted when includeDoctype=false (SCORM/IMS) -->
<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">
<userPreferences>
  <userPreference>
    <key>theme</key>
    <value>base</value>
  </userPreference>
</userPreferences>
<odeResources>                                             <!-- :110-125 -->
  <odeResource><key>odeId</key><value>20260929101500ABC123</value></odeResource>
  <odeResource><key>odeVersionId</key><value>…</value></odeResource>
  <odeResource><key>exe_version</key><value>4.0.5</value></odeResource>   <!-- normalizeExeVersion(meta.exelearningVersion); may be "" -->
  <odeResource><key>scormIdentifier</key><value>…</value></odeResource>    <!-- optional -->
</odeResources>
<odeProperties>                                            <!-- :152-170, one per non-empty meta key -->
  <odeProperty><key>pp_title</key><value>…</value></odeProperty>
  …
</odeProperties>
<odeNavStructures>
<odeNavStructure>
  <odePageId>page-mohmu82h-p2jyufbwg</odePageId>          <!-- ANY id string; see §4.4 -->
  <odeParentPageId></odeParentPageId>                     <!-- empty = root -->
  <pageName>…</pageName>
  <odeNavStructureOrder>0</odeNavStructureOrder>
  <odeNavStructureProperties>
    <odeNavStructureProperty><key>titlePage</key><value>…</value></odeNavStructureProperty>
    <!-- then every page.properties entry: visibility, highlight, hidePageTitle, editableInPage, titleNode, … -->
  </odeNavStructureProperties>
  <odePagStructures>
    <odePagStructure>
      <odePageId>…</odePageId>                             <!-- redundant copy of the page id -->
      <odeBlockId>…</odeBlockId>
      <blockName>…</blockName>
      <iconName>…</iconName>
      <odePagStructureOrder>0</odePagStructureOrder>
      <odePagStructureProperties>                          <!-- keys: visibility teacherOnly allowToggle minimized cssClass -->
        <odePagStructureProperty><key>visibility</key><value>true</value></odePagStructureProperty>
      </odePagStructureProperties>
      <odeComponents>
        <odeComponent>
          <odePageId>…</odePageId>
          <odeBlockId>…</odeBlockId>
          <odeIdeviceId>…</odeIdeviceId>
          <odeIdeviceTypeName>text</odeIdeviceTypeName>
          <htmlView><![CDATA[ …HTML… ]]></htmlView>                          <!-- always CDATA, ]]> split by escapeCdata -->
          <jsonProperties><![CDATA[ {…JSON…} ]]></jsonProperties>           <!-- or raw malformed payload verbatim (:304-308) -->
          <!-- or <jsonProperties></jsonProperties> when properties are empty (:312-314) -->
          <odeComponentsOrder>0</odeComponentsOrder>
          <odeComponentsProperties>                        <!-- keys: visibility teacherOnly cssClass; default visibility=true -->
            <odeComponentsProperty><key>visibility</key><value>true</value></odeComponentsProperty>
          </odeComponentsProperties>
        </odeComponent>
      </odeComponents>
    </odePagStructure>
  </odePagStructures>
</odeNavStructure>
</odeNavStructures>
</ode>
```

Rules that follow from the writer:

- `escapeCdata` replaces `]]>` with `]]]]><![CDATA[>` (`OdeXmlGenerator.ts:365-369`). Inside CDATA nothing else is escaped.
- `escapeXml` is applied to every key, value and id (`:350-358`).
- The `<odeNavStructure>` elements form a **flat list**. Hierarchy comes from `odeParentPageId`; the importer rebuilds the tree and sorts siblings by order (`ElpxImporter.ts:600-614,1325-1386`).
- DTD: `public/app/schemas/ode/content.dtd`, embedded as `ODE_DTD_CONTENT` (`src/shared/export/constants.ts:1056`). Root content model: `ode (userPreferences?, odeResources?, odeProperties?, odeNavStructures)`, with `xmlns` `#FIXED "http://www.intef.es/xsd/ode"`. `htmlView`, `jsonProperties`, the property containers, `iconName` and `odePagStructures`/`odeComponents` are optional.

### 4.2 `odeProperties` keys

`src/shared/export/metadata-properties.ts:48-260`:

- **Standard keys:** `pp_title`, `pp_subtitle`, `pp_author`, `pp_description`, `pp_lang`, `pp_license`, `pp_licenseUrl`, `pp_keywords`, `pp_category`, `pp_theme`, `pp_customStyles`, `pp_exelearning_version`, `pp_addExeLink`, `pp_addPagination`, `pp_addSearchBox`, `pp_addAccessibilityToolbar`, `pp_addMathJax`, `pp_globalFont`, `pp_extraHeadContent`.
- **Keys without the `pp_` prefix** (legacy): `exportSource` (`:177`) and `footer` (`:202`).
- **Excluded from XML:** `odeIdentifier`, `odeVersionId`, `createdAt`, `modifiedAt`, `scormIdentifier`, `masteryScore`.
- **Unknown metadata keys** fall back to `pp_${key}` (`getXmlKeyForProperty`, `:287-290`). Booleans are written as the strings `true`/`false`.

> **Verified leak: `pp_screenshot`.** `YjsDocumentAdapter.getMetadata()` passes `screenshot`
> (the `data:image/png;base64,…` URL) into `ExportMetadata`
> (`src/shared/export/adapters/YjsDocumentAdapter.ts:117-118`). `screenshot` is not in
> `METADATA_PROPERTIES`, so `generateOdePropertiesXml` writes
> `<odeProperty><key>pp_screenshot</key><value>data:image/png;base64,…</value></odeProperty>`.
> The browser uses the same adapter (`src/shared/export/browser/index.ts:19`).
>
> - **Reproduced:** calling `generateOdeXml({…, screenshot:'data:…'})` emits `pp_screenshot`, and `bun run src/cli/index.ts elp:export download-elpx-link.elpx out.elpx elpx` produced a 77 KB `content.xml` containing the full base64 copy of the 54 KB `screenshot.png`.
> - **Not in fixtures:** no upstream fixture contains `pp_screenshot`, probably because they predate the feature.
> - **Not imported:** `extractMetadata` never reads `pp_screenshot` (`ElpxImporter.ts:1240-1281`); the screenshot comes only from the `screenshot.png` entry.
>
> The value is therefore dead weight in `content.xml`, and likely present in real v4.0.x
> browser exports made after 2026-04. The same mechanism writes `pp_modified`.

### 4.3 What the importer reads back

`extractMetadata` (`ElpxImporter.ts:1240-1281`) reads only a fixed subset of properties:

- Theme: `userPreferences/theme`, falling back to `pp_style`.
- Text: `pp_title` (default `Imported Project`), `pp_subtitle`, `pp_author`, `pp_lang` (default `en`), `pp_description`, `pp_license`, `pp_extraHeadContent`, `footer`.
- Flags: `pp_addPagination`, `pp_addSearchBox`, `pp_addExeLink` (default true), `pp_addAccessibilityToolbar`, `exportSource` (default true), `pp_addMathJax`.
- `pp_globalFont` (default `default`).

`odeResources` supplies `odeId`, `odeVersionId` and `scormIdentifier`, which are preserved (`:622-634`).
`pp_keywords`, `pp_category`, `pp_customStyles` and similar keys are **not** restored by this
importer. When comparing metadata through upstream, compare only the keys it reads.

### 4.4 IDs

- **ODE IDs.** `generateOdeId()` produces `YYYYMMDDhhmmss` plus 6 characters from `[A-Z0-9]` (`src/shared/export/utils/odeId.ts`).
- **Page, block and component IDs** created in the v4 editor come from `generateId(prefix)`, which yields `<prefix>-<base36 time>-<9 chars>`, e.g. `page-mohmu82h-p2jyufbwg` (`src/shared/ids.ts:20-30`). Real v4 fixtures contain both styles.
- **Import keeps the XML IDs** whenever they do not collide (`ElpxImporter.ts:1340-1351` pages, `:1439-1442` blocks, `:1486-1490` components). With `clearExisting=true` (the default) nothing collides. Only merge-mode imports regenerate IDs and then remap `exe-node:` links (`:1909-1941`).

### 4.5 Entity-escaped content (v3.0-era)

When `<htmlView>` has no CDATA child, the importer:

1. takes `textContent`, which the XML parser has already entity-decoded once;
2. runs `decodeHtmlContent` over it **again** (`ElpxImporter.ts:1519-1524,2259-2272`).

A literal `&lt;` in the author's text is therefore turned into `<` on import. This is an
upstream quirk; we must preserve the bytes and not reproduce it.

`jsonProperties` is parsed from `textContent` with three candidates, in this order (`:1542-1564`):

1. the raw text;
2. the text with `&lt; &gt; &amp; &#…;` decoded, keeping `&quot;`;
3. the text fully decoded.

---

## 5. The exported HTML side

- **Pages.** `index.html` is the first page in flat order. Every other page is `html/<slug>.html`.
  - `sanitizePageFilename` (`BaseExporter.ts:486-500`) lowercases, strips accents and keeps only `[a-z0-9\s-]`, turning spaces into `-`.
  - Collisions are numbered (`:1141+`). Titles that sanitize to an empty string become `page`.
- **Asset URL resolution at render time.** `IdeviceRenderer.fixAssetUrls`, `src/shared/export/renderers/IdeviceRenderer.ts:420-528`:
  - `{{context_path}}/X` becomes `${basePath}content/resources/X`, or `${basePath}X` when X already starts with `content/resources/`. `basePath` is `''` for `index.html` and `'../'` for `html/*.html`.
  - `asset://<uuid>[.ext]` becomes `content/resources/<exportPath>` (the export path map, §11).
  - `files/tmp/…/<dir>/<file>` becomes `content/resources/<dir>/<file>`. This is how stale editor-upload paths leak into HTML as `content/resources/<ODE-ID>/<file>`.
  - `src|href="resources/X"` becomes `content/resources/X`.
  - `http://localhost:NNNN/(files|scripts)/…` becomes `files/perm/…`.
  - Filenames are **not** percent-encoded; they appear raw, e.g. `800px-Aerial_view_of_Berlin_(32881394137).jpeg`.
- **`search_index.js`.** Contains `window.exeSearchData = {…}` holding every iDevice's `htmlView`, and nested `jsonProperties` strings, **with raw `{{context_path}}/…` references**, JSON-escaped (`\"`, and `\\\"` when nested). In the flattened v4 fixture these references still point to `…/20251009090601SQPBIF/00.jpg` although the file now lives at `content/resources/00.jpg`. Neither `flatten-elpx.ts` nor the export pipeline rewrites them later.
- **Download links.** `exe-package:elp` becomes an `onclick` handler at render time (see §6).

---

## 6. `libs/elpx-manifest.js` and the download-source-file contract

### 6.1 Authoring side (`htmlView`)

`jsonProperties` is empty for this iDevice. Markup produced by
`public/files/perm/idevices/base/download-source-file/edition/download-source-file.js:533-546`:

```html
<div class="exe-download-package-instructions">…instructions / info table…</div>
<p class="exe-download-package-link"><a download="exe-package:elp-name" href="exe-package:elp"[ style="font-size:…;background-color:#…;color:#…;"]>Button text</a></p>
```

Any iDevice may also carry a manual `<a href="exe-package:elp" download="exe-package:elp-name">`;
the `download-elpx-link.elpx` fixture has one in a `text` iDevice. The legacy type name
`download-package` is aliased to `download-source-file` (`src/shared/import/interfaces.ts:213-215`).

### 6.2 Detection

A page needs download support when any of its components matches one of these
(`BaseExporter.pageHasDownloadSourceFile`, `src/shared/export/exporters/BaseExporter.ts:1298-1317`):

- the type contains `download-source-file` or `downloadsourcefile`;
- the content contains `exe-download-package-link`;
- the content contains `exe-package:elp`.

### 6.3 Render-time rewrite

`PageRenderer.replaceElpxProtocol`, `src/shared/export/renderers/PageRenderer.ts:884-897`:

- `href="exe-package:elp"` becomes `href="#" onclick="<ELPX_DOWNLOAD_ONCLICK>"` (`src/shared/export/constants.ts:309-312`). The handler asks the parent editor via `postMessage({type:'exe-download-elpx'})` when embedded, otherwise it calls `downloadElpx()`. Older exports only have `if(typeof downloadElpx==='function')downloadElpx();return false;`.
- `download="exe-package:elp-name"` becomes `download="<escaped project title>.elpx"`.
- The source HTML in `content.xml` keeps the `exe-package:` pseudo-URLs (`BaseExporter.ts:1085-1095`).

### 6.4 Files and script tags

- **Libraries.** `libs/fflate/fflate.umd.js` and `libs/exe_elpx_download/exe_elpx_download.js` are added through `LIBRARY_PATTERNS`: class `exe-download-package-link`, or regex `/exe-package:elp/` (`constants.ts:285-300`, `BaseExporter.ts:1324`).
- **Page injection.** In ELPX export, every page that has the link gets `<script src="[../]libs/elpx-manifest.js"> </script>` inserted before `</body>` (`ElpxExporter.ts:353-357`). The HTML5 exporter also injects the fflate and `exe_elpx_download` tags (`BaseExporter.injectElpxScripts`, `:1373-1380`). Real pages contain the library tags twice: once from library detection, once from injection.

### 6.5 Manifest format

Written by `BaseExporter.generateElpxManifestFile`, `:1389-1402`:

```js
/**
 * ELPX Manifest - Auto-generated for download-source-file iDevice
 * Used by exe_elpx_download.js to recreate the complete export package
 */
window.__ELPX_MANIFEST__={
  "version": 1,
  "files": [
    "search_index.js",
    "content/css/base.css",
    …,
    "content.xml",
    "content.dtd",
    "screenshot.png",
    "libs/elpx-manifest.js"
  ],
  "projectTitle": "Project title"
};
```

The JSON is `JSON.stringify({version, files, projectTitle}, null, 2)`, followed by `;` and a newline.

`files` is built differently depending on the version that wrote the package:

- **v4.0.3 and later.** `this.zip.getFilePaths()`, minus the manifest itself, then `libs/elpx-manifest.js` appended **last** as a self-reference, so a re-downloaded package can offer the download again (`ElpxExporter.ts:418-424`). The list is therefore every ZIP entry, directories excluded.
- **v4.0.0–4.0.2.** Built from `addFile` tracking before `content.xml`, `content.dtd` and `screenshot.png` were added. The list is every entry **except** those three; HTML pages are listed near the end, and the manifest self-reference is last.

`exe_elpx_download.js` reads only `files`, `projectTitle` and the optional `basePath` and `isPreview`.

**The manifest goes stale in the wild.** In `un-contenido…elpx`, the manifest lists 7
`content/resources/2025100909060…/<f>` paths that are absent from the ZIP, whose files are flat.
The Manual fixture's manifest lists 1551 entries against 1376 files. Both follow from upstream's
`scripts/flatten-elpx.ts`, which rewrites only `content.xml`, `index.html` and `html/*.html`
(`scripts/flatten-elpx.ts:112-119`).

### 6.6 Runtime

`public/libs/exe_elpx_download/exe_elpx_download.js`:

- **Over HTTP** (`:49-146`):
  - Fetches each `basePath + path` with 10 concurrent requests. Paths are concatenated unencoded, so `#`, `?` or `%` in a filename would break the fetch.
  - `basePath` is `manifest.basePath`, or `'../'` when `location.pathname` contains `/html/`, otherwise `''` (`:319-326`).
  - **A missing file only triggers `console.warn` and is silently left out** of the rebuilt ZIP (`:105-113`).
  - The ZIP is built with `fflate.zip`: level 0 for `mp4|mp3|ogg|ogv|webm|woff|woff2|zip|gz|elpx`, level 6 for everything else (`:355-371`).
  - The download is named `<projectTitle>.elpx`.
- **Under `file://`:** the manifest is ignored. The user picks the export folder and every non-dot file in it is zipped (`:161-260`).

**Contract for the optimizer.** After adding, removing or renaming entries, rewrite `files` to
exactly the set of ZIP entries. Keep the order stable, put `libs/elpx-manifest.js` last, and keep
`version`/`projectTitle`. Do not remove the manifest while any page still links to `exe-package:elp`.

---

## 7. `screenshot.png`: claims vs code

| Question | Documented claim | Verified behaviour |
|---|---|---|
| Is it always written? | "always present in v4", "required for v4" (`doc/elpx-format.md:18,29`, `container.md:77`, `validation.md:149`). | **No.** Written only if `meta.screenshot` decodes to bytes with the PNG signature, or `options.generateScreenshot` returns one (`ElpxExporter.ts:384-406`, signature check `:41-75`). The CLI passes no `generateScreenshot` (`src/cli/commands/elp-export.ts:267`), so CLI exports have a screenshot only if the input did. The browser path calls `YjsProjectBridge` `ensureScreenshot…` to auto-generate one into metadata before an ELPX export (`public/app/yjs/YjsProjectBridge.js:3191-3260,3471`), so browser exports normally include it. |
| Is it needed on import? | "tolerated" (`screenshot.md` §5.3). | **Optional and not validated.** `extractScreenshotFromZip` base64s whatever `screenshot.png` bytes exist into `metadata.screenshot` (`ElpxImporter.ts:1203-1213,636-640`; legacy path `:818-822`). A non-PNG body is only rejected at the next export, and then silently dropped. |
| Which variants lack it? | — | v3.0-era packages, all legacy `.elp`, all website/SCORM ZIPs, and minimal fixtures (`missing-asset-refs`, `stale-text-template-refs`, `damaged-trueorfalse-json`, which hold only `content.xml` + `content.dtd`). Full v4 `.elpx` fixtures have it. |
| Other copies? | — | (a) `theme/screenshot.png` is an unrelated theme preview. (b) `pp_screenshot` in `content.xml`, see §4.2. (c) The CLI asset handler treats a root `*.png` as a legacy media asset (`FileSystemAssetHandler.ts:106-127`; `SYSTEM_FILES` at `:59` lacks `screenshot.png`), so CLI re-exports gain `content/resources/screenshot.png`, which accumulates on every round trip. Verified in the harness. The browser import does **not** do this (§10.2). |
| Size or dimensions enforced? | 1280×720 recommended. | Not enforced anywhere. |

**Optimizer implication.** `screenshot.png` can be recompressed losslessly (PNG to PNG). Keep it
a PNG with a valid signature, or the next upstream export drops it. Changing its format is not
allowed.

---

## 8. Asset reference mechanisms

### 8.1 In `content.xml` (`htmlView` and `jsonProperties`)

| Form | Example | Written by | Resolved by upstream import |
|---|---|---|---|
| **Long placeholder** (current writer) | `{{context_path}}/content/resources/photos/sun.jpg` | `BaseExporter.addFilenamesToAssetUrls`, `src/shared/export/exporters/BaseExporter.ts:1007-1074`. **Every export at the pinned SHA emits this form** (`:1018,1033,1048,1055,1065`). | Browser: exact lookup of `content/resources/…` in `assetMap`. CLI: `split('{{context_path}}/'+zipPath)`. |
| **Short placeholder** (flat) | `{{context_path}}/sun.jpg` | Output of `scripts/flatten-elpx.ts`. The docs call it "new exports", but the code does not write it. | Browser: prefix trials `''`, `content/`, `content/resources/`, `resources/`, then basename match (`AssetManager.js:3684-3720`). CLI: filename alias (`FileSystemAssetHandler.ts:314-317`). |
| **Short with user folder** | `{{context_path}}/photos/sun.jpg` | flatten output; documented as the v4 form. | Browser: prefix trials. CLI: **not resolved** (only the full ZIP path and a bare-filename alias are mapped). Code reading only, untested. |
| **v3.0 ODE-ID folder** | `{{context_path}}/20251009090601SQPBIF/00.jpg` | eXe 3.0.x | Browser: `content/resources/` prefix; on miss, basename; on miss, last-two-segments; on miss, `custom/` heuristics. The browser keeps `20251009…` as a real `folderPath` because the regex `/^[a-f0-9-]{8,}$/i` does not match it (`AssetManager.js:1646-1667`), so a re-export writes `content/resources/<ODE-ID>/…`. |
| **`resources/` placeholder** | `{{context_path}}/resources/x.png` | old | CLI: explicit (`FileSystemAssetHandler.ts:355`). Browser: prefix trial. |
| **Bare legacy path** | `src="resources/x.png"`, or a JSON string `"resources/x.png"` | legacy `.elp` | Browser: `/(src|href)=(["'])resources\/([^"']+)\2/gi` (`AssetManager.js:3768`). Importer: JSON strings that *start with* `resources/` go through `findAssetUrlForPath` (`ElpxImporter.ts:2372-2377,2411-2446`). |
| **Stale upload path** | `files/tmp/2025/10/24/20251024113355JKQMOB/idevice_texto_caja.jpg` | editor leftovers, mostly inside encrypted DataGame JSON (§9.2) | Not resolved on import. Rewritten at render time only (`IdeviceRenderer.ts:490-503`). |
| **Yjs internal** | `asset://3f7a…5678.jpg`, `asset://3f7a…5678`, and CLI filename IDs `asset://resources/00.jpg` | Should never be persisted; it is the in-memory form | The exporter turns unresolved ones into `{{context_path}}/content/resources/<uuid><ext>` (`BaseExporter.ts:1014-1034`). |
| **Pseudo-links** (not assets; must be preserved) | `exe-node:<pageId>[#frag]`, `exe-package:elp`, `exe-package:elp-name` | editor | `exe-node:` is remapped only in merge imports (`ElpxImporter.ts:1909-1941`). |

**Regexes upstream uses:**

- **Browser import**, placeholder: `/\{\{context_path\}\}\/([^"'<>]+)/g` (`AssetManager.js:3758`). It does **not** stop at whitespace or `\`. `findAssetUrl` strips trailing `\` and whitespace, but the replacement consumes them. A JSON-escaped `\"` inside HTML (for example inside the interactive-video JSON) therefore loses its backslash on import; this is an upstream bug.
- **Browser import**, legacy attributes: `/(src|href)=(["'])resources\/([^"']+)\2/gi` (`:3768`).
- **Unresolved-reference detector**, run after conversion on `htmlView` and on `JSON.stringify(props)`: `/\{\{context_path\}\}\/([^"'<>\s\\]+)/g` (`src/shared/import/unresolvedAssetRefs.ts:29`). A surviving placeholder means the file is missing; it is reported as `ElpxImportResult.missingAssets[{componentId, ideviceType, paths[]}]`.
- **Export rewrite:** `/asset:\/\/([a-f0-9-]{36})(\.[a-z0-9]+)?/gi`, then `/asset:\/\/([^"'\s]+)/g`, then a duplicate-path fix `/content\/resources\/([^/"]+)\/\1(?=["'\s>])/g` (`BaseExporter.ts:1014,1039,1071`). The second regex runs over `JSON.stringify(properties)`, where it swallows the `\` of `\"`. That breaks CLI (filename-ID) round trips of HTML stored inside JSON; see §15.3.
- **Render:** `/\{\{context_path\}\}\/([^"'\s]+)/g` (`IdeviceRenderer.ts:437`; also `src/shared/export/adapters/ExportAssetResolver.ts:70`).

**Encoding.**

- Upstream never percent-decodes or percent-encodes asset paths during import, export or rendering. A `{{context_path}}/my%20file.jpg` reference fails exact lookup and basename lookup in the browser. `flatten-elpx.ts:211-215` is the only place that also rewrites `encodeURIComponent` variants.
- Inside CDATA, HTML entities in attribute values (`&amp;`) are kept literally, so a lookup against a filename containing `&` would fail. In v3.0 entity-escaped XML they are decoded twice (§4.5).
- No filename sanitization was found in `buildAssetExportPathMap` or in `AssetManager` uploads, so raw spaces and non-ASCII names are possible. `doc/elpx-format/assets.md:194` claims the exporter sanitises filenames; that is unverified.

**Lenient resolution in the browser.** A reference whose exact path is missing still resolves
when **any** asset has the same basename (`AssetManager.js:3703-3709`). Real fixtures depend on it:

- `Manual de eXeLearning 3.0.elpx`: 1317 `{{context_path}}` references; 1216 resolve exactly, 85 only by basename, 16 are really missing (plus 34 dangling references in its HTML).
- `todos-los-idevices_dos_informes.elpx`: 638 exact, 55 basename-only, 98 missing.

Our tool must never rename or drop a file whose basename is the only thing keeping such a
reference alive.

### 8.2 In the exported HTML files

- `index.html`: `content/resources/<path>`.
- `html/*.html`: `../content/resources/<path>`, plus `../libs/…`, `../theme/…`, `../idevices/…`.
- Both kinds of page can also contain `content/resources/<ODE-ID>//<file>`: double slashes and stale folders are present in fixtures.
- `search_index.js` holds raw `{{context_path}}` references (§5).
- Theme CSS uses theme-relative `url(img/…)`.
- iDevice runtime JS loads its own `idevices/<type>/…` files. The interactive-video runtime also hard-codes `idevices/interactive-video/*.gif`.

---

## 9. iDevice storage patterns (verified against code and fixtures)

The upstream doc (`doc/elpx-format/idevices/patterns.md`) names four patterns. The code and the
real fixtures refine them as follows.

### 9.1 Pattern 1: plain JSON in `jsonProperties`, with HTML mirrored in `htmlView`

- **Types:** `text`, `casestudy`, `image-gallery`, `magnifier`, `trueorfalse`, `form`, `digcompedu`, `example`, `geogebra-activity`, `scrambled-list`, `udl-content`, `file-attachment`, …
- **Common fields:** `ideviceId`, `textInfoDurationInput`, `textInfoParticipantsInput`, `textInfoDurationTextInput`, `textInfoParticipantsTextInput`, `textTextarea` (HTML string), `textFeedbackInput`, `textFeedbackTextarea`.
- **Asset references** live in `htmlView` attributes **and** inside HTML strings in the JSON, e.g. `"textTextarea":"<p><img src=\"{{context_path}}/content/resources/a.jpg\"></p>"`.
- The importer walks every JSON string (`convertAssetPathsInObject`, `ElpxImporter.ts:2363-2404`). Rewriting therefore has to cover JSON string values with JSON-level escaping, in addition to the HTML.
- **`file-attachment`** (ADR-1858-02) stores `{url:"asset://<uuid>.<ext>", filename, mimeType, size, title, description}` per attachment. In `content.xml`, `url` becomes `{{context_path}}/content/resources/…`. `size` and `filename` form a **metadata snapshot**: recompressing an attachment makes `size` stale, which is cosmetic.
- **Stale eXe 3 text template.** Non-text iDevices converted by eXe 3 may carry text-iDevice fields in `jsonProperties`, for example the interactive-video component of `un-contenido…elpx`. Upstream now **drops** these on import (`isLegacyGenericTextTemplate`, `ElpxImporter.ts:1575-1586`, #2376). They still reference files, so they can make an asset look "used" to a naive scanner.
- **Malformed `jsonProperties`** is preserved verbatim, reported in `malformedProperties`, and written back raw inside CDATA (`ElpxImporter.ts:1565-1574`, `OdeXmlGenerator.ts:304-308`, ADR-2190-01). Fixture: `damaged-trueorfalse-json.elpx`.

### 9.2 Pattern 2: DataGame hidden `<div>` inside `htmlView`

The doc describes this pattern as `encodeURIComponent(JSON)`. **That does not match the code or
any fixture.** A script decoded every `*-DataGame` div in the two largest fixtures
(`todos-los-idevices_dos_informes.elpx`, `Manual de eXeLearning 3.0.elpx`) and found exactly two
encodings:

| Encoding | Detect | Decode | Used by (class → type) |
|---|---|---|---|
| **Plain JSON text** | Trimmed body starts with `{` | `JSON.parse` via `helpers.isJsonString`, which also calls `sanitizeJSONString` (`public/app/common/common.js:2977-2991`) | `beforeafter-DataGame`, `dragdrop-DataGame`, `flipcards-DataGame`, `mapa-DataGame` (map), `mathoperations-DataGame`, `periodic-table-DataGame`, `informe-DataGame` (progress-report), `relaciona-DataGame` (relate), `trivial-DataGame` |
| **XOR-obfuscated** | Anything else. A sibling `<div class="<x>-version js-hidden">N</div>` often exists, and some runtimes decrypt only when version > 0 or has length 1 (e.g. `guess/export/guess.js:185-196`, `guess/edition/guess.js:1088-1093`). | `helpers.decrypt(str)` = `unescape(str)`, then XOR 146 per UTF-16 code unit (`common.js:3004-3020`; twin in `public/app/common/LatexPreRenderer.js:989-1026`). Encode = XOR 146, then `escape()` (`common.js:3022-3030`). | `rosco-` (az-quiz-game), `desafio-` (challenge), `listacotejo-` (checklist), `clasifica-` (classify), `completa-` (complete), `crucigrama-` (crossword), `descubre-` (discover), `adivina-` (guess), `hiddenimage-` (hidden-image), `identifica-` (identify), `mathproblems-`, `candado-` (padlock), `puzzle-`, `quext-` (quick-questions), `selecciona-` (quick-questions-multiple-choice), `vquext-` (quick-questions-video), `seleccionamedias-` (select-media-files), `ordena-` (sort), `sopa-` (word-search), `ELCP-`/`electrical-circuits-` (code only) |

`escape()`/`unescape()` are the legacy JS functions: `%XX` for code units below 256 and `%uXXXX`
otherwise. A decoder must implement those exact semantics. Python `unquote(latin-1)` breaks on
`%uXXXX`.

**Where DataGame assets really live:**

- **Encrypted games.** Media fields inside the encrypted JSON (`url`, `audio`, …) are **stale**. Fixtures show `files/tmp/…` editor paths, because `addFilenamesToAssetUrls` cannot see through the XOR. The runtime and the editor instead override them from sibling anchors:

  ```html
  <a href="{{context_path}}/content/resources/rabbit.svg" class="js-hidden clasifica-LinkImages">0</a>
  <a href="{{context_path}}/…/c1.png" class="js-hidden ordena-LinkImages-1">0</a>   <!-- class may carry a -N suffix -->
  ```

  The anchor text is the item index. The runtime assigns `wordGame.url = $(this).attr('href')` (`guess/export/guess.js:282-291`), and the editor writes the anchors on save (`guess/edition/guess.js:1212-1235,1270-1282`).
- **Anchor class families seen:** `*-LinkImages`, `*-LinkImagesBack`, `*-LinkImagesDef`, `*-LinkImagesMapas`, `*-LinkImagesPoints`, `*-LinkTextsPoints`, `*-LinkAudios`, `*-LinkAudiosBack`, `*-LinkAudiosDef`, `*-LinkAudiosClue`, `*-LinkAudiosHit`, `*-LinkAudiosError`, `*-LinkBack`, `*-LinkWordings`, `*-LinkLocalVideo`.
- **Plain-JSON games** (map, flipcards, dragdrop, relate, beforeafter) contain **live** `{{context_path}}/…` URLs inside the JSON text in `htmlView`, e.g. `mapa-DataGame` `"url":"{{context_path}}/celulas.png"`. They also have link anchors.
- **Percent-encoded fields inside plain JSON.** Some fields are individually percent-encoded (flipcards and dragdrop `eText` through `decodeURIComponentSafe`, `flipcards/export/flipcards.js:252-277`). The whole div is never URI-encoded.
- **What an optimizer must do:**
  - Rewrite hrefs in link anchors and plain-JSON strings.
  - For encrypted payloads, *optionally* decrypt, rewrite and re-encrypt. They are stale in practice, but can hold `{{context_path}}` or `asset://` references.
  - Never re-serialise a payload it did not change.
  - `LatexPreRenderer.preRenderDataGameLatex` already decrypts and re-encrypts in upstream, which proves the round trip is supported.

### 9.3 Pattern 3: embedded JSON block (interactive-video)

The current editor saves this (`interactive-video/edition/interactive-video.js:909-944`):

```html
<div class="exe-interactive-video-content-before">…</div>
<div class="game-evaluation-ids js-hidden" data-id="…" data-evaluationb="…" data-evaluationid="…"></div>
<div class="exe-interactive-video[ exe-interactive-video-no-results]">
  <p id="exe-interactive-video-file" class="js-hidden"><a href="VIDEO_URL">EXT</a></p>
  <script id="exe-interactive-video-contents" type="application/json">
{"slides":[{"type":"image","url":0,"startTime":12}, …],"i18n":{…},"scorm":{…},"ideviceID":"…"}</script>
</div>
<p class="sr-av"><video width="320" height="240" controls="controls" class="mediaelement"><source src="VIDEO_URL" /></video></p>  <!-- local video only -->
<p class="exe-interactive-video-img sr-av"><img src="IMG_URL" id="exe-interactive-video-img-0" alt="" /></p>  <!-- one per image slide -->
```

- All real fixtures use the older `<div id="exe-interactive-video-contents" style="display: none">{…}</div>`. The editor reads both forms (`:379-420`).
- Image slides store `url` either as an index into the `exe-interactive-video-img-N` images, or as an `asset://` URL. In `content.xml` the latter becomes `{{context_path}}/…` **inside the JSON text** (`:824-858`).
- **Local video detection.** An href that starts with `resources/` or is not `http` / `//` counts as local (`export/interactive-video.js:933-941`). The type comes from the **file extension**, mapped `mp4|m4v → video/mp4`, `webm`, `ogv|ogg` (`:514-521`).
- **If a video is transcoded:** the `<a href>`, the `<source src>` and the anchor text, which is the extension, must all change together. Keep the extension to avoid all of that.
- No fixture has a *local* interactive video; all use YouTube. `jsonProperties` may be empty, or hold a stale text template.

### 9.4 Pattern 4: `htmlView`-only

- **Types:** `rubric`, `external-website`, `download-source-file`, and others whose `jsonProperties` is empty or `<jsonProperties></jsonProperties>`.
- Asset references are ordinary `src`/`href`/`data-*`/`poster` attributes. The render regexes run over the whole string, not only attributes.

### 9.5 Cross-cutting rule for scanners

References can appear in:

- HTML attributes;
- raw text, e.g. JSON inside `<script>` or `<div>`;
- JSON-escaped HTML inside `jsonProperties`;
- sibling `*-Link*` anchors;
- XOR payloads.

Upstream's own "Resources report" (`POST /api/ode-management/odes/session/usedfiles`,
`src/routes/project.ts:1982-2142`) only matches `(href|src)="(files/…|asset://…)"` in `htmlView`
(`:2022,2032`). The static-mode variant scans `asset://` in `htmlView` plus `jsonProperties`
(`public/app/rest/apiCallManager.js:970-1076`). **Neither can be used as an "unused asset"
oracle**: the first misses JSON, DataGame and script-embedded references.

---

## 10. Import pipeline

### 10.1 Limits

`src/shared/import/importPolicy.ts`:

- **Conservative (hosted web, server, CLI, static PWA, embedded):** 200 MiB per entry, 500 MiB total, 10 000 entries (`:52-56`).
- **Desktop (Electron):** 1 GiB per entry, 2 GiB total, 10 000 entries (`:73-77`). The user is asked to confirm entries above 200 MiB (`:86`).
- Limits are checked against the **declared** `originalSize` in the central directory before inflation (`ElpxImporter.ts:193-222`).
- `inspectZipArchive` does the same without inflating anything (`:106-126`). The browser adapter runs it as a preflight (`src/shared/import/browser/index.ts:232-233`).
- Errors are `ZipLimitError` with `details.kind` of `entry-size`, `total-size` or `entry-count`.

**Optimizer target:** outputs must fit the conservative limits so every runtime can open them.
Warn when the input only fits the desktop policy.

### 10.2 Asset extraction

**Browser** (the primary path, `public/app/yjs/AssetManager.js:3445-3670`, wrapped by
`src/shared/import/adapters/BrowserAssetHandler.ts`):

- **Skipped:**
  - directories and `__MACOSX*`;
  - **any `*.xml`, `*.xsd` or `*.data` file anywhere**, so a user asset `content/resources/data.xml` is silently dropped;
  - `idevices/`, `libs/`, `theme/`, `content/css/`, `content/img/`, `html/`;
  - `index.html`, `base.css`, `common_i18n.js`, `common.js`.
- **Included, for `content.xml` packages:**
  - paths starting with `resources/` or `content/resources/`, or containing `/resources/`;
  - paths whose first segment is a UUID or `(idevice|block|page)-x-y`;
  - `custom/**` except dotfiles.
- **Included, for legacy packages:** root-level files only.
- **Root `screenshot.png`, `search_index.js` and `content.dtd` are therefore not assets.**
- **IDs:**
  - The ID is `hashToUUID(sha256)`, i.e. the first 32 hex characters formatted as a UUID (`:800-804`). It is content-addressed.
  - A second byte-identical file in the same import gets a random UUID so each path survives (#1951, `:3549-3588`).
  - `folderPath` is derived by `_extractFolderPathFromImport` (`:1626-1668`).
- The references become `asset://<id>.<ext-lowercased>` (`getAssetUrl`, `:640-643`).

**CLI and server** (`src/shared/import/FileSystemAssetHandler.ts`):

- **Asset roots:** `resources|images|media|files|attachments` at the top level or under `content/` (`:17,66-104`).
- **Root media by extension** (`MEDIA_EXTENSIONS`, `:28-54`). This includes root `screenshot.png`; `SYSTEM_FILES` at `:59` does not list it.
- The asset ID is the path itself, e.g. `resources/00.jpg` or `resources/<ODE-ID>/00.jpg` (`:298-301`).
- Conversion is literal string replacement, per map entry, of `{{context_path}}/<zipPath>`, `{{context_path}}/resources/<filename>` and quoted legacy `resources/<file>` (`:343-374`).
- There is no basename fallback beyond the bare-filename alias, which is only the first file with that basename (`:315-317`).

### 10.3 Structure, validation and rejection

- **Rejected with an exception:**
  - ZIP limit exceeded;
  - no `content.xml`, `contentv3.xml`, `EPUB/content.xml` or single nested package;
  - more than one nested package;
  - XML not well-formed (`@xmldom` `parsererror`).
- **Not rejected:**
  - Every other structural problem: missing `odeNavStructures` gives 0 pages and a warning (`ElpxImporter.ts:1883-1897`).
  - The ODE XML validator is **not** run on import. The CLI does not run it either.
  - Unknown iDevice types are imported as-is. A missing type falls back to `FreeTextIdevice`.
  - Invalid JSON is preserved (§9.1).
  - Missing files are reported (`missingAssets`), with the placeholders kept verbatim.
  - Parent IDs that point nowhere are dropped silently, because traversal starts from the root pages.
- **Metadata** is written only when `clearExisting` is set and `odeProperties` or stable identifiers are present (`:698-708`).

### 10.4 `ElpxImportResult`

`{pages, blocks, components, assets, theme, zipContents, missingAssets, malformedProperties}`
(`src/shared/import/interfaces.ts:120-151`).

`assets` is the size of the asset map, **not** a file count. The CLI map includes filename and
`resources/<name>` aliases.

---

## 11. Export pipeline details that matter for rewriting

- **`buildAssetExportPathMap`** (`src/shared/export/exporters/BaseExporter.ts:894-972`):
  - `exportPath` is `folderPath/filename`.
  - A missing or `unknown` filename becomes `asset-<id8><ext-from-mime>` (`:917-921,978-980`).
  - An extension is appended from the MIME type when the name has none, except `.bin` (`:922-925,987-992`). This is why `pdf-noext-iframe.elpx` exists.
  - `.srt` subtitles are renamed `.vtt` and converted (`:927-935,733-844`).
  - `folderPath` values that duplicate the filename are repaired (`:937-944`).
  - **Case-insensitive collisions** get `_1`, `_2`, … inserted before the extension (`:948-961`).
- **`preprocessPagesForExport`** deep-clones the pages, then rewrites `component.content` and the stringified `properties` (`:1096-1131`).
- **Every exporter** writes assets once, at `content/resources/<exportPath>` (`:643-675`).

---

## 12. XML validation (`src/services/xml/ode-xml-validator.ts`)

`validateXml(xml)` (`src/services/xml/xml-parser.ts:134-137`) parses with `fast-xml-parser` 5
(`ignoreAttributes:false`, `attributeNamePrefix:'@_'`, `cdataPropName:'__cdata'`, `trimValues:true`,
`parseTagValue:true`; `:37-49`), then calls `validateOdeXml`:

- **Legacy roots are valid:** a root of `exe_document` or `instance` returns `valid:true` with no checks (`:51-55`).
- **Errors (these make `valid:false`):**
  - `INVALID_STRUCTURE`, `MISSING_ROOT`, `MISSING_NAV_STRUCTURES`;
  - `INVALID_KEY_VALUE`, `MISSING_KEY`, `MISSING_VALUE`, for every `userPreference`, `odeResource` and `odeProperty` (`:188-220`);
  - `INVALID_NAV_STRUCTURES`, `INVALID_NAV_STRUCTURE`, `MISSING_PAGE_ID`, `MISSING_PAGE_NAME`, `MISSING_NAV_ORDER`;
  - `INVALID_PAG_STRUCTURE`, `MISSING_BLOCK_PAGE_ID`, `MISSING_BLOCK_ID`, `MISSING_PAG_ORDER`;
  - `INVALID_COMPONENT`, `MISSING_COMP_PAGE_ID`, `MISSING_COMP_BLOCK_ID`, `MISSING_IDEVICE_ID`, `MISSING_IDEVICE_TYPE`, `MISSING_COMP_ORDER`.
- **Warnings:** `INVALID_NAMESPACE` (only when `xmlns` is present and wrong), `INVALID_VERSION`, `MISSING_PARENT_PAGE_ID`, `MISSING_BLOCK_NAME`, `NO_CONTENT` (neither `htmlView` nor `jsonProperties`, `:506-513`).
- **Not checked:** DOCTYPE, element order, ID format, uniqueness, referential integrity, asset presence, HTML, JSON validity.
- The v3.0-era bare `<ode>` passes.
- `fast-xml-parser.parse()` does not validate well-formedness strictly. Use `@xmldom` or `xmllint` for that.
- `ElpxExporter` runs `validateXml` on what it generates and aborts on errors (`ElpxExporter.ts:368-377`).
- The stricter XSD (`public/app/schemas/ode/ode-content.xsd`) is shipped for CI and `xmllint` only. **Current exports fail its ID pattern check** unless IDs follow `[0-9]{14}[A-Z0-9]{6}|page-[a-z0-9-]+|[a-zA-Z0-9_-]+`, per `doc/elpx-format/validation.md:34-35`; that document was not verified against the XSD file itself.

**Optimizer rule:** after editing `content.xml`, require:

- well-formedness with `@xmldom/xmldom` or `libxml2`;
- `validateXml(...).valid` with no *new* errors or warnings compared with the input;
- ideally `xmllint --dtdvalid content.dtd`, for inputs that had a DOCTYPE.

---

## 13. Image optimizer (Pixo)

| Fact | Value / citation |
|---|---|
| Library | **pixo**, a Rust image *encoder* compiled to WASM with wasm-bindgen 0.2.106 (string found in `pixo_bg.wasm`). Upstream repo `https://github.com/leerob/pixo`, crate `pixo` on crates.io (latest 0.4.1, 2025-12-28). **The npm package named `pixo` (c8r/pixo, v1.1.2) is unrelated.** |
| Vendored files | `public/libs/pixo/{pixo.js, pixo_bg.wasm (193 236 B), pixo.d.ts, LICENSE}`, added in `6af7fa43` (#933, 2026-01-13). No version is recorded. It was built locally; cargo paths in the WASM point to a developer machine. The crate version is **unknown**, probably 0.4.x. sha256: wasm `f2c6c9be…5ba37`, js `38e0a1e7…c1c`. |
| License | MIT, "Copyright (c) Lee Robinson" (`public/libs/pixo/LICENSE`). Not listed in `THIRD-PARTY-NOTICES.md`. |
| API | `encodeJpeg(data, w, h, color_type(0 Gray, 2 RGB), quality 1-100, preset 0 fast / 1 balanced / 2 max, subsampling_420)`; `encodePng(data, w, h, color_type 0-3, preset, lossy)`, where `lossy` quantizes to 256 colours; `resizeImage(data, sw, sh, dw, dh, color_type, algorithm 0 nearest / 1 bilinear / 2 lanczos3)`; `bytesPerPixel`; `default` async init; `initSync`. **No decoder.** |
| Loading | `ImageOptimizerManager.initWorker()` builds the worker URL `${basePath}/app/workarea/utils/ImageOptimizerWorker.js` (`public/app/workarea/utils/ImageOptimizerManager.js:121-171`). The worker `import()`s `../../../libs/pixo/pixo.js` and initialises it with `../../../libs/pixo/pixo_bg.wasm` (`public/app/workarea/utils/ImageOptimizerWorker.js:130-153`). |
| Decoding | `createImageBitmap(blob)`, then `OffscreenCanvas.getContext('2d').drawImage`, then `getImageData` for RGBA (`ImageOptimizerWorker.js:160-179`). This is browser-only. It implies default EXIF orientation handling and colour-space conversion, and **all metadata (EXIF, ICC, text chunks, animation) is lost**. |
| Encoding decision | Any pixel with alpha < 255 → **PNG** RGBA (`encodePng(…, 3, preset, lossy)`). Otherwise → **JPEG** RGB, 4:2:0 (`:190-206`). **A PNG without transparency becomes JPEG.** |
| Presets | `light` {pixo 0, q90, lossless}, `medium` {pixo 1, q85, lossless} (the default), `strong` {pixo 2, q75, lossy PNG} (`ImageOptimizerWorker.js:18-22`). The manager maps to q 0.90/0.85/0.75 (`ImageOptimizerManager.js:18-22`). |
| Scope | Only assets with MIME `image/png`, `image/jpeg` or `image/jpg` (`modalImageOptimizer.js:302-305`). No GIF, SVG, WebP or BMP. No resizing: `resizeImage` is never called. |
| Applying results | `replaceOptimizedAssets` (`public/app/workarea/modals/modals/pages/modalImageOptimizer.js:1052-1124`) replaces the blob in place (same asset UUID), sets `mime` to the output format, and **renames `.png` to `.jpg` in metadata when the output is JPEG** (`:1070-1075`). This is safe *inside the editor*: content references `asset://<uuid>`, and exports derive paths from metadata. Rows whose *estimate* saves less than 1 % are made unselectable (`ALREADY_OPTIMIZED_MIN_SAVINGS_PERCENT = 1`, `:53,602-616`). Selected items are replaced after optimization without re-checking the final size (`:998-1012`). |
| Compatibility with our goal (format- and extension-preserving rewrite of a static `.elpx`) | **Not directly compatible.** Upstream's PNG → JPEG conversion changes the extension, which in a package means rewriting every reference (content.xml, HTML, `search_index.js`, manifest, DataGame anchors and JSON, interactive-video JSON). To reuse Pixo safely we would need to force PNG → PNG and JPEG → JPEG, supply our own decoder (no `createImageBitmap` in Bun or Node), keep the original when the output is not smaller, and handle metadata (orientation) deliberately. Pixo itself is reusable under MIT via `initSync(wasmBytes)`; its encoders are pure functions over raw pixels. |

---

## 14. Reusability of upstream modules

| Module | Runtime dependencies | Reusable headlessly? |
|---|---|---|
| `src/shared/import/ElpxImporter.ts` + `FileSystemAssetHandler.ts` + `LegacyXmlParser.ts` | `yjs` (**one** instance shared with the caller), `fflate` 0.8.3 (MIT; transitive, not in upstream `package.json`), `@xmldom/xmldom` ^0.9.12, Node `fs` and `path`, `process.env` (`defaultLogger`) | **Yes.** Proven in the harness (§17). Asset semantics differ from the browser (§10.2). |
| `BrowserAssetHandler` / `AssetManager.js` | `window`, `window.Y`, Cache API, IndexedDB, `crypto.subtle`, `window.eXeLearning` | **No.** `AssetManager.js` is ~6000 lines of browser-global code. A faithful browser-parity check needs Playwright against the static build. |
| `importPolicy.ts`, `unresolvedAssetRefs.ts` | none | **Yes.** Pure functions; copying them (AGPL) or re-implementing them is trivial. |
| Export: `ElpxExporter` / `Html5Exporter` + `YjsDocumentAdapter(ServerYjsDocumentWrapper)` + `FileSystemResourceProvider(publicDir, extractDir)` + `FileSystemAssetProvider` + `FflateZipProvider` | the upstream `public/` tree (themes, libs, iDevices), `idevice-config` base path (`setIdevicesBasePath`), `jsdom` (only for the LaTeX and Mermaid pre-render hooks) | **Yes**, from a clone. The CLI does exactly this (`src/cli/commands/elp-export.ts:181-277`). Output is a *re-render with the current runtime*, so it is not byte-comparable to the input. |
| `validateXml` / `validateOdeXml` | `fast-xml-parser` ^5.11.1 | **Yes.** |
| Browser bundles (`scripts/build-importers-bundle.js`, `scripts/build-exporters-bundle.js`) | esbuild IIFE builds of `src/shared/import/browser/index.ts` and `src/shared/export/browser/index.ts`. `yjs` is shimmed to `window.Y`. `idevice-config`, `xml-parser` and `translation` are aliased to browser shims. Output: `public/app/yjs/{importers,exporters}.bundle.js`. | Only inside a browser page. |
| `scripts/flatten-elpx.ts` | `fflate`, Node | Usable as a reference only; its gaps are listed in §16. |
| DataGame `encrypt`/`decrypt` | none | Trivial to re-implement (§9.2). |

---

## 15. Licensing

- **eXeLearning:** AGPL-3.0-or-later. Copying or adapting upstream code (the regexes, `importPolicy`, the DTD text, which carries "License: AGPL-3.0" in its header) makes our tool a derivative work. `elpx-optimizer` is itself AGPL-3.0 (repo `LICENSE`), so this is compatible. Keep attribution.
- **Fixtures** in `test/fixtures/upstream/` are covered by the upstream repository license; no per-file license exists.
- **`exe_elpx_download.js`** says in its header: "Released under Attribution-ShareAlike 4.0 International License" (CC BY-SA 4.0). This is a per-file notice inside the AGPL repository; treat the file as dual-marked.
- **Pixo:** MIT (Lee Robinson). **fflate:** MIT. **@xmldom/xmldom:** MIT. **fast-xml-parser:** MIT. **yjs:** MIT. The last four were checked in `node_modules` metadata or are well known; only fflate was checked explicitly.

---

## 16. Documentation vs. code discrepancies

| # | Doc claim | Code / evidence |
|---|---|---|
| D1 | New exports use the short form `{{context_path}}/<folderPath>/<file>`; the long form is "older" (`assets.md:29-43`, `elpx-format.md:33`, `validation.md:193-196`). | The writer emits only the **long** form `{{context_path}}/content/resources/<exportPath>` (`BaseExporter.ts:1018`). Verified by re-exporting. Short-form files are flatten-elpx output. |
| D2 | `screenshot.png` is "always present" and "required" in v4. | Conditional (§7). Importer accepts its absence and does not validate PNG bytes. Minimal fixtures lack it. |
| D3 | Pattern 2 is `encodeURIComponent(JSON)` (`patterns.md:91-155`, `ai-generation.md:129,215`). | Payloads are plain JSON or `escape()` + XOR 146 (§9.2). No fixture contains a URI-encoded DataGame. |
| D4 | Pattern 3's modern form is `<script type="application/json">` from "v3.x exports"; the div form is "older". | The current editor writes the script form. **Every** fixture, v4 included, has the div form. The editor reads both. |
| D5 | `patterns.md` states that CDATA is always used, but its XML examples show entity-escaped `htmlView`. | Entity escaping is the v3.0-era form. v4 always uses CDATA. |
| D6 | All page IDs are regenerated on every import (`import-pipeline.md:117-131`). | IDs are preserved unless they collide (merge imports only) (`ElpxImporter.ts:1340-1351`). |
| D7 | Reject `content/resources/<ODE-ID>/…` (`validation.md:161-168`); "What you will not see in a v4 archive" (`assets.md:139-141`). | The importer accepts these, and the browser keeps `<ODE-ID>` as a folder that re-exports as-is. v4 fixtures still reference such folders (dangling). |
| D8 | `ai-generation.md` rule 7: a `rubric` needs URI-encoded JSON in `htmlView`. | `patterns.md:284` classifies `rubric` as htmlView-only. The code agrees with `patterns.md`. |
| D9 | The manifest is generated from the `Html5Exporter` file list (`libraries.md:116-128`). | ELPX builds it from `zip.getFilePaths()` last, including `content.xml`, `content.dtd`, `screenshot.png` and a self-reference, since v4.0.3. Older packages differ (§6.5). |
| D10 | `flatten-elpx.ts` "rewrites every reference". | Only `content.xml`, `index.html` and `html/*.html`. Not `libs/elpx-manifest.js`, `search_index.js`, XOR DataGame payloads, or `encodeURIComponent` variants of `{{context_path}}/<ODE-ID>/`. Evidence: stale manifest and `search_index.js` in `un-contenido…elpx`. |
| D11 | The exporter sanitises asset filenames (`assets.md:194`). | Nothing found in `buildAssetExportPathMap` or `AssetManager` (searched). |
| D12 | "Compression handled by JSZip" (`container.md:159-163`); AGENTS §7.5: "JSZip for extraction, Archiver for creation". | fflate for both. Per-extension STORE/DEFLATE (§3). |
| D13 | `exe_version` is the constant `"3.0"` (`elpx-format.md:36`). | `normalizeExeVersion(meta.exelearningVersion)` (`OdeXmlGenerator.ts:65,132-135`). The CLI writes an empty value. Fixtures say `3.0` or `4.0`. |
| D14 | (undocumented) | `pp_screenshot` base64 leak and `pp_modified` in `odeProperties` (§4.2). |
| D15 | Many line citations in `doc/elpx-format/*.md`. | Stale. For example `addFilenamesToAssetUrls` is at `BaseExporter.ts:1007`, not `:647`; `addAssetsToZipWithResourcePath` at `:643`, not `:429`; CDATA is emitted at `OdeXmlGenerator.ts:301/311`, not `:270/275`; `extractScreenshotFromZip` is at `ElpxImporter.ts:1203`, not `:866`. |
| D16 | "the importer validates via `decodeScreenshotToBuffer()`" (`validation.md:200-203`). | That is an **exporter** function. The importer does not validate. |
| D17 | `container.md` says `custom/` is written when `pp_customStyles` is set. | No writer found at the pinned SHA. |

### 16.1 Upstream bugs found

These are relevant to a compatibility harness:

1. **Swallowed backslash on export.** `BaseExporter.addFilenamesToAssetUrls` applies `/asset:\/\/([^"'\s]+)/g` to `JSON.stringify(properties)` (`:1039`) and captures the `\` of `\"`. With filename-style IDs (CLI importer) the output is `{{context_path}}/content/resources/resources/00.jpg\`. On re-import this is reported as missing, and it corrupts HTML stored inside JSON (e.g. `textTextarea`). UUID IDs (browser) take the clean path at `:1014`. Found by the harness: 60 diffs on the Manual, 3 on `un-contenido`.
2. **Swallowed backslash on import.** The browser `contextPathRegex` (`AssetManager.js:3758`) does not stop at `\`. A replacement inside JSON text embedded in `htmlView` drops the escaping backslash. From code reading; not reproduced.
3. **Accumulating screenshot.** CLI round trips add `content/resources/screenshot.png` on every pass (`FileSystemAssetHandler.ts:59,106-127`).
4. **Dropped XML assets.** The browser import silently drops user assets ending in `.xml`, `.xsd` or `.data` (`AssetManager.js:3459-3461`).

---

## 17. Compatibility harness (feasibility, verified)

**Upstream CLI.** It needs no build step when run from source:

```sh
cd .cache/upstream/exelearning        # publicDir = cwd/public, or set PUBLIC_DIR=/abs/path/to/public
bun install                            # ~5 s, 725 packages, no postinstall
bun run src/cli/index.ts elp:export <in.elpx|.elp> <out> elpx      # formats: html5 html5-sp scorm12 scorm2004 ims epub3 elpx
bun run src/cli/index.ts elp:convert <in.elp> <out.elpx>
make export-elpx FORMAT=elpx INPUT=… OUTPUT=…                   # Makefile:382-392
```

- `bun run cli` and the `export-*` package scripts use `dist/cli.js` and therefore need `bun run build`.
- `elp:export` flags: `--format/-f`, `--theme/-t`, `--base-url/-b`, `--debug/-d`, `--help`. An input of `-` reads stdin. `elp:convert` supports only `--debug`.
- Neither command validates its input. `ElpxExporter` validates the XML it generates.
- The CLI passes no `generateScreenshot` hook.
- Timing: re-exporting `download-elpx-link.elpx` to ELPX took about 1.2 s wall (114 files, 1.15 MB). The output contained `content/resources/screenshot.png` (bug 3) and `pp_screenshot` in `content.xml`.

**Harness prototype.** `.cache/harness/roundtrip.ts`, with `node_modules` symlinked to upstream's so that `yjs` is a single instance:

```sh
cd .cache/harness
bun roundtrip.ts ORIGINAL.elpx [OPTIMIZED.elpx] [--export=elpx,html5] [--out=DIR] --report=out/r.json
```

What it does:

- Dynamically imports `src/shared/import/index.ts`, `src/shared/export/index.ts` and `src/services/xml/xml-parser.ts` from the clone.
- Calls `setIdevicesBasePath(<clone>/public/files/perm/idevices/base)`; otherwise `idevice-config` resolves against `process.cwd()`.
- For each input:
  1. `inspectZipArchive`;
  2. `validateXml`;
  3. `new ElpxImporter(new Y.Doc(), new FileSystemAssetHandler(tmp), quietLogger).importFromBuffer()`;
  4. builds a normalised model through `YjsDocumentAdapter.getNavigation()`: pages → blocks → components with `id`, `type`, `order`, `content`, `properties` and `structureProperties`;
  5. records `missingAssets` and `malformedProperties`;
  6. sha256 of every extracted file;
  7. checks that every `asset://` reference resolves.
- With two inputs it diffs structure, metadata and extracted bytes. `--export` re-exports, then re-imports the result.
- Normalisation: ignores `createdAt`/`modified`, and compares `"true"`/`"false"` as booleans.
- Upstream logs go to stdout, so use `--report`.
- Exit status is 1 on invalid XML or any structural diff.

Results:

- **Clean imports:** `un-contenido…elpx` (14 pages, 13 components, 0 missing, 0 malformed, about 0.9 s total) and every copied fixture imported cleanly.
- **Large fixtures:** `todos-los-idevices_dos_informes.elpx` (23.7 MB, 51 pages) imported in 781 ms and re-exported with 0 structural diffs.
- **Simulated optimizations of `un-contenido`:**
  - Re-zipping with `zip -9`: 0 diffs.
  - `00.jpg` recompressed to quality 40: 0 structural diffs; only `changedBytes:[content/resources/00.jpg]`.
  - Deleting `sq01.jpg`: upstream reports `missingAssets:[{componentId:'20251009090601ROYVYO', ideviceType:'text', paths:['sq01.jpg']}]`.

**Recommendation.** Use the upstream importer for an **import-level differential**: original
versus optimized, comparing structure, content strings after asset conversion, and
`missingAssets`/`malformedProperties`. Treat re-export only as a smoke test, i.e. the export
succeeds and `validateXml` passes. When comparing re-exports, filter the effects of bugs 1 and 3.

For browser parity (content-addressed IDs, basename fallback, `.xml` skipping), the only faithful
option is Playwright driving the static build; that was not attempted.

---

## 18. Fixtures copied

See `test/fixtures/upstream/PROVENANCE.md` for sha256, sizes, paths and license. Twelve files,
7.5 MB, all from `test/fixtures/` at the pinned SHA:

- **v4:** `un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx` (screenshot, dtd, stale manifest, interactive-video, download-source-file), `download-elpx-link.elpx` (manual `exe-package:elp` link plus manifest), `pdf-noext-iframe.elpx` (long form, extensionless asset).
- **Minimal v4:** `missing-asset-refs.elpx` (XOR DataGame + link anchors to missing files), `stale-text-template-refs.elpx`, `damaged-trueorfalse-json.elpx`.
- **v3.0-era:** `Un contenido de ejemplo para probar estilos y catalogación.elpx` (source-only, entity-escaped, ODE-ID folders, `custom/`, non-ASCII name with spaces), `encoding_test.elp` (a v3.0 package despite `.elp`).
- **Web export:** `download-elpx-link.zip`.
- **Legacy:** `verdaderofalso.elp`, `old_tema-10-ejemplo.elp`, `old_epvelp_udl.elp` (has `index.html` at the root).

**Gaps:**

- No small v4 fixture with plain-JSON DataGame assets. Map, flipcards and dragdrop exist only in the 23–31 MB packages.
- No local interactive video.
- No filenames with spaces, `%`, `&`, `#` or non-ASCII characters in `content/resources/`.
- No `pp_screenshot` example.

Consider synthesising these fixtures by editing a copied package.

---

## 19. Implications for `elpx-optimizer`

1. **Detection.** Detect by content, never by extension. Classify as v4, v3.0-era or legacy using §2. Refuse legacy or treat it as detection-only. Accept v3.0-era `.elp`.
2. **Every place that references a resource** must be updated consistently:
   - `content.xml`: `htmlView` text, `jsonProperties` strings (JSON-escaped), plain-JSON DataGame bodies, the embedded interactive-video JSON, `*-Link*` anchors, and optionally XOR payloads;
   - `index.html` and `html/*.html`, where paths are relative to the page;
   - `search_index.js`;
   - `libs/elpx-manifest.js`;
   - within all of these, every reference form in §8.1.
3. **Prefer format- and extension-preserving recompression.** It makes every reference rewrite unnecessary. Pixo's default behaviour (PNG → JPEG) is not preserving.
4. **"Unused" means unreferenced by any form**, including basename-only matches, which upstream resolves leniently. Files outside `content/resources/` (theme, libs, idevices) are runtime files, not project assets.
5. **Keep `screenshot.png` a valid PNG.** Consider dropping the `pp_screenshot` duplicate from `content.xml`: the importer ignores it. This is a semantic change to the metadata, so make it opt-in.
6. **Keep outputs within the conservative ZIP limits** (200 MiB per entry, 500 MiB total, 10 000 entries). STORE already-compressed media; DEFLATE text.
7. **Preserve bytes of everything not deliberately changed.** Keep CDATA vs. entity-escaped style, do not re-serialise XML, and keep malformed JSON as it is.

---

## 20. Open questions and unverified points

- **Pixo crate version.** Unknown, probably 0.4.x. It could be checked by building `pixo` 0.4.1 with wasm-bindgen 0.2.106 and comparing `pixo_bg.wasm` hashes. Not done.
- **`pp_screenshot` in real browser exports.** It follows from the code and was reproduced via the CLI and a unit call. No browser-exported fixture from after 2026-04 was available to confirm it.
- **Browser import with percent-encoded or entity-bearing filenames.** Analysed from code only.
- **XSD pass or fail for current exports.** Not run.
- **`content.data` serialization format** in legacy `.elp`. Described from its magic bytes only; irrelevant to detection.
- **The `custom/` writer.** Not found; it may only exist in 3.0.x.
- **CLI with nested user folders in the short form** (`{{context_path}}/photos/x.jpg`). Code reading says it is unresolved; not tested.
