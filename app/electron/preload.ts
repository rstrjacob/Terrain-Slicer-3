import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  buildGrid: (cellSize: number) => ipcRenderer.invoke('grid:build', { cellSize }),
  compileMission: (payload: any) => ipcRenderer.invoke('mission:compile', payload),
  openPath: (filePath: string) => ipcRenderer.invoke('open-path', filePath)
});

export type RendererAPI = {
  buildGrid: (cellSize: number) => Promise<any>;
  compileMission: (payload: any) => Promise<any>;
  openPath: (filePath: string) => Promise<void>;
};

declare global {
  interface Window {
    api: RendererAPI;
  }
}
