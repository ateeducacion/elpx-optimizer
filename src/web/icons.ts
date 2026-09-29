/**
 * Bootstrap Icons (MIT), bundled as static SVG text and turned into elements
 * with DOMParser. They are the app's own files: nothing from a project is
 * ever parsed here.
 */
import archive from 'bootstrap-icons/icons/archive.svg?raw';
import arrowLeft from 'bootstrap-icons/icons/arrow-left.svg?raw';
import arrowRepeat from 'bootstrap-icons/icons/arrow-repeat.svg?raw';
import cameraVideo from 'bootstrap-icons/icons/camera-video.svg?raw';
import checkCircleFill from 'bootstrap-icons/icons/check-circle-fill.svg?raw';
import circle from 'bootstrap-icons/icons/circle.svg?raw';
import download from 'bootstrap-icons/icons/download.svg?raw';
import eraser from 'bootstrap-icons/icons/eraser.svg?raw';
import exclamationTriangleFill from 'bootstrap-icons/icons/exclamation-triangle-fill.svg?raw';
import fileEarmark from 'bootstrap-icons/icons/file-earmark.svg?raw';
import fileEarmarkArrowUp from 'bootstrap-icons/icons/file-earmark-arrow-up.svg?raw';
import files from 'bootstrap-icons/icons/files.svg?raw';
import filetypeJson from 'bootstrap-icons/icons/filetype-json.svg?raw';
import folderSymlink from 'bootstrap-icons/icons/folder-symlink.svg?raw';
import gear from 'bootstrap-icons/icons/gear.svg?raw';
import github from 'bootstrap-icons/icons/github.svg?raw';
import image from 'bootstrap-icons/icons/image.svg?raw';
import infoCircleFill from 'bootstrap-icons/icons/info-circle-fill.svg?raw';
import musicNoteBeamed from 'bootstrap-icons/icons/music-note-beamed.svg?raw';
import pencilSquare from 'bootstrap-icons/icons/pencil-square.svg?raw';
import shieldLock from 'bootstrap-icons/icons/shield-lock.svg?raw';
import feather from 'bootstrap-icons/icons/feather.svg?raw';
import translate from 'bootstrap-icons/icons/translate.svg?raw';
import trash3 from 'bootstrap-icons/icons/trash3.svg?raw';
import xCircleFill from 'bootstrap-icons/icons/x-circle-fill.svg?raw';

const SOURCES = {
  archive,
  'arrow-left': arrowLeft,
  'arrow-repeat': arrowRepeat,
  'camera-video': cameraVideo,
  'check-circle-fill': checkCircleFill,
  circle,
  download,
  eraser,
  'exclamation-triangle-fill': exclamationTriangleFill,
  'file-earmark': fileEarmark,
  'file-earmark-arrow-up': fileEarmarkArrowUp,
  files,
  'filetype-json': filetypeJson,
  'folder-symlink': folderSymlink,
  gear,
  github,
  image,
  'info-circle-fill': infoCircleFill,
  'music-note-beamed': musicNoteBeamed,
  'pencil-square': pencilSquare,
  'shield-lock': shieldLock,
  feather,
  translate,
  trash3,
  'x-circle-fill': xCircleFill,
} as const;

export type IconName = keyof typeof SOURCES;

/** Returns a decorative icon (hidden from assistive technology). */
export function icon(name: IconName, className = ''): SVGSVGElement {
  const doc = new DOMParser().parseFromString(SOURCES[name], 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('class', `bi${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}
