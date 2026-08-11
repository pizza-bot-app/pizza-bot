import { describe, it, expect } from "vitest";
import { nextNavIndex, scrollListItemIntoView, selectionAfterDelete } from "./list-nav.js";

describe("nextNavIndex (conversation-list arrow nav)", () => {
  it("moves down and up within range", () => {
    expect(nextNavIndex(0, "down", 3)).toBe(1);
    expect(nextNavIndex(2, "up", 3)).toBe(1);
  });

  it("wraps at both ends", () => {
    expect(nextNavIndex(2, "down", 3)).toBe(0);
    expect(nextNavIndex(0, "up", 3)).toBe(2);
  });

  it("starts at an end when nothing is selected (index -1)", () => {
    expect(nextNavIndex(-1, "down", 3)).toBe(0);
    expect(nextNavIndex(-1, "up", 3)).toBe(2);
  });

  it("returns -1 for an empty list", () => {
    expect(nextNavIndex(-1, "down", 0)).toBe(-1);
    expect(nextNavIndex(0, "up", 0)).toBe(-1);
  });

  it("stays put in a single-item list (wraps to itself)", () => {
    expect(nextNavIndex(0, "down", 1)).toBe(0);
    expect(nextNavIndex(0, "up", 1)).toBe(0);
  });
});

describe("selectionAfterDelete", () => {
  const rows = ["first", "second", "third"];

  it("selects the next visible row when one follows the deleted row", () => {
    expect(selectionAfterDelete(rows, 1)).toBe("third");
  });

  it("selects the previous visible row when deleting the last row", () => {
    expect(selectionAfterDelete(rows, 2)).toBe("second");
  });

  it("selects the first visible row when the deleted active row was collapsed", () => {
    expect(selectionAfterDelete(rows, -1)).toBe("first");
  });

  it("returns undefined when no visible rows remain", () => {
    expect(selectionAfterDelete(["only"], 0)).toBeUndefined();
    expect(selectionAfterDelete([], -1)).toBeUndefined();
  });
});

describe("scrollListItemIntoView", () => {
  it("resets the scroll container for the first item", () => {
    const scrollElement = { scrollTop: 240 };
    let itemScrolled = false;

    scrollListItemIntoView("first", "first", scrollElement, {
      scrollIntoView: () => {
        itemScrolled = true;
      },
    });

    expect(scrollElement.scrollTop).toBe(0);
    expect(itemScrolled).toBe(false);
  });

  it("uses nearest-item scrolling for other items", () => {
    const scrollElement = { scrollTop: 240 };
    let options: ScrollIntoViewOptions | undefined;

    scrollListItemIntoView("second", "first", scrollElement, {
      scrollIntoView: (next) => {
        options = next;
      },
    });

    expect(scrollElement.scrollTop).toBe(240);
    expect(options).toEqual({ block: "nearest" });
  });
});
