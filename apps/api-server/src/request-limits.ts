import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export type JsonBodyLimit = number | ((method: string, path: string) => number);

export function multipartRequestLimit(maxFileBytes: number): number {
  return maxFileBytes + MULTIPART_OVERHEAD_BYTES;
}

export function limitMultipartBody(maxFileBytes: number) {
  return bodyLimit({
    maxSize: multipartRequestLimit(maxFileBytes),
    onError: (c) =>
      c.json(
        {
          error: "request_too_large",
          detail: "The upload exceeds the request size limit.",
        },
        413,
      ),
  });
}

export function limitJsonBody(maxBytes: JsonBodyLimit = MAX_JSON_BODY_BYTES): MiddlewareHandler {
  const limits = new Map<number, MiddlewareHandler>();
  return (c, next) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:;|$)/i.test(contentType)) {
      return next();
    }
    const requestLimit =
      typeof maxBytes === "function"
        ? maxBytes(c.req.method, c.req.path)
        : maxBytes;
    let limit = limits.get(requestLimit);
    if (!limit) {
      limit = bodyLimit({
        maxSize: requestLimit,
        onError: (context) =>
          context.json(
            {
              error: "request_too_large",
              detail: "The JSON request exceeds the request size limit.",
            },
            413,
          ),
      });
      limits.set(requestLimit, limit);
    }
    return limit(c, next);
  };
}
