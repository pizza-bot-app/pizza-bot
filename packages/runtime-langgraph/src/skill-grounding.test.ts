import { describe, expect, it } from "vitest";
import { GROUNDING_ARGUMENT } from "@pizza-bot/core";
import { applySkillGrounding } from "./skill-grounding.js";

function tool(name: string, properties: Record<string, unknown>) {
  return {
    name,
    description: "Send mail.",
    schema: { type: "object", properties, required: Object.keys(properties) },
  };
}

const sendMail = () => tool("outlook__send_mail", { to: { type: "string" }, body: { type: "string" } });

function groundedSchema(tools: readonly unknown[], name: string): Record<string, unknown> | undefined {
  const found = tools.find((t) => (t as { name: string }).name === name) as
    | { schema: { properties: Record<string, unknown> } }
    | undefined;
  return found?.schema.properties[GROUNDING_ARGUMENT] as Record<string, unknown> | undefined;
}

describe("applySkillGrounding", () => {
  it("augments the declared tool's schema and mirrors it as argsSchema", () => {
    const original = sendMail();
    const { tools, interruptOn } = applySkillGrounding([original], {
      outlook__send_mail: { allowedDecisions: ["approve", "edit"], verifiedArgs: ["body"] },
    });

    expect(groundedSchema(tools, "outlook__send_mail")).toBeDefined();
    const config = interruptOn!.outlook__send_mail as { argsSchema: { properties: object } };
    expect(config.argsSchema.properties).toHaveProperty(GROUNDING_ARGUMENT);
    // The shared instance every other skill sees must be untouched.
    expect(original.schema.properties).not.toHaveProperty(GROUNDING_ARGUMENT);
  });

  it("appends the citation contract to the tool description", () => {
    const { tools } = applySkillGrounding([sendMail()], {
      outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
    });
    const description = (tools[0] as { description: string }).description;
    expect(description).toContain("Send mail.");
    expect(description).toContain("Provenance contract");
    // The audit resolves a span by searching the argument, so the contract must ask for
    // the model's own wording rather than the evidence's.
    expect(description).toContain("never the evidence's wording");
    expect(description).toContain("A sentence joining facts from two");
  });

  it("never passes verifiedArgs through to the upstream config", () => {
    const { interruptOn } = applySkillGrounding([sendMail()], {
      outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
    });
    expect(interruptOn!.outlook__send_mail).not.toHaveProperty("verifiedArgs");
    expect(interruptOn!.outlook__send_mail).toMatchObject({ allowedDecisions: ["approve"] });
  });

  it("leaves tools and policy alone when no verifiedArgs are declared", () => {
    const original = sendMail();
    const { tools, interruptOn } = applySkillGrounding([original], {
      outlook__send_mail: { allowedDecisions: ["approve"] },
    });
    expect(tools[0]).toBe(original);
    expect(interruptOn!.outlook__send_mail).not.toHaveProperty("argsSchema");
  });

  it("only touches the tool the policy names", () => {
    const other = tool("cal__create_event", { title: { type: "string" } });
    const { tools } = applySkillGrounding([sendMail(), other], {
      outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
    });
    expect(groundedSchema(tools, "outlook__send_mail")).toBeDefined();
    expect(tools[1]).toBe(other);
  });

  it("skips a verifiedArg the tool does not declare", () => {
    const original = sendMail();
    const { tools, interruptOn } = applySkillGrounding([original], {
      outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["nonexistent"] },
    });
    expect(tools[0]).toBe(original);
    expect(interruptOn!.outlook__send_mail).not.toHaveProperty("argsSchema");
  });

  it("passes boolean policies through untouched", () => {
    const { interruptOn } = applySkillGrounding([sendMail()], { outlook__send_mail: true });
    expect(interruptOn!.outlook__send_mail).toBe(true);
  });

  it("names only the tools that actually carry the citation argument", () => {
    const { groundedTools } = applySkillGrounding([sendMail(), tool("outlook__archive", {})], {
      outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
      outlook__archive: { allowedDecisions: ["approve"], verifiedArgs: ["nonexistent"] },
    });
    expect(groundedTools).toEqual(["outlook__send_mail"]);
  });

  it("handles an absent policy", () => {
    const original = sendMail();
    expect(applySkillGrounding([original], undefined)).toEqual({
      tools: [original],
      interruptOn: undefined,
      groundedTools: [],
    });
  });

  /** The default description serializes every argument, citations included. */
  describe("approval description", () => {
    const describeCall = (args: Record<string, unknown>) => {
      const { interruptOn } = applySkillGrounding([sendMail()], {
        outlook__send_mail: { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
      });
      const { description } = interruptOn!.outlook__send_mail as {
        description: (call: unknown) => string;
      };
      return description({ name: "outlook__send_mail", args });
    };

    it("omits the citation argument but keeps the real ones", () => {
      const rendered = describeCall({
        body: "You qualify for a 20% credit.",
        [GROUNDING_ARGUMENT]: [{ arg: "body", text: "a 20% credit", cites: [{ evidenceId: "ev-2", lines: [1] }] }],
      });
      expect(rendered).toContain("You qualify for a 20% credit.");
      expect(rendered).not.toContain(GROUNDING_ARGUMENT);
      expect(rendered).not.toContain("ev-2");
    });

    it("survives a malformed tool call", () => {
      expect(describeCall({})).toContain("outlook__send_mail");
    });
  });
});
