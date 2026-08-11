export function nextNavIndex(current: number, dir: "up" | "down", length: number): number {
  if (length === 0) return -1;
  if (dir === "down") return current === -1 ? 0 : (current + 1) % length;
  return current === -1 ? length - 1 : (current - 1 + length) % length;
}

export function selectionAfterDelete<T>(
  visibleItems: readonly T[],
  deletedIndex: number,
): T | undefined {
  if (deletedIndex === -1) return visibleItems[0];
  return visibleItems[deletedIndex + 1] ?? visibleItems[deletedIndex - 1];
}

export function scrollListItemIntoView(
  itemId: string,
  firstItemId: string | undefined,
  scrollElement: { scrollTop: number } | null,
  itemElement: { scrollIntoView: (options?: ScrollIntoViewOptions) => void } | undefined,
): void {
  if (itemId === firstItemId && scrollElement) {
    scrollElement.scrollTop = 0;
    return;
  }
  itemElement?.scrollIntoView({ block: "nearest" });
}
