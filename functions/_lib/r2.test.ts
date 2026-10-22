import { describe, it, expect, vi } from "vitest";
import { makeR2Client, presignUrl, presignPutWithLength } from "./r2";

const env = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "akid",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "wedding-photos",
} as never;

describe("r2 helper", () => {
  it("presigns a PUT URL for a key, scoped to the bucket and account", async () => {
    const client = makeR2Client(env);
    const url = await presignUrl(client, env, "evt/abc.jpg", "PUT");
    expect(url).toContain("https://acct.r2.cloudflarestorage.com/wedding-photos/evt/abc.jpg");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=");
  });

  it("presigns a GET URL with a custom expiry", async () => {
    const client = makeR2Client(env);
    const url = await presignUrl(client, env, "evt/abc.jpg", "GET", 86400);
    expect(url).toContain("X-Amz-Expires=86400");
  });

  it("presigns a DELETE URL for a key", async () => {
    const client = makeR2Client(env);
    const url = await presignUrl(client, env, "evt/abc.jpg", "DELETE", 120);
    expect(url).toContain("https://acct.r2.cloudflarestorage.com/wedding-photos/evt/abc.jpg");
    expect(url).toContain("X-Amz-Expires=120");
    expect(url).toContain("X-Amz-Signature=");
  });
});

// presignPutWithLength is what makes the upload-size cap actually enforceable: R2
// itself rejects a body whose length doesn't match what's baked into the signature.
// These tests exercise the real AwsClient.sign() (pure local cryptography, no network
// I/O) so a regression in either of the two non-obvious requirements documented on the
// function — allHeaders: true, and signing a string rather than a Request — shows up
// here instead of silently shipping an upload cap that enforces nothing.
describe("presignPutWithLength", () => {
  it("signs content-length into the URL, so a mismatched body is rejected by R2", async () => {
    const client = makeR2Client(env);
    const url = await presignPutWithLength(client, env, "evt/abc.jpg", 12345);
    const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders).toContain("content-length");
  });

  it("presigns a well-formed PUT URL for the expected bucket/key", async () => {
    const client = makeR2Client(env);
    const url = await presignPutWithLength(client, env, "evt/abc.jpg", 12345, 300);
    expect(url).toContain("https://acct.r2.cloudflarestorage.com/wedding-photos/evt/abc.jpg");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=300");
  });

  it("changes the signature when the declared length changes", async () => {
    const client = makeR2Client(env);
    const urlA = await presignPutWithLength(client, env, "evt/abc.jpg", 1000);
    const urlB = await presignPutWithLength(client, env, "evt/abc.jpg", 2000);
    const sigA = new URL(urlA).searchParams.get("X-Amz-Signature");
    const sigB = new URL(urlB).searchParams.get("X-Amz-Signature");
    expect(sigA).not.toEqual(sigB);
  });

  // Pins the string-vs-Request requirement directly at the call site. We can't rely on
  // this test environment's Request/Headers to reproduce the drop, because unlike the
  // real Cloudflare Workers runtime (workerd) — where content-length is a forbidden
  // header stripped from a Request — this environment's Fetch implementation does NOT
  // strip it, so a Request-wrapped call still signs content-length correctly here even
  // though it wouldn't in production. Asserting on the argument type passed to
  // client.sign() pins the actual requirement regardless of that environment gap.
  it("passes the URL to client.sign() as a plain string, not a Request", async () => {
    const client = makeR2Client(env);
    const signSpy = vi.spyOn(client, "sign");
    await presignPutWithLength(client, env, "evt/abc.jpg", 12345);
    expect(signSpy).toHaveBeenCalledTimes(1);
    const [firstArg] = signSpy.mock.calls[0];
    expect(typeof firstArg).toBe("string");
  });
});
