import { TagNamingService, TagNamingConfig } from '../../../src/domain/service/TagNamingService';

function defaultConfig(overrides: Partial<TagNamingConfig> = {}): TagNamingConfig {
  return {
    tagPrefix: 'vmware:',
    categorySeparator: '/',
    maxTagNameLength: 64,
    ...overrides,
  };
}

describe('TagNamingService', () => {
  describe('constructor validation', () => {
    it('should throw when maxTagNameLength is too small for prefix and hash', () => {
      expect(
        () => new TagNamingService({ tagPrefix: 'vmware:', categorySeparator: '/', maxTagNameLength: 10 })
      ).toThrow(/maxTagNameLength.*too small/);
    });

    it('should not throw with a valid config', () => {
      expect(() => new TagNamingService(defaultConfig())).not.toThrow();
    });
  });

  describe('toVisionOneTagName', () => {
    it('should produce basic name: prefix + category + separator + tag', () => {
      const svc = new TagNamingService(defaultConfig());
      const result = svc.toVisionOneTagName('Environment', 'Production');
      expect(result).toBe('vmware:Environment/Production');
    });

    it('should use custom prefix and separator', () => {
      const svc = new TagNamingService(
        defaultConfig({ tagPrefix: 'custom--', categorySeparator: '::' })
      );
      const result = svc.toVisionOneTagName('Env', 'Prod');
      expect(result).toBe('custom--Env::Prod');
    });

    it('should truncate with hash suffix when name exceeds maxTagNameLength', () => {
      const svc = new TagNamingService(defaultConfig({ maxTagNameLength: 30 }));
      const longTag = 'A'.repeat(50);
      const result = svc.toVisionOneTagName('Category', longTag);

      expect(result).toHaveLength(30);
      // Should contain truncation indicator ~ followed by 6 hex chars
      expect(result).toMatch(/~[0-9a-f]{6}$/);
    });

    it('should NOT truncate when name fits within maxTagNameLength', () => {
      const svc = new TagNamingService(defaultConfig({ maxTagNameLength: 64 }));
      const result = svc.toVisionOneTagName('Env', 'Prod');
      expect(result).toBe('vmware:Env/Prod');
      expect(result).not.toContain('~');
    });

    it('should produce unique truncated names for different long inputs', () => {
      const svc = new TagNamingService(defaultConfig({ maxTagNameLength: 30 }));
      const result1 = svc.toVisionOneTagName('Category', 'A'.repeat(50));
      const result2 = svc.toVisionOneTagName('Category', 'B'.repeat(50));

      expect(result1).not.toBe(result2);
    });

    it('should throw when categoryName is empty', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(() => svc.toVisionOneTagName('', 'Production')).toThrow(
        /categoryName and tagName are required/
      );
    });

    it('should throw when tagName is empty', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(() => svc.toVisionOneTagName('Environment', '')).toThrow(
        /categoryName and tagName are required/
      );
    });
  });

  describe('parseVisionOneTagName', () => {
    it('should parse a standard managed tag name back to components', () => {
      const svc = new TagNamingService(defaultConfig());
      const parsed = svc.parseVisionOneTagName('vmware:Environment/Production');

      expect(parsed).toEqual({
        categoryName: 'Environment',
        tagName: 'Production',
      });
    });

    it('should return null for non-managed tags (wrong prefix)', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.parseVisionOneTagName('manual:SomeTag')).toBeNull();
    });

    it('should return null for non-managed tags (no prefix)', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.parseVisionOneTagName('justATag')).toBeNull();
    });

    it('should return null for truncated tag names', () => {
      const svc = new TagNamingService(defaultConfig({ maxTagNameLength: 30 }));
      const truncated = svc.toVisionOneTagName('Category', 'A'.repeat(50));
      const parsed = svc.parseVisionOneTagName(truncated);

      expect(parsed).toBeNull();
    });

    it('should return null when separator is missing', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.parseVisionOneTagName('vmware:NoCategoryOrTag')).toBeNull();
    });

    it('should return null when category part is empty', () => {
      const svc = new TagNamingService(defaultConfig());
      // "vmware:/Production" -> category is empty string
      expect(svc.parseVisionOneTagName('vmware:/Production')).toBeNull();
    });

    it('should return null when tag part is empty', () => {
      const svc = new TagNamingService(defaultConfig());
      // "vmware:Environment/" -> tag is empty string
      expect(svc.parseVisionOneTagName('vmware:Environment/')).toBeNull();
    });

    it('should parse custom prefix and separator', () => {
      const svc = new TagNamingService(
        defaultConfig({ tagPrefix: 'auto--', categorySeparator: '::' })
      );
      const parsed = svc.parseVisionOneTagName('auto--Env::Staging');
      expect(parsed).toEqual({ categoryName: 'Env', tagName: 'Staging' });
    });
  });

  describe('isManagedTag', () => {
    it('should return true for tags starting with the configured prefix', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.isManagedTag('vmware:Environment/Production')).toBe(true);
    });

    it('should return true for truncated managed tags', () => {
      const svc = new TagNamingService(defaultConfig({ maxTagNameLength: 30 }));
      const truncated = svc.toVisionOneTagName('Category', 'A'.repeat(50));
      expect(svc.isManagedTag(truncated)).toBe(true);
    });

    it('should return false for non-managed tags', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.isManagedTag('manual-tag')).toBe(false);
    });

    it('should return false for empty string', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.isManagedTag('')).toBe(false);
    });

    it('should return false when prefix partially matches', () => {
      const svc = new TagNamingService(defaultConfig());
      expect(svc.isManagedTag('vmwar')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in category and tag names', () => {
      const svc = new TagNamingService(defaultConfig());
      const result = svc.toVisionOneTagName('My Category!', 'tag@#$%');
      expect(result).toBe('vmware:My Category!/tag@#$%');

      const parsed = svc.parseVisionOneTagName(result);
      expect(parsed).toEqual({ categoryName: 'My Category!', tagName: 'tag@#$%' });
    });

    it('should handle separator characters within names', () => {
      const svc = new TagNamingService(defaultConfig());
      // If category contains separator, parse should take first occurrence
      const tagName = svc.toVisionOneTagName('Cat', 'sub/value');
      expect(tagName).toBe('vmware:Cat/sub/value');

      const parsed = svc.parseVisionOneTagName(tagName);
      // First separator splits: category=Cat, tag=sub/value
      expect(parsed).toEqual({ categoryName: 'Cat', tagName: 'sub/value' });
    });
  });
});
