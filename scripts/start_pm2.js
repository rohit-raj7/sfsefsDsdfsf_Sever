import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const configPath = path.join(backendRoot, 'ecosystem.config.cjs');
const localRuntime = process.platform === 'win32'
  ? path.join(backendRoot, 'node_modules', '.bin', 'pm2-runtime.cmd')
  : path.join(backendRoot, 'node_modules', '.bin', 'pm2-runtime');
const pm2RuntimeCmd = fs.existsSync(localRuntime) ? localRuntime : 'pm2-runtime';

const args = fs.existsSync(configPath)
  ? ['start', configPath]
  : ['start', path.join(backendRoot, 'index.js'), '--name', 'callto-backend'];

const child = spawn(pm2RuntimeCmd, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('error', (err) => {
  console.error('Failed to launch pm2-runtime:', err);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
