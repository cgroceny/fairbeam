/** Distinguishes opens made by this preview from projects opened elsewhere in the app. */
export class PreviewIdentity {
  private generation = 0;
  private expectedOpen = 0;

  invalidate(openCount: number): number {
    this.expectedOpen = openCount;
    return ++this.generation;
  }

  isLatest(generation: number): boolean {
    return generation === this.generation;
  }

  isCurrent(generation: number, openCount: number): boolean {
    return this.isLatest(generation) && openCount === this.expectedOpen;
  }

  canOpen(openCount: number): boolean {
    return openCount === this.expectedOpen;
  }

  didOpen(openCount: number): void {
    this.expectedOpen = openCount;
  }
}
