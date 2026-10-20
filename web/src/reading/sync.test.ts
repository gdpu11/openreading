import { beforeEach, afterEach, it, expect, vi } from "vitest";
vi.mock("../mobile/storage", () => ({
  cachedBlob: vi.fn(),
  storeBlob: vi.fn(),
  hash: vi.fn(),
  persistState: vi.fn(async () => {}),
}));
import { synchronize } from "../mobile/sync";
import type { MobileState } from "../mobile/storage";
const event = {
  id: "stable-reading-receipt",
  member: "book",
  startedAt: 1000000,
  endedAt: 1030000,
};
const conn = {
  origin: "https://reader.example",
  token: "a".repeat(64),
  name: "phone",
  deviceId: "device",
};
let current: MobileState,
  receipts: Map<string, any>,
  posts: string[],
  failSnapshot: boolean,
  duringPost: (() => void) | undefined,
  supported: boolean;
beforeEach(() => {
  current = {
    library: { workspaces: [], readingData: { events: [], goalMinutes: 30 } },
    outbox: [],
    drafts: {},
    readingEvents: [{ ...event }],
  };
  receipts = new Map();
  posts = [];
  failSnapshot = false;
  duringPost = undefined;
  supported = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: any) => {
      if (url.endsWith("/sync/library"))
        return Response.json({
          workspaces: [
            {
              id: "workspace",
              name: "阅读",
              documents: [
                { id: "book", versions: [], threads: [], manifests: [] },
              ],
            },
          ],
          ...(supported
            ? {
                readingData: {
                  events: [...receipts.values()],
                  goalMinutes: 30,
                },
              }
            : {}),
        });
      if (url.endsWith("/sync/reading/events")) {
        const body = JSON.parse(opts.body);
        for (const e of body.events) {
          posts.push(e.id);
          receipts.set(e.id, e);
        }
        duringPost?.();
        return Response.json({ ok: true });
      }
      if (url.endsWith("/sync/reading")) {
        if (failSnapshot)
          throw new TypeError("connection interrupted after acknowledgement");
        return Response.json({
          events: [...receipts.values()],
          goalMinutes: 30,
        });
      }
      throw Error("Unexpected endpoint " + url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it("keeps offline intervals until both upload acknowledgement and the replacement snapshot are durable", async () => {
  failSnapshot = true;
  await expect(synchronize(conn, current, () => {})).rejects.toThrow();
  expect(current.readingEvents).toEqual([event]);
  expect(current.library.readingData.events).toEqual([]);
  failSnapshot = false;
  await synchronize(conn, current, () => {});
  expect(posts).toEqual([event.id, event.id]);
  expect(receipts.size).toBe(1);
  expect(current.readingEvents).toEqual([]);
  expect(current.library.readingData.events).toEqual([event]);
});
it("keeps records created during an in-flight upload and does not upload outside the new authorization scope", async () => {
  const later = {
    ...event,
    id: "later-reading-receipt",
    startedAt: 1030000,
    endedAt: 1060000,
  };
  const privateEvent = {
    ...event,
    id: "private-reading-receipt",
    member: "not-authorized",
  };
  current.readingEvents!.push(privateEvent);
  duringPost = () => {
    current.readingEvents!.push(later);
    duringPost = undefined;
  };
  await synchronize(conn, current, () => {});
  expect(posts).toEqual([event.id]);
  expect(current.readingEvents).toEqual([privateEvent, later]);
});
it("keeps book and note sync compatible with a server that does not yet support reading statistics", async () => {
  supported = false;
  await synchronize(conn, current, () => {});
  expect(posts).toEqual([]);
  expect(current.readingEvents).toEqual([event]);
  expect(current.library.workspaces).toHaveLength(1);
});
