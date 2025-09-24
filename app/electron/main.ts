import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import axios, { AxiosError, isAxiosError } from 'axios';
import fs from 'fs';

const PY_HOST = process.env.PY_WORKER_HOST ?? '127.0.0.1';
const PY_PORT = Number(process.env.PY_WORKER_PORT ?? '8765');

const TRANSIENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

let quitting = false;

class PythonManager {
  private process: ChildProcessWithoutNullStreams | null = null;

  private ready = false;

  private startPromise: Promise<void> | null = null;

  private async restartWorker(): Promise<void> {
    await this.stop();
    this.startPromise = null;
    await this.start();
  }

  async start(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.spawnWorker().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async spawnWorker(): Promise<void> {
    if (this.process) {
      return;
    }
    const serverPath = this.resolveServerPath();
    const pythonBin = this.resolvePythonBinary();

    const env = { ...process.env };
    env.FL_MISSION_APP_DATA = path.join(app.getPath('userData'), 'app_data');
    env.PYTHONPATH = [serverPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    env.PYTHONUNBUFFERED = '1';

    const args = [path.join(serverPath, 'main.py'), '--host', PY_HOST, '--port', String(PY_PORT)];
    this.ready = false;
    this.process = spawn(pythonBin, args, {
      cwd: serverPath,
      env,
      stdio: 'pipe',
    });

    this.process.stdout?.on('data', (data) => {
      console.log(`[py] ${data.toString().trim()}`);
    });
    this.process.stderr?.on('data', (data) => {
      console.error(`[py] ${data.toString().trim()}`);
    });
    this.process.on('exit', (code, signal) => {
      console.log(`Python worker exited with code ${code ?? 'null'}${signal ? ` via signal ${signal}` : ''}`);
      this.ready = false;
      this.process = null;
      if (!quitting) {
        this.startPromise = null;
      }
    });

    await this.waitForReady();
    await this.ensureBoundary();
  }

  private resolvePythonBinary(): string {
    if (app.isPackaged) {
      const envRoot = path.join(process.resourcesPath, 'python_env');
      if (process.platform === 'win32') {
        return path.join(envRoot, 'Scripts', 'python.exe');
      }
      const candidate = path.join(envRoot, 'bin', 'python3');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      return path.join(envRoot, 'bin', 'python');
    }
    if (process.env.PYTHON_BIN) {
      return process.env.PYTHON_BIN;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private resolveServerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'server');
    }
    return path.join(__dirname, '..', '..', 'server');
  }

  private async waitForReady(): Promise<void> {
    const url = `http://${PY_HOST}:${PY_PORT}/health`;
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
      await this.start();
    }
    const url = `http://${PY_HOST}:${PY_PORT}${endpoint}`;
    const performRequest = async () => {
      if (payload) {
        const response = await axios.post(url, payload);
        return response.data;
      }
      const response = await axios.get(url);
      return response.data;
    };

    try {
      return await performRequest();
    } catch (error) {
      if (this.shouldAttemptRecovery(error)) {
        await this.restartWorker();
        return performRequest();
      }
      throw this.normalizeError(error);
    }
  }

  private shouldAttemptRecovery(error: unknown): boolean {
    if (!isAxiosError(error)) {
      return false;
    }
    if (error.response && error.response.status >= 500) {
      return true;
    }
    if (error.code && TRANSIENT_ERROR_CODES.has(error.code)) {
      return true;
    }
    return false;
  }

  private normalizeError(error: unknown): Error {
    if (!isAxiosError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const axiosError = error as AxiosError;
    if (axiosError.response?.data) {
      const data = axiosError.response.data;
      if (typeof data === 'string') {
        return new Error(data);
      }
      return new Error(JSON.stringify(data));
    }
    if (axiosError.code && TRANSIENT_ERROR_CODES.has(axiosError.code)) {
      return new Error('Python worker is unavailable. Please try again.');
    }
    return axiosError;
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    const proc = this.process;
    return new Promise((resolve) => {
      const cleanup = () => {
        proc.removeListener('exit', cleanup);
        this.process = null;
        this.ready = false;
        resolve();
      };
      if (proc.exitCode !== null) {
        cleanup();
        return;
      }
      proc.once('exit', cleanup);
      try {
        proc.kill();
      } catch (killError) {
        console.error('Failed to stop Python worker', killError);
        cleanup();
      }
      setTimeout(cleanup, 2000);
    });
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
  quitting = true;
  void pythonManager.stop();
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
  const stats = fs.statSync(filePath);
  if (stats.isDirectory()) {
    await shell.openPath(filePath);
    return;
  }
  shell.showItemInFolder(filePath);
});

ipcMain.handle('examples:open', async () => {
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'examples')
    : path.join(__dirname, '..', '..', 'examples');
  if (!fs.existsSync(basePath)) {
    throw new Error('Examples directory not found');
  }
  await shell.openPath(basePath);
});
