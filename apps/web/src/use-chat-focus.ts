import { useCallback, useRef } from "react";

export interface ChatFocus {
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  focusComposer: () => void;
  focusList: () => void;
}

export function useChatFocus(): ChatFocus {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  const focusList = useCallback(() => {
    listRef.current?.focus();
  }, []);

  return { composerRef, listRef, focusComposer, focusList };
}
