const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envDir = path.join(root, 'python_env');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (fs.existsSync(envDir)) {
  fs.rmSync(envDir, { recursive: true, force: true });
}

const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
run(pythonBin, ['-m', 'venv', envDir], { cwd: root });

const pipPath = process.platform === 'win32'
  ? path.join(envDir, 'Scripts', 'pip.exe')
  : path.join(envDir, 'bin', 'pip');

run(pipPath, ['install', '--upgrade', 'pip']);
run(pipPath, ['install', '-r', path.join(root, 'server', 'requirements.txt')]);

