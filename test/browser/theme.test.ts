import { describe, expect, it } from 'vitest';
import { chooseTheme, chosenTheme } from '../../src/web/theme.js';

/** An in-memory Storage double. */
function memory(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const failing = {
  getItem: (): never => {
    throw new Error('blocked');
  },
  setItem: (): never => {
    throw new Error('blocked');
  },
};

describe('theme', () => {
  it('reads only a valid remembered choice', () => {
    expect(chosenTheme(memory())).toBeUndefined();
    expect(chosenTheme(memory({ 'elpx-optimizer-theme': 'dark' }))).toBe('dark');
    expect(chosenTheme(memory({ 'elpx-optimizer-theme': 'light' }))).toBe('light');
    expect(chosenTheme(memory({ 'elpx-optimizer-theme': 'sepia' }))).toBeUndefined();
    expect(chosenTheme(failing)).toBeUndefined();
    expect(chosenTheme(undefined)).toBeUndefined();
  });

  it('applies and remembers a choice, and still applies it when storage is blocked', () => {
    const target = document.createElement('div');
    const storage = memory();
    chooseTheme('dark', target, storage);
    expect(target.dataset['bsTheme']).toBe('dark');
    expect(storage.data).toEqual({ 'elpx-optimizer-theme': 'dark' });
    chooseTheme('light', target, failing);
    expect(target.dataset['bsTheme']).toBe('light');
  });
});
