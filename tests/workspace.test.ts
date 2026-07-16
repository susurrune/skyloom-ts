import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from '../src/core/workspace';

describe('workspace path resolution', () => {
  it('resolves relative paths from the injected working directory', () => {
    expect(resolveWorkspacePath('project-files', {
      homeDir: path.resolve('home'),
      cwd: path.resolve('checkout'),
    })).toBe(path.resolve('checkout', 'project-files'));
  });

  it('expands a home-relative path from the injected home directory', () => {
    const homeDir = path.resolve('isolated-home');
    expect(resolveWorkspacePath('~/skyloom-files', {
      homeDir,
      cwd: path.resolve('checkout'),
    })).toBe(path.join(homeDir, 'skyloom-files'));
  });
});
