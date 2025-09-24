import type { RendererAPI } from '../electron/preload';

declare global {
  interface Window {
    api: RendererAPI;
  }
}

export {};
