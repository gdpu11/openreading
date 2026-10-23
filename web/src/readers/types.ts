import type { Anchor, Quote } from "./anchors";
export type ReaderPreferences = {
  language?: "en" | "zh";
  documentSort?: "default" | "recent" | "added" | "added-oldest" | "name";
  readingSpeed?: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  theme: string;
  pdfSpread?: boolean;
  epubSpread?: boolean;
  pdfScale: number;
  pdfRotation: number;
  epubFlow: string;
  encoding: string;
  leftWidth: number;
  rightWidth: number;
};
export type Prepared = {
  initialAnchor?: Anchor;
  version: { id: string; contentHash: string };
  workspaceDocumentId: string;
  sourceEntryId?: string;
  resourceManifestId?: string;
  leaseId?: string;
  readingState?: any;
  format: string;
  title: string;
  historical?: boolean;
  artifactId?: string;
};
export type Captured = {
  anchor: Anchor;
  artifact: { id: string; blocks: any[] };
  context: { blockId: string; quote: Quote; text: string; locator: any };
  rect: { left: number; top: number; bottom?: number; visible?: boolean };
};
export type OutlineItem = { label: string; locator: any };
export interface ReaderAdapter {
  open?: () => Promise<{ text: boolean; selection: boolean }>;
  getOutline: () => OutlineItem[];
  captureSelection: () => Promise<Captured | null>;
  clearNativeSelection: () => void;
  resolveAnchor: (
    anchor: Anchor,
  ) => Promise<{ state: string; range?: Range | null }>;
  navigateTo: (anchor: Anchor) => Promise<void>;
  renderAnnotations?: () => void;
  extractContext: (
    anchor: Anchor,
    policy: "selection" | "nearby",
  ) => Promise<any>;
  search: (term: string) => Promise<number>;
  isReady: () => boolean;
  getLocation: () => any;
  getHistory: () => any[];
  turnPage: (direction: number) => void;
  addPageNote: () => void;
  navigateLocation: (locator: any) => Promise<void>;
  sectionText: () => string;
  captureSection: () => Promise<Captured | null>;
  pageImage: () => Promise<string>;
  dispose?: () => void;
}
