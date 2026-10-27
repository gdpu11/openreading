import { describe, it, expect } from "vitest";
import {
  fileInFolder,
  manualSyncSelection,
  selectSyncFiles,
  selectSyncFolder,
  selectSyncWorkspace,
  syncFileSelected,
  type SyncFile,
  type SyncSelection,
} from "./selection";

const file = (
  id: string,
  path: string,
  workspaceId = "w",
  sourceId = "source",
): SyncFile => ({
  id,
  title: path,
  format: "markdown",
  workspaceId,
  bindings: [{ sourceId, relativePath: path, sourceLabel: "资料" }],
});
const a = file("a", "阅读/第一本.md"),
  b = file("b", "阅读/子目录/第二本.md"),
  outside = file("c", "阅读资料/第三本.md"),
  otherSource = file("d", "阅读/第四本.md", "w", "other"),
  otherWorkspace = file("e", "第五本.md", "other-workspace", "third");
const files = [a, b, outside, otherSource, otherWorkspace];
const empty = (): SyncSelection => ({
  workspaceIds: ["w", "other-workspace"],
  syncScope: { mode: "manual", memberIds: [] },
});
const folder = { sourceId: "source", path: "阅读", workspaceId: "w" };
const selected = (v: SyncSelection, catalog = files) =>
  catalog.filter((f) => syncFileSelected(v, f)).map((f) => f.id);

describe("desktop sync selection", () => {
  it("starts empty and matches folder boundaries, nested paths and source identity", () => {
    expect(selected(empty())).toEqual([]);
    const value = selectSyncFolder(empty(), folder, files);
    expect(selected(value)).toEqual(["a", "b"]);
    expect(fileInFolder(outside, folder)).toBe(false);
    expect(fileInFolder(otherSource, folder)).toBe(false);
    expect(
      selected(value, [...files, file("later", "阅读/后来新增.md")]),
    ).toEqual(["a", "b", "later"]);
  });
  it("can exclude and reselect one book inside a whole workspace or folder", () => {
    let value = selectSyncWorkspace(empty(), "w", files, true);
    value = selectSyncFiles(value, [a], false);
    expect(selected(value)).toEqual(["b", "c", "d"]);
    value = selectSyncFiles(value, [a], true);
    expect(selected(value)).toEqual(["a", "b", "c", "d"]);
    value = selectSyncFiles(
      selectSyncFolder(empty(), folder, files),
      [a],
      false,
    );
    expect(selected(value)).toEqual(["b"]);
  });
  it("clears a workspace without changing selections in another workspace", () => {
    let value = selectSyncFiles(empty(), [otherWorkspace], true);
    value = selectSyncFolder(value, folder, files);
    value = selectSyncWorkspace(value, "w", files, false);
    expect(selected(value)).toEqual(["e"]);
    expect(value.syncScope.folders).toEqual([]);
    value = selectSyncWorkspace(value, "w", files, true);
    expect(selected(value, [...files, file("later", "新增.md")])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "later",
    ]);
  });
  it("preserves existing grants when opening legacy all/format selections and does not grant other workspaces", () => {
    const legacy: SyncSelection = {
      workspaceIds: ["w"],
      syncScope: { mode: "all" },
    };
    expect(selected(manualSyncSelection(legacy, files))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(
      syncFileSelected(
        {
          ...empty(),
          workspaceIds: ["w"],
          syncScope: { mode: "manual", memberIds: ["e"] },
        },
        otherWorkspace,
      ),
    ).toBe(false);
    expect(
      selected(
        manualSyncSelection(
          { ...legacy, syncScope: { mode: "formats", formats: ["pdf"] } },
          files,
        ),
      ),
    ).toEqual([]);
  });
});
