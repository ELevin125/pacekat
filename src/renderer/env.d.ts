import type { PacekatApi } from '../shared/api';

declare global {
  interface Window {
    pacekat: PacekatApi;
  }
}

export {};
