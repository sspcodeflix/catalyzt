import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const systemTheme = (): Theme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

function readSaved(): Theme | null {
  try {
    const t = localStorage.getItem('hz-theme');
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

/** Follows the OS until the user picks a theme; the choice is saved per browser. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readSaved() ?? systemTheme());

  useEffect(() => {
    if (readSaved()) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('hz-theme', next);
      } catch {
        /* storage unavailable: theme still applies for this visit */
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
