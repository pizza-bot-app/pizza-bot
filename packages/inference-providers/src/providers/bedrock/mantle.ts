/** Bedrock Mantle endpoint construction and SigV4 fetch transport. */
import { Sha256 } from "@smithy/core/checksum";
import { HttpRequest, parseQueryString } from "@smithy/core/protocols";
import { SignatureV4 } from "@smithy/signature-v4";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type CredentialProvider = AwsCredentials | (() => Promise<AwsCredentials>);

export function mantleEndpoint(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

export function createSigV4Fetch(
  region: string,
  credentials: CredentialProvider,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  const signer = new SignatureV4({
    service: "bedrock",
    region,
    credentials,
    sha256: Sha256,
  });

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    delete headers.authorization;
    delete headers["x-api-key"];

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const signed = await signer.sign(new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      method: request.method,
      path: url.pathname,
      query: parseQueryString(url.search),
      headers: {
        ...headers,
        host: url.host,
      },
      ...(body ? { body } : {}),
    }));

    return fetchFn(url, {
      method: request.method,
      headers: signed.headers,
      ...(body ? { body } : {}),
      signal: request.signal,
    });
  };
}
