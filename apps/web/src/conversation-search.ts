import type { ApiClient, SearchHit } from "@/api-client";

export interface SearchViewHit extends SearchHit {
  highlights: Array<{ text: string; highlighted: boolean }>;
}

interface ConversationSearchCallbacks {
  onHits: (hits: SearchViewHit[]) => void;
  onSearching: (searching: boolean) => void;
  onError?: (error: unknown) => void;
}

export function createConversationSearch(
  client: Pick<ApiClient, "searchMessages">,
  callbacks: ConversationSearchCallbacks,
  delayMs = 200,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  let disposed = false;

  const invalidate = () => {
    request += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    query(value: string): void {
      if (disposed) return;
      invalidate();
      if (value.trim().length === 0) {
        callbacks.onHits([]);
        callbacks.onSearching(false);
        return;
      }

      callbacks.onHits([]);
      callbacks.onSearching(true);
      const current = request;
      timer = setTimeout(() => {
        timer = undefined;
        void client
          .searchMessages(value, 30)
          .then((results) => {
            if (disposed || current !== request) return;
            callbacks.onHits(
              results.map((hit) => ({
                ...hit,
                highlights:
                  "highlights" in hit && Array.isArray(hit.highlights)
                    ? hit.highlights
                    : [{ text: hit.snippet, highlighted: false }],
              })),
            );
          })
          .catch((error) => {
            if (disposed || current !== request) return;
            callbacks.onHits([]);
            callbacks.onError?.(error);
          })
          .finally(() => {
            if (!disposed && current === request) callbacks.onSearching(false);
          });
      }, delayMs);
    },

    dispose(): void {
      disposed = true;
      invalidate();
    },
  };
}
