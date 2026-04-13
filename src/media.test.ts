import { afterEach, describe, expect, it, vi } from "vitest";

const blobPutMock = vi.hoisted(() => vi.fn());
const blobFetchMock = vi.hoisted(() => vi.fn());
const loadLucyOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());

vi.mock("lucy-im-sdk", () => ({
  blobPut: blobPutMock,
  blobFetch: blobFetchMock,
}));

vi.mock("./outbound-media.js", () => ({
  loadLucyOutboundMediaFromUrl: loadLucyOutboundMediaFromUrlMock,
}));

import {
  cleanupBlobSession,
  downloadLucyMediaDescriptor,
  uploadLucyMediaFromSource,
} from "./media.js";
import { LUCY_MEDIA_TRANSPORT } from "./types.js";

describe("media blob session compatibility", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns the blob ref from blobPut outcomes that do not expose close()", async () => {
    blobPutMock.mockReturnValue({
      blobRef: "blob_ref_123",
      fileHash: "hash_123",
    });
    loadLucyOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      fileName: "hello.txt",
      kind: "document",
    });

    const descriptor = await uploadLucyMediaFromSource({
      eventId: "evt-1",
      mediaUrl: "https://example.com/hello.txt",
    });

    expect(descriptor).toMatchObject({
      transport: LUCY_MEDIA_TRANSPORT,
      blob_ref: "blob_ref_123",
      fileName: "hello.txt",
      contentType: "text/plain",
      kind: "document",
      size: 5,
    });
  });

  it("cleans up tracked blob sessions even when blobPut outcome has no close()", async () => {
    blobPutMock.mockReturnValue({
      blobRef: "blob_ref_456",
      fileHash: "hash_456",
    });
    loadLucyOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("payload"),
      contentType: "application/octet-stream",
      fileName: "payload.bin",
      kind: "document",
    });

    await uploadLucyMediaFromSource({
      eventId: "evt-2",
      mediaUrl: "https://example.com/payload.bin",
    });

    expect(() => cleanupBlobSession("evt-2")).not.toThrow();
    expect(() => cleanupBlobSession("evt-2")).not.toThrow();
  });

  it("downloads bytes through blobFetch", async () => {
    blobFetchMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const result = await downloadLucyMediaDescriptor({
      descriptor: {
        transport: LUCY_MEDIA_TRANSPORT,
        blob_ref: "blob_ref_download",
        kind: "document",
        contentType: "application/octet-stream",
        size: 3,
      },
    });

    expect(blobFetchMock).toHaveBeenCalledWith("blob_ref_download");
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.contentType).toBe("application/octet-stream");
  });
});
