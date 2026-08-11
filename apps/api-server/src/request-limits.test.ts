import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  limitJsonBody,
  limitMultipartBody,
  multipartRequestLimit,
} from "./request-limits.js";

describe("limitMultipartBody", () => {
  it("bounds a streamed body without relying on Content-Length", async () => {
    let parsed = false;
    const app = new Hono();
    app.post("/", limitMultipartBody(1), async (c) => {
      parsed = true;
      await c.req.arrayBuffer();
      return c.body(null, 204);
    });

    const size = multipartRequestLimit(1) + 1;
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(size));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(parsed).toBe(false);
  });
});

describe("limitJsonBody", () => {
  it("bounds streamed JSON without limiting other content types", async () => {
    const app = new Hono();
    app.use("*", limitJsonBody(4));
    app.post("/", async (c) => {
      await c.req.arrayBuffer();
      return c.body(null, 204);
    });

    const oversized = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "12345",
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "request_too_large" });

    const other = await app.request("/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "12345",
    });
    expect(other.status).toBe(204);
  });

  it("selects a larger limit for an explicitly matched route", async () => {
    const app = new Hono();
    app.use("*", limitJsonBody((_method, path) => path === "/bundle" ? 8 : 4));
    app.post("*", async (c) => {
      await c.req.arrayBuffer();
      return c.body(null, 204);
    });

    const bundle = await app.request("/bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "12345678",
    });
    expect(bundle.status).toBe(204);

    const ordinary = await app.request("/ordinary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "12345678",
    });
    expect(ordinary.status).toBe(413);
  });
});
