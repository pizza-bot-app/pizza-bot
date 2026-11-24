import { describe, expect, it } from "vitest";
import { evaluateCondition, renderTemplate, renderValue } from "./graph-template.js";

const state = { input: { body: { n: 3, tags: ["a", "b"], who: "Ada" } }, summary: "ok" };

describe("graph templates", () => {
  it("returns the raw value for a whole-string template and text otherwise", () => {
    expect(renderTemplate("{{ input.body.tags }}", state)).toEqual(["a", "b"]);
    expect(renderTemplate("Hi {{input.body.who}}: {{input.body.tags}} {{missing.x}}", state)).toBe(
      'Hi Ada: ["a","b"] ',
    );
  });

  it("leaves an empty placeholder as text and stays linear on long runs of spaces", () => {
    expect(renderTemplate("{{  }} and {{summary}}", state)).toBe("{{  }} and ok");
    const hostile = `{{${" ".repeat(50_000)}z`;
    const started = performance.now();
    expect(renderTemplate(hostile, state)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("renders nested JSON and does not read inherited properties", () => {
    expect(renderValue({ q: "{{summary}}", list: ["{{input.body.n}}"] }, state)).toEqual({
      q: "ok",
      list: [3],
    });
    expect(renderTemplate("{{summary.constructor}}", state)).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it.each([
    [{ path: "input.body.n", op: "gt", value: 2 }, true],
    [{ path: "input.body.n", op: "lte", value: 2 }, false],
    [{ path: "input.body.n", op: "gt", value: "2" }, false],
    [{ path: "input.body.tags", op: "contains", value: "b" }, true],
    [{ path: "summary", op: "eq", value: "ok" }, true],
    [{ path: "nope", op: "exists" }, false],
    [{ path: "summary", op: "truthy" }, true],
  ] as const)("%j -> %s", (condition, expected) => {
    expect(evaluateCondition(condition, state)).toBe(expected);
  });
});
