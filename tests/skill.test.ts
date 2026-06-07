/**
 * Tests for skill system.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Skill', () => {
  it('creates a skill with model override', async () => {
    const { Skill } = await import('../src/core/skill');
    const skill = new Skill({
      name: 'test_skill',
      description: 'A test skill',
      model: 'claude-opus-4-7',
    });
    expect(skill.model).toBe('claude-opus-4-7');
    expect(skill.temperature).toBeNull();
    expect(skill.maxTokens).toBeNull();
  });

  it('creates a skill with temperature override', async () => {
    const { Skill } = await import('../src/core/skill');
    const skill = new Skill({ name: 'test_skill', description: 'A test skill', temperature: 0.3 });
    expect(skill.temperature).toBe(0.3);
  });

  it('creates a skill with max_tokens override', async () => {
    const { Skill } = await import('../src/core/skill');
    const skill = new Skill({ name: 'test_skill', description: 'A test skill', maxTokens: 32000 });
    expect(skill.maxTokens).toBe(32000);
  });

  it('default has no overrides', async () => {
    const { Skill } = await import('../src/core/skill');
    const skill = new Skill({ name: 'test', description: 'test' });
    expect(skill.model).toBeNull();
    expect(skill.temperature).toBeNull();
    expect(skill.maxTokens).toBeNull();
  });
});

describe('Skill.fromMarkdown', () => {
  it('loads skill with YAML frontmatter', async () => {
    const { Skill } = await import('../src/core/skill');
    const tmpDir = fs.mkdtempSync('skill-test-');
    const mdPath = path.join(tmpDir, 'test.md');
    fs.writeFileSync(mdPath, `---
name: test_skill
description: A test
model: claude-sonnet-4-6
temperature: 0.5
max_tokens: 8192
---

## Test Skill
This is a test skill.
`, 'utf-8');

    const skill = Skill.fromMarkdown(mdPath);
    expect(skill).not.toBeNull();
    if (skill) {
      expect(skill.model).toBe('claude-sonnet-4-6');
      expect(skill.temperature).toBe(0.5);
      expect(skill.maxTokens).toBe(8192);
      expect(skill.systemPrompt).toContain('This is a test skill');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supports string path', async () => {
    const { Skill } = await import('../src/core/skill');
    const tmpDir = fs.mkdtempSync('skill-test-');
    const mdPath = path.join(tmpDir, 'x.md');
    fs.writeFileSync(mdPath, '---\nname: x\ndescription: x\n---\n\nBody.', 'utf-8');
    const s = Skill.fromMarkdown(mdPath);
    expect(s).not.toBeNull();
    if (s) {
      expect(s.name).toBe('x');
      expect(typeof s.sourcePath).toBe('string');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('derives triggers from quoted descriptions', async () => {
    const { Skill } = await import('../src/core/skill');
    const tmpDir = fs.mkdtempSync('skill-test-');
    const mdPath = path.join(tmpDir, 'pptx.md');
    fs.writeFileSync(mdPath, `---
name: pptx
description: |-
  Use this skill any time a .pptx file is involved.
  Trigger whenever the user mentions "deck," "slides," or "presentation."
  If a .pptx file needs to be opened, use it.
---
Body.`, 'utf-8');

    const s = Skill.fromMarkdown(mdPath);
    expect(s).not.toBeNull();
    if (s) {
      const triggersLower = s.triggers.map(t => t.toLowerCase());
      expect(triggersLower).toContain('deck');
      expect(triggersLower).toContain('slides');
      expect(triggersLower).toContain('presentation');
      expect(triggersLower).toContain('.pptx');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('small body loaded in full', async () => {
    const { Skill } = await import('../src/core/skill');
    const tmpDir = fs.mkdtempSync('skill-test-');
    const mdPath = path.join(tmpDir, 'small.md');
    fs.writeFileSync(mdPath, '---\nname: small\ndescription: x\n---\n\n# Small Skill\n\nThis fits inline easily.', 'utf-8');
    const s = Skill.fromMarkdown(mdPath);
    expect(s).not.toBeNull();
    if (s) {
      expect(s.bodyTruncated).toBe(false);
      expect(s.systemPrompt).toContain('This fits inline easily');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('large body truncated to head', async () => {
    const { Skill } = await import('../src/core/skill');
    const tmpDir = fs.mkdtempSync('skill-test-');
    const mdPath = path.join(tmpDir, 'big.md');

    let body = '# Big Skill\n\n## Quick Reference\nFirst section content.\n\n';
    body += '## Detailed Guide\n';
    body += 'X'.repeat(5000);

    fs.writeFileSync(mdPath, `---\nname: big\ndescription: x\n---\n\n${body}`, 'utf-8');
    const s = Skill.fromMarkdown(mdPath);
    expect(s).not.toBeNull();
    if (s) {
      expect(s.bodyTruncated).toBe(true);
      expect(s.systemPrompt).toContain('Big Skill');
      expect(s.systemPrompt).toContain('Quick Reference');
      expect(s.systemPrompt).not.toContain('Detailed Guide');
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('SkillRegistry', () => {
  it('registers and retrieves skills', async () => {
    const { Skill, SkillRegistry } = await import('../src/core/skill');
    const reg = new SkillRegistry();
    const skill = new Skill({ name: 'test', description: 'Test' });
    reg.register(skill);
    expect(reg.get('test')).toBe(skill);
    expect(reg.get('missing')).toBeUndefined();
  });

  it('lists names', async () => {
    const { Skill, SkillRegistry } = await import('../src/core/skill');
    const reg = new SkillRegistry();
    reg.register(new Skill({ name: 'a', description: 'A' }));
    reg.register(new Skill({ name: 'b', description: 'B' }));
    expect(reg.listNames()).toEqual(['a', 'b']);
  });

  it('merges registries', async () => {
    const { Skill, SkillRegistry } = await import('../src/core/skill');
    const r1 = new SkillRegistry();
    r1.register(new Skill({ name: 'a', description: 'A' }));
    const r2 = new SkillRegistry();
    r2.register(new Skill({ name: 'b', description: 'B' }));
    r1.merge(r2);
    expect(r1.get('b')).toBeDefined();
  });
});
