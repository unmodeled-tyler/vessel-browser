export interface ContentChange {
  kind: "added" | "removed" | "changed";
  section: "title" | "headings" | "content";
  summary: string;
}

export interface PageDiff {
  url: string;
  hasChanges: boolean;
  oldSnapshot: { capturedAt: string; title: string };
  changes: ContentChange[];
}
