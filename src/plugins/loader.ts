/**
 * Plugin loader — discovers external plugins and runs them through an ordered
 * hook lifecycle.
 *
 * A plugin is a directory with an `index.js` exporting either:
 *   - activate(ctx): the lifecycle form. `ctx` scopes every registration to the
 *     plugin (registerTool / on(hook, fn)), so unload(name) cleanly removes
 *     exactly what the plugin added.
 *   - register(registry): the legacy form. Still supported — tools it adds are
 *     diffed against the registry so they're tracked for unload too.
 *
 * Hooks fire in registration order. Core hooks: `init` (after all plugins
 * load), `tool.register` (a tool was added), `provider.update` (model/provider
 * config changed). Plugins may define and emit their own hook names.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry, type ToolDefinition } from '../core/tool';
import { getLogger } from '../core/logger';

const log = getLogger('plugin-loader');

export type PluginHook = 'init' | 'tool.register' | 'provider.update' | string;
export type HookHandler = (payload?: any) => void | Promise<void>;

/** Scoped API handed to a plugin's activate(); every call is tracked for unload. */
export interface PluginContext {
  readonly name: string;
  readonly config: any;
  readonly log: ReturnType<typeof getLogger>;
  registerTool(def: ToolDefinition): void;
  on(hook: PluginHook, handler: HookHandler): void;
}

export interface Plugin {
  name?: string;
  activate?(ctx: PluginContext): void | Promise<void>;
  register?(registry: ToolRegistry): void; // legacy
  deactivate?(): void | Promise<void>;
}

interface LoadedPlugin {
  name: string;
  module: Plugin;
  tools: string[];
  hooks: Array<{ hook: string; fn: HookHandler }>;
}

/**
 * A plugin path is safe to `require` only if neither it nor (on POSIX) its
 * permissions allow group/world write — otherwise a less-privileged user could
 * drop code that runs in this process. Always safe on Windows (no POSIX bits);
 * SKYLOOM_ALLOW_UNSAFE_PLUGINS=1 bypasses the check.
 */
export function isSafePluginPath(target: string): boolean {
  if (process.env.SKYLOOM_ALLOW_UNSAFE_PLUGINS === '1') return true;
  if (process.platform === 'win32') return true;
  try {
    const mode = fs.statSync(target).mode;
    return (mode & 0o022) === 0; // no group-write, no world-write
  } catch {
    return false;
  }
}

export class PluginLoader {
  private toolRegistry: ToolRegistry;
  private config: any;
  private plugins = new Map<string, LoadedPlugin>();
  /** hook name -> handlers in registration order, each tagged with its plugin. */
  private hookHandlers = new Map<string, Array<{ plugin: string; fn: HookHandler }>>();

  constructor(toolRegistry: ToolRegistry, config?: any) {
    this.toolRegistry = toolRegistry;
    this.config = config ?? {};
  }

  /** Load plugins from specified directories. Returns the number activated. */
  loadFromDirectories(directories: string[]): number {
    let total = 0;
    for (const dir of directories) {
      total += this.loadDirectory(dir);
    }
    return total;
  }

  private loadDirectory(dir: string): number {
    if (!fs.existsSync(dir)) {
      log.debug('plugin_dir_not_found', { dir });
      return 0;
    }

    let count = 0;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const pluginPath = path.join(dir, entry);
        try { if (!fs.statSync(pluginPath).isDirectory()) continue; } catch { continue; }

        const pluginFile = path.join(pluginPath, 'index.js');
        if (!fs.existsSync(pluginFile)) continue;

        // Refuse to execute code from a group/world-writable plugin file or its
        // directory — anyone who can write there would get arbitrary code
        // execution in this process. Opt out with SKYLOOM_ALLOW_UNSAFE_PLUGINS=1.
        if (!isSafePluginPath(pluginPath) || !isSafePluginPath(pluginFile)) {
          log.warn('plugin_skipped_unsafe_perms', { name: entry });
          continue;
        }

        try {
          const mod = require(pluginFile) as Plugin;
          if (this.activatePlugin(entry, mod)) count++;
        } catch (e) {
          log.warn('plugin_load_failed', { name: entry, error: String(e) });
        }
      }
    } catch (e) {
      log.warn('plugin_dir_scan_failed', { dir, error: String(e) });
    }

    return count;
  }

  /**
   * Activate a plugin module under a name. Reactivating an already-loaded name
   * unloads the previous instance first. Returns true if anything registered.
   */
  activatePlugin(name: string, mod: Plugin): boolean {
    const pluginName = mod.name || name;
    if (this.plugins.has(pluginName)) this.unload(pluginName);

    const record: LoadedPlugin = { name: pluginName, module: mod, tools: [], hooks: [] };
    const self = this;

    if (typeof mod.activate === 'function') {
      const ctx: PluginContext = {
        name: pluginName,
        config: this.config,
        log: getLogger(`plugin:${pluginName}`),
        registerTool(def: ToolDefinition) {
          self.toolRegistry.register(def);
          record.tools.push(def.name);
          void self.emit('tool.register', { plugin: pluginName, tool: def.name });
        },
        on(hook: PluginHook, handler: HookHandler) {
          record.hooks.push({ hook, fn: handler });
          const arr = self.hookHandlers.get(hook) || [];
          arr.push({ plugin: pluginName, fn: handler });
          self.hookHandlers.set(hook, arr);
        },
      };
      try {
        void mod.activate(ctx);
      } catch (e) {
        log.warn('plugin_activate_failed', { name: pluginName, error: String(e) });
        this.unload(pluginName);
        return false;
      }
    } else if (typeof mod.register === 'function') {
      // Legacy: diff the registry to learn which tools the plugin added.
      const before = new Set(this.toolRegistry.listNames());
      try {
        mod.register(this.toolRegistry);
      } catch (e) {
        log.warn('plugin_register_failed', { name: pluginName, error: String(e) });
        return false;
      }
      for (const n of this.toolRegistry.listNames()) {
        if (!before.has(n)) record.tools.push(n);
      }
    } else {
      log.warn('plugin_no_entrypoint', { name: pluginName });
      return false;
    }

    this.plugins.set(pluginName, record);
    log.info('plugin_loaded', { name: pluginName, tools: record.tools.length, hooks: record.hooks.length });
    return true;
  }

  /** Fire a hook; handlers run in registration order. Errors are isolated. */
  async emit(hook: PluginHook, payload?: any): Promise<void> {
    const handlers = this.hookHandlers.get(hook);
    if (!handlers || handlers.length === 0) return;
    for (const { plugin, fn } of [...handlers]) {
      try {
        await fn(payload);
      } catch (e) {
        log.warn('plugin_hook_failed', { hook, plugin, error: String(e) });
      }
    }
  }

  /** Unload a plugin: remove its tools and hook handlers, call deactivate. */
  unload(name: string): boolean {
    const record = this.plugins.get(name);
    if (!record) return false;

    for (const tool of record.tools) this.toolRegistry.unregister(tool);
    for (const [hook, arr] of this.hookHandlers) {
      const filtered = arr.filter((h) => h.plugin !== name);
      if (filtered.length) this.hookHandlers.set(hook, filtered);
      else this.hookHandlers.delete(hook);
    }
    try { record.module.deactivate?.(); } catch (e) { log.warn('plugin_deactivate_failed', { name, error: String(e) }); }

    this.plugins.delete(name);
    log.info('plugin_unloaded', { name });
    return true;
  }

  /** Names of currently loaded plugins. */
  list(): string[] { return [...this.plugins.keys()]; }

  /** Number of handlers registered for a hook (for diagnostics/tests). */
  hookCount(hook: PluginHook): number { return this.hookHandlers.get(hook)?.length ?? 0; }
}
