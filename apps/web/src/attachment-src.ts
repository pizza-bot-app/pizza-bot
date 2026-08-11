import { useEffect, useState } from "react";
import { parseAttachmentUrl } from "@pizza-bot/core";
import type { ApiClient } from "@/api-client";

export function loadAttachmentObjectUrl(
  id: string,
  client: Pick<ApiClient, "fetchAttachment">,
  onSrc: (src: string | undefined) => void,
): () => void {
  let active = true;
  let objectUrl: string | undefined;
  void client
    .fetchAttachment(id)
    .then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      onSrc(objectUrl);
    })
    .catch(() => {
      if (active) onSrc(undefined);
    });
  return () => {
    active = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

// Attachment routes require the bearer token, so fetch through the client and
// hand the view an object URL rather than pointing <img>/<a> at the raw route
// (which the browser requests without the Authorization header).
export function useAttachmentSrc(
  url: string,
  client: Pick<ApiClient, "fetchAttachment">,
): string | undefined {
  const id = parseAttachmentUrl(url);
  const [src, setSrc] = useState<string | undefined>();

  useEffect(() => {
    if (!id) return;
    return loadAttachmentObjectUrl(id, client, setSrc);
  }, [client, id, url]);

  return id ? src : url;
}
