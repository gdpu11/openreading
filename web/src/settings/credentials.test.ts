import { afterEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: request }));
import { restoreCredentials } from "./credentials";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("optional desktop credential restoration", () => {
  it("keeps the library usable when system storage is locked", async () => {
    vi.stubGlobal("window", {
      openReadingDesktop: {
        credential: vi.fn().mockRejectedValue(Error("locked")),
      },
    });
    const providers = [
        {
          id: "a".repeat(32),
          protocol: "openai",
          baseUrl: "https://example.invalid",
          credentialBound: false,
        },
      ],
      notice = vi.fn();
    expect(await restoreCredentials(providers, notice)).toEqual(providers);
    expect(notice).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not touch stored credentials for already bound or mock providers", async () => {
    const credential = vi.fn();
    vi.stubGlobal("window", { openReadingDesktop: { credential } });
    const providers = [{ credentialBound: true }, { protocol: "mock" }];
    expect(await restoreCredentials(providers, vi.fn())).toEqual(providers);
    expect(credential).not.toHaveBeenCalled();
  });
});
