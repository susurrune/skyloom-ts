/**
 * Plugin loader — loads external plugins that register additional tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';

const log = getLogger('plugin-loader');

export class PluginLoader {
  private toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Load plugins from specified directories.
   */
  loadFromDirectories(directories: string[]): number {
    let total = 0;
    for (const dir of directories) {
      total += this.loadDirectory(dir);
    }
    return total;
  }

  /**
   * Load a single plugin directory.
   */
  private loadDirectory(dir: string): number {
    if (!fs.existsSync(dir)) {
      log.debug('plugin_dir_not_found', { dir });
      return 0;
    }

    let count = 0;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const pluginPath = path.join(dir, entry);
        if (!fs.statSync(pluginPath).isDirectory()) continue;

        const pluginFile = path.join(pluginPath, 'index.js');
        if (!fs.existsSync(pluginFile)) continue;

        try {
          const plugin = require(pluginFile);
          if (typeof plugin.register === 'function') {
            plugin.register(this.toolRegistry);
            count++;
            log.info('plugin_loaded', { name: entry });
          }
        } catch (e) {
          log.warn('plugin_load_failed', { name: entry, error: String(e) });
        }
      }
    } catch (e) {
      log.warn('plugin_dir_scan_failed', { dir, error: String(e) });
    }

    return count;
  }
}
