export type SyncFolder = {
  sourceId: string;
  path: string;
  workspaceId: string;
};
export type SyncScope = {
  mode: "all" | "formats" | "manual";
  formats?: string[];
  memberIds?: string[];
  workspaceIds?: string[];
  folders?: SyncFolder[];
  excludedMemberIds?: string[];
  revision?: string;
};
export type SyncSelection = { workspaceIds: string[]; syncScope: SyncScope };
export type SyncFile = {
  id: string;
  workspaceId: string;
  title: string;
  format: string;
  bindings?: { sourceId: string; relativePath: string; sourceLabel: string }[];
};
export function fileInFolder(file: SyncFile, folder: SyncFolder) {
  return (file.bindings || []).some(
    (binding) =>
      binding.sourceId === folder.sourceId &&
      (!folder.path || binding.relativePath.startsWith(folder.path + "/")),
  );
}
export function syncFileSelected(value: SyncSelection, file: SyncFile) {
  const scope = value.syncScope;
  if (
    !value.workspaceIds.includes(file.workspaceId) ||
    scope.excludedMemberIds?.includes(file.id)
  )
    return false;
  return (
    scope.memberIds?.includes(file.id) ||
    scope.mode === "all" ||
    (scope.mode === "formats"
      ? !!scope.formats?.includes(file.format)
      : !!scope.memberIds?.includes(file.id) ||
        !!scope.workspaceIds?.includes(file.workspaceId) ||
        !!scope.folders?.some((folder) => fileInFolder(file, folder)))
  );
}
export function manualSyncSelection(
  value: SyncSelection,
  files: SyncFile[],
): SyncSelection {
  const scope = value.syncScope;
  return {
    workspaceIds: [...value.workspaceIds],
    syncScope:
      scope.mode === "manual"
        ? {
            ...scope,
            memberIds: (scope.memberIds || []).filter((id) =>
              files.some((f) => f.id === id),
            ),
          }
        : scope.mode === "all"
          ? {
              mode: "manual",
              workspaceIds: [...value.workspaceIds],
              memberIds: [],
            }
          : {
              mode: "manual",
              memberIds: files
                .filter((f) => syncFileSelected(value, f))
                .map((f) => f.id),
            },
  };
}
export function selectSyncFiles(
  value: SyncSelection,
  files: SyncFile[],
  checked: boolean,
): SyncSelection {
  const ids = new Set(files.map((f) => f.id));
  return {
    ...value,
    syncScope: {
      ...value.syncScope,
      memberIds: checked
        ? [...new Set([...(value.syncScope.memberIds || []), ...ids])]
        : (value.syncScope.memberIds || []).filter((id) => !ids.has(id)),
      excludedMemberIds: checked
        ? (value.syncScope.excludedMemberIds || []).filter((id) => !ids.has(id))
        : [...new Set([...(value.syncScope.excludedMemberIds || []), ...ids])],
    },
  };
}
export function selectSyncWorkspace(
  value: SyncSelection,
  workspace: string,
  files: SyncFile[],
  checked: boolean,
): SyncSelection {
  const ids = new Set(
    files.filter((f) => f.workspaceId === workspace).map((f) => f.id),
  );
  return {
    workspaceIds: [...new Set([...value.workspaceIds, workspace])],
    syncScope: {
      ...value.syncScope,
      workspaceIds: checked
        ? [...new Set([...(value.syncScope.workspaceIds || []), workspace])]
        : (value.syncScope.workspaceIds || []).filter((id) => id !== workspace),
      folders: (value.syncScope.folders || []).filter(
        (f) => f.workspaceId !== workspace,
      ),
      memberIds: (value.syncScope.memberIds || []).filter((id) => !ids.has(id)),
      excludedMemberIds: (value.syncScope.excludedMemberIds || []).filter(
        (id) => !ids.has(id),
      ),
    },
  };
}
export function selectSyncFolder(
  value: SyncSelection,
  folder: SyncFolder,
  files: SyncFile[],
): SyncSelection {
  const next = selectSyncFiles(
    value,
    files.filter((f) => fileInFolder(f, folder)),
    true,
  );
  return {
    ...next,
    workspaceIds: [...new Set([...next.workspaceIds, folder.workspaceId])],
    syncScope: {
      ...next.syncScope,
      // The folder rule covers future additions; individual exclusions remain possible.
      memberIds: (next.syncScope.memberIds || []).filter(
        (id) => !files.some((f) => f.id === id && fileInFolder(f, folder)),
      ),
      folders: [
        ...(next.syncScope.folders || []).filter(
          (f) => f.sourceId !== folder.sourceId || f.path !== folder.path,
        ),
        folder,
      ],
    },
  };
}
