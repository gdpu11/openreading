import { beforeEach, afterEach, it, expect, vi } from "vitest";
vi.mock("../mobile/storage", () => ({
  cachedBlob: vi.fn(),
  hasBlob: vi.fn(),
  storeBlob: vi.fn(),
  hash: vi.fn(),
  persistState: vi.fn(async () => {}),
}));
import {
  synchronize,
  synchronizeReading,
  mobileReadingData,
} from "../mobile/sync";
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
  supported: boolean,
  failLibrary: boolean;
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
  failLibrary = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: any) => {
      if (url.endsWith("/sync/library")) {
        if (failLibrary) throw Error("file manifest unavailable");
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
      }
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
        if (!supported)
          return Response.json(
            { code: "NOT_FOUND", message: "old server" },
            { status: 404 },
          );
        if (failSnapshot && receipts.size)
          throw new TypeError("connection interrupted after acknowledgement");
        return Response.json({
          events: [...receipts.values()],
          goalMinutes: 30,
          memberIds: ["book"],
        });
      }
      throw Error("Unexpected endpoint " + url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it("keeps offline intervals until both upload acknowledgement and the replacement snapshot are durable", async () => {
  failSnapshot = true;
  await expect(synchronizeReading(conn, current)).rejects.toThrow();
  expect(current.readingEvents).toEqual([event]);
  expect(current.library.readingData.events).toEqual([]);
  failSnapshot = false;
  await synchronizeReading(conn, current);
  expect(posts).toEqual([event.id, event.id]);
  expect(receipts.size).toBe(1);
  expect(current.readingEvents).toEqual([]);
  expect(mobileReadingData(current).events).toEqual([event]);
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
  await synchronizeReading(conn, current);
  expect(posts).toEqual([event.id]);
  expect(current.readingEvents).toEqual([privateEvent, later]);
});
it("keeps book and note sync compatible with a server that does not yet support reading statistics", async () => {
  supported = false;
  await synchronizeReading(conn, current);
  expect(posts).toEqual([]);
  expect(current.readingEvents).toEqual([event]);
  await synchronize(conn, current, () => {});
  expect(current.library.workspaces).toHaveLength(1);
});
it("syncs desktop history and offline phone time without requesting a file manifest", async () => {
  failLibrary = true;
  const desktop = {
    ...event,
    id: "desktop-reading-receipt",
    startedAt: 900000,
    endedAt: 930000,
  };
  receipts.set(desktop.id, desktop);
  await synchronizeReading(conn, current);
  expect(current.readingEvents).toEqual([]);
  expect(mobileReadingData(current).events).toEqual([desktop, event]);
  expect(current.readingSyncedAt).toBeTruthy();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([url]) => !String(url).includes("/sync/library")),
  ).toBe(true);
  await expect(synchronize(conn, current, () => {})).rejects.toThrow();
  expect(mobileReadingData(current).events).toEqual([desktop, event]);
  await synchronizeReading(conn, current);
  expect(posts).toEqual([event.id]);
  expect(mobileReadingData(current).events).toHaveLength(2);
});
it("serializes simultaneous ledger requests and preserves local-only book history", async () => {
  current.readingData = {
    events: [
      { ...event, id: "retained-reading-receipt", member: "deselected" },
    ],
    goalMinutes: 20,
  };
  const first = synchronizeReading(conn, current);
  const second = synchronizeReading(conn, current);
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(posts).toEqual([event.id]);
  expect(mobileReadingData(current).events.map((e) => e.id)).toEqual([
    "retained-reading-receipt",
    event.id,
  ]);
  expect(mobileReadingData(current).goalMinutes).toBe(30);
});

it("updates a DHCP address only after the original computer identity and device authorization pass", async () => {
  const { reconnect } = await import("../mobile/sync");
  const old = {...conn, origin:"https://192.168.31.157:53318",certificateFingerprint:"a".repeat(64)};
  const origin = "https://172.18.149.220:53318";
  const link = (pin: string) => origin + "/mobile#connect=" + encodeURIComponent(JSON.stringify({origin,certificateFingerprint:pin}));
  const spy = vi.spyOn(await import("../mobile/lan"),"lanRequest");
  spy.mockResolvedValue(Response.json({enabled:true}));
  try {
    await expect(reconnect(old,link("b".repeat(64)))).rejects.toThrow("不属于已配对电脑");
    expect(spy).not.toHaveBeenCalled();
    const updated = await reconnect(old,link(old.certificateFingerprint));
    expect(updated).toEqual({...old,origin});
    expect(spy).toHaveBeenCalledWith(origin,old.certificateFingerprint,"/sync/status",old.token,undefined,{},25000);
    spy.mockRejectedValueOnce(Error("certificate mismatch"));
    await expect(reconnect(old,link(old.certificateFingerprint))).rejects.toThrow();
    expect(old.origin).toBe("https://192.168.31.157:53318");
  } finally {spy.mockRestore();}
});

it("keeps each verified book when a later download fails and acknowledges only after the whole library is saved", async () => {
  const download = await import("../mobile/download");
  const storage = await import("../mobile/storage");
  const cached = new Set<string>();
  vi.mocked(storage.hasBlob).mockImplementation(async (key) => cached.has(key));
  const reports: any[] = [];
  const docs = ["one", "two"].map(id => ({id,title:id,version:{id:"v-"+id},versions:[{id:"v-"+id,contentHash:id,size:10}],threads:[],manifests:[]}));
  vi.mocked(fetch).mockImplementation(async (url: any, opts: any) => {
    if (String(url).endsWith("/sync/library")) return Response.json({deviceId:"device",scopeRevision:"revision",workspaces:[{id:"ws",documents:docs}]});
    if (String(url).endsWith("/sync/progress")) {reports.push(JSON.parse(opts.body));return Response.json({ok:true});}
    throw Error("Unexpected URL");
  });
  const transfer = vi.spyOn(download,"downloadBlob").mockImplementation(async (key, _size, _get, progress) => {
    progress(5,10);
    if (key === "two") throw Error("download interrupted");
    cached.add(key);
  });
  try {
    await expect(synchronize(conn,current,()=>{})).rejects.toThrow("download interrupted");
    expect(current.library.workspaces[0].documents.map((d: any)=>d.id)).toEqual(["one"]);
    expect(reports.at(-1)).toMatchObject({phase:"failed",done:1,total:2});
    expect(reports.some(p=>p.phase==="completed")).toBe(false);
    transfer.mockImplementation(async (key,_size,_get,progress)=>{cached.add(key);progress(10,10);});
    await synchronize(conn,current,()=>{});
    expect(current.library.workspaces[0].documents).toHaveLength(2);
    expect(reports.at(-1)).toMatchObject({phase:"completed",done:2,total:2});
    expect(transfer.mock.calls.map(c=>c[0])).toEqual(["one","two","two"]);
  } finally {transfer.mockRestore();vi.mocked(storage.hasBlob).mockReset();}
});
