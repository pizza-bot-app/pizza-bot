import { describe, expect, it } from "vitest";
import { swipeDeleteOutcome } from "./SwipeToDelete.js";

describe("swipeDeleteOutcome", () => {
  it("ignores short drags", () => {
    expect(swipeDeleteOutcome(-31)).toBe("closed");
  });

  it("reveals the delete action after a partial swipe", () => {
    expect(swipeDeleteOutcome(-32)).toBe("open");
    expect(swipeDeleteOutcome(-95)).toBe("open");
  });

  it("requests deletion after a deliberate full swipe", () => {
    expect(swipeDeleteOutcome(-96)).toBe("delete");
  });
});
