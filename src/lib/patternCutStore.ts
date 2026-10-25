import { createSignal } from 'solid-js';
import { cutPhi } from '../compare/store';
import type { PatternCutChoice } from './patternMetrics';

export const [patternCutMode, setPatternCutMode] = createSignal<'principal' | 'elevation' | 'conical'>('principal');
export const [cutTheta, setCutTheta] = createSignal(90);
export const [patternProjection, setPatternProjection] = createSignal<'polar' | 'cartesian'>('polar');
export const patternCutChoice = (): PatternCutChoice => patternCutMode() === 'principal' ? { kind: 'principal' }
  : { kind: patternCutMode() as 'elevation' | 'conical', angle: patternCutMode() === 'elevation' ? cutPhi() : cutTheta() };
