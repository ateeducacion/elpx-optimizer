/**
 * Components bundled into the web app, shown in the licenses panel. The
 * license texts are copied into dist/web/licenses at build time
 * (vite.config.ts), so every link stays on this site.
 */
export interface Component {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** File under licenses/ with the full text. */
  readonly file: string;
  /** Interface-string key describing what it does here. */
  readonly role: string;
}

export const COMPONENTS: readonly Component[] = [
  { name: 'FFmpeg (@ffmpeg/core, @ffmpeg/core-mt)', version: '0.12.10', license: 'GPL-2.0-or-later', file: 'ffmpeg-core-GPL-2.0.txt', role: 'lic_ffmpeg' },
  { name: 'ffmpeg.wasm (@ffmpeg/ffmpeg)', version: '0.12.15', license: 'MIT', file: 'ffmpeg.wasm-MIT.txt', role: 'lic_ffmpegwasm' },
  {
    name: 'qpdf (@neslinesli93/qpdf-wasm 0.3.0)',
    version: '12.2.0',
    license: 'Apache-2.0, Zlib, IJG, BSD-3-Clause, ISC',
    file: 'qpdf-wasm-NOTICES.txt',
    role: 'lic_qpdf',
  },
  {
    name: 'jSquash (@jsquash/jpeg, png, oxipng, webp, resize)',
    version: '1.6 · 3.1 · 2.3 · 1.5 · 2.1',
    license: 'Apache-2.0',
    file: 'jsquash-Apache-2.0.txt',
    role: 'lic_jsquash',
  },
  { name: 'MozJPEG / libjpeg-turbo', version: '—', license: 'IJG, BSD-3-Clause, Zlib', file: 'mozjpeg-libjpeg-turbo.txt', role: 'lic_codec' },
  { name: 'libwebp', version: '—', license: 'BSD-3-Clause', file: 'libwebp.txt', role: 'lic_codec' },
  { name: 'OxiPNG', version: '—', license: 'MIT', file: 'oxipng.txt', role: 'lic_codec' },
  { name: 'PNG codec', version: '—', license: 'BSD-3-Clause', file: 'png-codec.txt', role: 'lic_codec' },
  { name: 'resize, hqx, magic-kernel', version: '—', license: 'MIT, Apache-2.0', file: 'resize.txt', role: 'lic_codec' },
  { name: 'Bootstrap', version: '5.3.8', license: 'MIT', file: 'bootstrap-MIT.txt', role: 'lic_ui' },
  { name: 'Bootstrap Icons', version: '1.13.1', license: 'MIT', file: 'bootstrap-icons-MIT.txt', role: 'lic_ui' },
  { name: 'Atkinson Hyperlegible', version: '5.3.0', license: 'OFL-1.1', file: 'atkinson-hyperlegible-OFL-1.1.txt', role: 'lic_font' },
  { name: 'fflate', version: '0.8.3', license: 'MIT', file: 'fflate-MIT.txt', role: 'lic_zip' },
  { name: 'parse5', version: '8.0.1', license: 'MIT', file: 'parse5-MIT.txt', role: 'lic_parse' },
  { name: 'entities', version: '8.1.0', license: 'BSD-2-Clause', file: 'entities-BSD-2-Clause.txt', role: 'lic_parse' },
  { name: '@noble/hashes', version: '2.4.0', license: 'MIT', file: 'noble-hashes-MIT.txt', role: 'lic_hash' },
  { name: 'wasm-feature-detect', version: '1.9.0', license: 'Apache-2.0', file: 'wasm-feature-detect-Apache-2.0.txt', role: 'lic_codec' },
];
