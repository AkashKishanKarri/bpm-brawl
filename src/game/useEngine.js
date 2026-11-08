import { useSyncExternalStore } from 'react';
import * as E from './engine.js';

// re-render whenever the engine calls bump(); the selector reads live engine state
export function useEngine(select = e => e){
  useSyncExternalStore(E.subscribe, E.getVersion);
  return select({ ...E, quality: E.getQuality(), G: E.G, PK: E.PK, lib: E.library() });
}
