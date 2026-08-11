import { describe, expect, it } from "vitest";
import { initialResourceSelection, type ResourceSelection } from "./ResourceModule.js";

const items = [{ id: "first" }, { id: "second" }];
const getId = (item: { id: string }) => item.id;

describe("ResourceModule selection", () => {
  it("selects the first resource initially on desktop", () => {
    expect(initialResourceSelection(null, items, getId, false)).toEqual({
      mode: "view",
      id: "first",
    });
  });

  it("keeps an intentional mobile Back or Cancel on the list", () => {
    expect(initialResourceSelection(null, items, getId, true)).toBeNull();
  });

  it("preserves an existing selection on every viewport", () => {
    const selected: ResourceSelection = { mode: "view", id: "second" };
    expect(initialResourceSelection(selected, items, getId, false)).toBe(selected);
    expect(initialResourceSelection(selected, items, getId, true)).toBe(selected);
  });
});
