export interface MarkerModeState {
  active: boolean;
  everOpened: boolean;
}

export const initialMarkerMode: MarkerModeState = { active: false, everOpened: false };

/** Closing the inspector preserves automatic annotations already placed on the plot. */
export function toggleMarkerMode(state: MarkerModeState): MarkerModeState {
  return { active: !state.active, everOpened: true };
}
