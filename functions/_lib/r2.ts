import { AwsClient } from "aws4fetch";
import type { Env } from "./supabase";

export function makeR2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

// Presigns an S3-style query-signed URL for the given key + HTTP method.
export async function presignUrl(
  client: AwsClient,
  env: Env,
  key: string,
  method: "PUT" | "GET" | "DELETE",
  expiresSeconds = 600
): Promise<string> {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;
  const signed = await client.sign(
    new Request(`${endpoint}/${key}?X-Amz-Expires=${expiresSeconds}`, { method }),
    { aws: { signQuery: true } }
  );
  return signed.url;
}

// Presigns a PUT that commits the client to EXACTLY `contentLength` bytes — R2
// answers 403 for any other body length because content-length is in the signature.
//
// Two non-obvious requirements, both verified against the live bucket:
//   * `allHeaders: true` is mandatory — aws4fetch lists content-length in
//     UNSIGNABLE_HEADERS and would otherwise silently drop it from the signature.
//   * the URL must be a string, NOT a Request — a Request strips content-length as
//     a forbidden header, again silently yielding an unconstrained URL.
export async function presignPutWithLength(
  client: AwsClient,
  env: Env,
  key: string,
  contentLength: number,
  expiresSeconds = 600
): Promise<string> {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;
  const signed = await client.sign(`${endpoint}/${key}?X-Amz-Expires=${expiresSeconds}`, {
    method: "PUT",
    headers: { "content-length": String(contentLength) },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}
