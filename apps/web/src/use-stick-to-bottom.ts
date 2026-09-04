import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react';

/** Keeps a live scroll region pinned to its newest content unless the user
 * scrolls upward to inspect older entries. */
export function useStickToBottom<T extends HTMLElement>(dependencies: unknown[]): {
  ref: RefObject<T | null>;
  onScroll: (event: UIEvent<T>) => void;
} {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  const onScroll = useCallback((event: UIEvent<T>) => {
    const element = event.currentTarget;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  }, []);

  useEffect(() => {
    if (!pinned.current || !ref.current) return;
    const element = ref.current;
    const stick = () => {
      if (pinned.current) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    };
    stick();
    const observer = new MutationObserver(stick);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, dependencies);

  return { ref, onScroll };
}
