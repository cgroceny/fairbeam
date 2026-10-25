import { createPortProcessingSession } from "./resultSessionState.ts";
// Only Designer result presentation imports this instance. Core data readers remain pure.
export const portProcessingSession = createPortProcessingSession();
export const displayedPortResult = portProcessingSession.project;
