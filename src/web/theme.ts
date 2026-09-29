/**
 * Light or dark: the scheme chosen with the header button, remembered in this
 * browser, or else the system's. Storage may be unavailable (private mode,
 * blocked site data); the page then only follows the choice until it is closed.
 */
export type Theme = 'light' | 'dark';

const KEY = 'elpx-optimizer-theme';

/** The scheme chosen by the user, if any. */
export function chosenTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Theme | undefined {
  try {
    const value = storage?.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Applies a scheme and remembers it. */
export function chooseTheme(theme: Theme, target: HTMLElement = document.documentElement, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  target.dataset['bsTheme'] = theme;
  try {
    storage?.setItem(KEY, theme);
  } catch {
    // Not remembered: the choice still applies to this page.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
