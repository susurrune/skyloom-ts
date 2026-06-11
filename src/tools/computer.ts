/**
 * Computer-operation tools — cross-platform OS control for Skyloom.
 *
 * Launch apps, open files/URLs, inspect and diagnose the system, manage
 * processes and services, and install/uninstall software.
 */

import { execSync, execFileSync, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolRegistry, ToolDefinition } from '../core/tool';

const MAX_OUT = 8000;

function truncate(text: string, limit = MAX_OUT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n…(truncated, ${text.length - limit} more chars)`;
}

/**
 * Register computer-operation tools into the given registry.
 */
export function registerComputerTools(registry: ToolRegistry): void {
  const platform = os.platform();

  // ── Launch App ──
  registry.register({
    name: 'launch_app',
    description: 'Launch a desktop application by name or path.',
    parameters: [
      { name: 'name', type: 'string', description: 'Application name or path', required: true },
    ],
    handler: async (params) => {
      const name = String(params.name || '').trim();
      if (!name) return 'Error: app name is required';

      try {
        if (platform === 'win32') {
          execSync(`start "" "${name}"`, { timeout: 10000 });
          return `Launched ${name}`;
        } else if (platform === 'darwin') {
          execSync(`open -a "${name.replace(/"/g, '\\"')}"`, { timeout: 10000 });
          return `Launched ${name}`;
        } else {
          // Linux - try xdg-open or direct exec
          try {
            execSync(`${name} &`, { timeout: 5000, shell: true as any });
          } catch {
            execSync(`xdg-open "${name}" 2>/dev/null || ${name}`, { timeout: 5000, shell: true as any });
          }
          return `Launched ${name}`;
        }
      } catch (e: any) {
        return `Error launching ${name}: ${e.message || e}`;
      }
    },
  });

  // ── Open Path ──
  registry.register({
    name: 'open_path',
    description: 'Open a file or folder in the default application.',
    parameters: [
      { name: 'target', type: 'string', description: 'File or folder path', required: true },
    ],
    handler: async (params) => {
      const target = String(params.target || '').trim();
      if (!target) return 'Error: target is required';
      const resolved = path.resolve(target);
      if (!fs.existsSync(resolved)) return `Error: path not found: ${resolved}`;

      try {
        if (platform === 'win32') {
          execSync(`explorer "${resolved}"`, { timeout: 5000 });
        } else if (platform === 'darwin') {
          execSync(`open "${resolved}"`, { timeout: 5000 });
        } else {
          execSync(`xdg-open "${resolved}"`, { timeout: 5000 });
        }
        return `Opened ${resolved}`;
      } catch (e: any) {
        return `Error opening ${resolved}: ${e.message || e}`;
      }
    },
  });

  // ── Browser Open ──
  registry.register({
    name: 'browser_open',
    description: 'Open a URL in the default web browser.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to open', required: true },
    ],
    handler: async (params) => {
      const url = String(params.url || '').trim();
      if (!url) return 'Error: url is required';
      try {
        if (platform === 'win32') {
          execSync(`start "" "${url}"`, { timeout: 10000 });
        } else if (platform === 'darwin') {
          execSync(`open "${url}"`, { timeout: 10000 });
        } else {
          execSync(`xdg-open "${url}"`, { timeout: 10000 });
        }
        return `Opened ${url} in browser`;
      } catch (e: any) {
        return `Error opening browser: ${e.message || e}`;
      }
    },
  });

  // ── System Info ──
  registry.register({
    name: 'system_info',
    description: 'Get system information (OS, CPU, memory, disk).',
    parameters: [],
    handler: async () => {
      const lines = [
        `OS: ${os.type()} ${os.release()}`,
        `Hostname: ${os.hostname()}`,
        `Platform: ${os.platform()} ${os.arch()}`,
        `CPUs: ${os.cpus().length} × ${os.cpus()[0]?.model || 'unknown'}`,
        `Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB total, ${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB free`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} hours`,
        `Loadavg: ${os.loadavg().map(n => n.toFixed(2)).join(', ')}`,
        `User: ${os.userInfo().username}`,
        `Home: ${os.homedir()}`,
        `Temp: ${os.tmpdir()}`,
      ];
      return lines.join('\n');
    },
  });

  // ── List Processes ──
  registry.register({
    name: 'list_processes',
    description: 'List running processes.',
    parameters: [],
    handler: async () => {
      try {
        if (platform === 'win32') {
          const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 10000 });
          return truncate(out, MAX_OUT);
        } else {
          const out = execSync('ps aux --no-headers 2>/dev/null || ps aux', { encoding: 'utf-8', timeout: 10000 });
          return truncate(out, MAX_OUT);
        }
      } catch (e: any) {
        return `Error listing processes: ${e.message || e}`;
      }
    },
  });

  // ── Kill Process ──
  registry.register({
    name: 'kill_process',
    description: 'Kill a process by PID or name.',
    parameters: [
      { name: 'target', type: 'string', description: 'PID number or process name', required: true },
    ],
    handler: async (params) => {
      const target = String(params.target || '').trim();
      if (!target) return 'Error: target is required';

      try {
        if (/^\d+$/.test(target)) {
          process.kill(parseInt(target), 'SIGTERM');
          return `Killed process ${target}`;
        } else {
          if (platform === 'win32') {
            execFileSync('taskkill', ['/F', '/IM', target, '/T'], { timeout: 10000 });
          } else {
            execFileSync('pkill', ['-f', target], { timeout: 10000 });
          }
          return `Killed process ${target}`;
        }
      } catch (e: any) {
        return `Error killing ${target}: ${e.message || e}`;
      }
    },
    dangerous: true,
  });

  // ── Package Manager ──
  registry.register({
    name: 'package_manager',
    description: 'Install, uninstall, or upgrade software packages.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: install, uninstall, upgrade, search', required: true },
      { name: 'name', type: 'string', description: 'Package name', required: true },
    ],
    handler: async (params) => {
      const action = String(params.action || '').trim().toLowerCase();
      const name = String(params.name || '').trim();
      if (!action || !name) return 'Error: action and name are required';

      // Auto-detect package manager
      let pm: string;
      const has = (cmd: string) => {
        try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; }
        catch { return false; }
      };

      if (platform === 'win32') {
        if (has('winget')) pm = 'winget';
        else if (has('scoop')) pm = 'scoop';
        else if (has('choco')) pm = 'choco';
        else return 'No package manager found (winget/scoop/choco)';
      } else if (platform === 'darwin') {
        pm = has('brew') ? 'brew' : 'No package manager found';
      } else {
        if (has('apt')) pm = 'apt';
        else if (has('dnf')) pm = 'dnf';
        else if (has('pacman')) pm = 'pacman';
        else return 'No package manager found (apt/dnf/pacman)';
      }

      const commands: Record<string, Record<string, string>> = {
        winget: { install: 'install', uninstall: 'uninstall', upgrade: 'upgrade', search: 'search' },
        scoop: { install: 'install', uninstall: 'uninstall', upgrade: 'update', search: 'search' },
        choco: { install: 'install', uninstall: 'uninstall', upgrade: 'upgrade', search: 'search' },
        brew: { install: 'install', uninstall: 'uninstall', upgrade: 'upgrade', search: 'search' },
        apt: { install: 'install -y', uninstall: 'remove -y', upgrade: 'upgrade -y', search: 'search' },
        dnf: { install: 'install -y', uninstall: 'remove -y', upgrade: 'upgrade -y', search: 'search' },
        pacman: { install: '-S --noconfirm', uninstall: '-R --noconfirm', upgrade: '-Syu --noconfirm', search: '-Ss' },
      };

      const cmdMap = commands[pm];
      if (!cmdMap || !cmdMap[action]) return `Unsupported action '${action}' for ${pm}`;

      try {
        // cmdMap entries may carry flags (e.g. 'install -y', '-S --noconfirm');
        // split them into argv so the package name stays a single argument with
        // no shell interpretation.
        const pmArgs = cmdMap[action].split(/\s+/).filter(Boolean);
        const out = execFileSync(pm, [...pmArgs, name], { encoding: 'utf-8', timeout: 120000 });
        return truncate(out, MAX_OUT);
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
    dangerous: true,
  });

  // ── Service Control ──
  registry.register({
    name: 'service_control',
    description: 'Start, stop, restart, or check status of a system service.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: start, stop, restart, status', required: true },
      { name: 'name', type: 'string', description: 'Service name', required: true },
    ],
    handler: async (params) => {
      const action = String(params.action || '').trim().toLowerCase();
      const name = String(params.name || '').trim();
      if (!action || !name) return 'Error: action and name are required';

      const allowed = ['start', 'stop', 'restart', 'status'];
      if (!allowed.includes(action)) return `Unsupported action '${action}' (use: ${allowed.join('/')})`;
      try {
        if (platform === 'win32') {
          const out = execFileSync('sc', [action, name], { encoding: 'utf-8', timeout: 30000 });
          return truncate(out, MAX_OUT);
        }
        try {
          const out = execFileSync('systemctl', [action, name], { encoding: 'utf-8', timeout: 30000 });
          return truncate(out, MAX_OUT);
        } catch {
          const out = execFileSync('service', [name, action], { encoding: 'utf-8', timeout: 30000 });
          return truncate(out, MAX_OUT);
        }
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
    dangerous: true,
  });
}
