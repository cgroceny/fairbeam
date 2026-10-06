/** Versions for work that may finish after the user has opened or edited another draft. */
let sessionSequence = 0;
const sessionRealm = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** In-memory ownership identity, also usable on ordinary HTTP origins without Web Crypto. */
export const newDesignerSessionId = () => `${sessionRealm}-${++sessionSequence}`;
export class DesignerAsyncState {
  readonly sessionId: string;
  constructor(sessionId = newDesignerSessionId()) { this.sessionId = sessionId; }
  private readonly owner = Symbol();
  private disposed = false;
  private navigation = 0;
  private document = 0;
  private revision = 0;
  private preview = 0;

  startNavigation(): number { return ++this.navigation; }
  isNavigationCurrent(ticket: number): boolean { return !this.disposed && ticket === this.navigation; }
  navigationTicket() { return { sessionId: this.sessionId, owner: this.owner, navigation: this.startNavigation() }; }
  isOwnedNavigationCurrent(ticket: ReturnType<DesignerAsyncState["navigationTicket"]>): boolean {
    return ticket.owner === this.owner && ticket.sessionId === this.sessionId && this.isNavigationCurrent(ticket.navigation);
  }
  dispose(): void { this.disposed = true; this.cancelNavigation(); this.replaceDocument(); }
  cancelNavigation(): void { this.navigation++; }

  replaceDocument(): void {
    this.document++;
    this.revision++;
    this.preview++;
  }

  editDraft(): void {
    this.revision++;
    this.preview++;
  }

  invalidatePreview(): void { this.preview++; }

  ticket() {
    return { sessionId: this.sessionId, owner: this.owner, document: this.document, revision: this.revision, preview: this.preview };
  }

  isDocumentCurrent(ticket: ReturnType<DesignerAsyncState["ticket"]>): boolean {
    return !this.disposed && ticket.owner === this.owner && ticket.sessionId === this.sessionId && ticket.document === this.document;
  }

  isDraftCurrent(ticket: ReturnType<DesignerAsyncState["ticket"]>): boolean {
    return this.isDocumentCurrent(ticket) && ticket.revision === this.revision;
  }

  isPreviewCurrent(ticket: ReturnType<DesignerAsyncState["ticket"]>): boolean {
    return this.isDraftCurrent(ticket) && ticket.preview === this.preview;
  }
}
