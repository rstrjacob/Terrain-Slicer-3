import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import axios, { AxiosError } from 'axios';
import fs from 'fs';

const PY_PORT = 8765;

class PythonManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    const serverPath = this.resolveServerPath();
    const pythonBin = process.env.PYTHON_BIN || 'python';

    const env = { ...process.env };
    env.FL_MISSION_APP_DATA = path.join(app.getPath('userData'), 'app_data');
    env.PYTHONPATH = [serverPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

    const args = [path.join(serverPath, 'main.py'), '--host', '127.0.0.1', '--port', String(PY_PORT)];
    this.process = spawn(pythonBin, args, {
      cwd: serverPath,
      env,
      stdio: 'pipe'
    });

    this.process.stdout?.on('data', (data) => {
      console.log(`[py] ${data.toString().trim()}`);
    });
    this.process.stderr?.on('data', (data) => {
      console.error(`[py] ${data.toString().trim()}`);
    });
    this.process.on('exit', (code) => {
      console.log(`Python worker exited with code ${code}`);
      this.ready = false;
      this.process = null;
    });

    await this.waitForReady();
    await this.ensureBoundary();
  }

  private resolveServerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'server');
    }
    return path.join(__dirname, '..', '..', 'server');
  }

  private async waitForReady(): Promise<void> {
    const url = `http://127.0.0.1:${PY_PORT}/health`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await axios.get(url);
        this.ready = true;
        return;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error('Python worker failed to start');
  }

  private async ensureBoundary(): Promise<void> {
    try {
      await this.request('/boundary/cache', {});
    } catch (error) {
      console.error('Failed to ensure boundary cache', error);
    }
  }

  async request(endpoint: string, payload?: Record<string, unknown>): Promise<any> {
    if (!this.ready) {
      await this.waitForReady();
    }
    const url = `http://127.0.0.1:${PY_PORT}${endpoint}`;
    try {
      if (payload) {
        const response = await axios.post(url, payload);
        return response.data;
      }
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const data = axiosError.response.data;
        if (typeof data === 'string') {
          throw new Error(data);
        }
        throw new Error(JSON.stringify(data));
      }
      throw error;
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

const pythonManager = new PythonManager();

async function createWindow(): Promise<void> {
  const preloadPath = app.isPackaged
    ? path.join(__dirname, 'preload.js')
    : path.join(__dirname, 'preload.ts');

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
    await mainWindow.loadFile(indexPath);
  }
}

app.whenReady().then(async () => {
  try {
    await pythonManager.start();
  } catch (error) {
    dialog.showErrorBox('Python Worker Error', String(error));
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  pythonManager.stop();
});

ipcMain.handle('grid:build', async (_event, args: { cellSize: number }) => {
  return pythonManager.request('/grid/build', { cell_size: args.cellSize });
});

ipcMain.handle('mission:compile', async (_event, args) => {
  return pythonManager.request('/mission/compile', args);
});

ipcMain.handle('open-path', async (_event, filePath: string) => {
  if (!filePath) return;
  if (!fs.existsSync(filePath)) {
    throw new Error('File does not exist');
  }
  shell.showItemInFolder(filePath);
});
