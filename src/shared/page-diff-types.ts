export interface ContentChange {
  kind: "added" | "removed" | "changed";
  section: "title" | "headings" | "content";
  summary: string;
  before?: string;
  after?: string;
  addedItems?: string[];
  removedItems?: string[];
}

export interface PageDiff {
  url: string;
  hasChanges: boolean;
  oldSnapshot: { capturedAt: string; title: string };
  changes: ContentChange[];
  burstCount?: number;
  firstDetectedAt?: string;
  lastDetectedAt?: string;
  recentBursts?: Array<{
    detectedAt: string;
    summary: string;
  }>;
}
