import { useSyncExternalStore } from 'react';

/**
 * Clean, reactive media query hook powered by React's useSyncExternalStore.
 * Avoids layout flash and hydration mismatch.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === 'undefined') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    () => {
      if (typeof window === 'undefined') return true;
      return window.matchMedia(query).matches;
    },
    () => true
  );
}
