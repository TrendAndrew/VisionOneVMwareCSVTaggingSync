/**
 * Pure domain service that transforms VMware tag names into
 * Vision One custom tag names and parses them back.
 *
 * Handles prefix formatting, category/tag combination, and truncation
 * with hash suffixes for uniqueness when names exceed the max length.
 */

import crypto from 'crypto';

export interface TagNamingConfig {
  /** Prefix prepended to all managed tag names (e.g., "vmware:"). */
  tagPrefix: string;
  /** Separator between category and tag name (e.g., "/"). */
  categorySeparator: string;
  /** Maximum allowed length for a Vision One tag name (e.g., 64). */
  maxTagNameLength: number;
}

/** Result of parsing a Vision One tag name back to its VMware components. */
export interface ParsedTagName {
  categoryName: string;
  tagName: string;
}

/** Minimum hash suffix length used during truncation. */
const HASH_SUFFIX_LENGTH = 6;
/** Separator placed before the hash suffix when truncating. */
const TRUNCATION_INDICATOR = '~';

export class TagNamingService {
  constructor(private readonly config: TagNamingConfig) {
    if (config.maxTagNameLength < config.tagPrefix.length + HASH_SUFFIX_LENGTH + 2) {
      throw new Error(
        `maxTagNameLength (${config.maxTagNameLength}) is too small for the configured ` +
        `prefix ("${config.tagPrefix}") and hash suffix requirements. ` +
        `Minimum required: ${config.tagPrefix.length + HASH_SUFFIX_LENGTH + 2}.`
      );
    }
  }

  /**
   * Convert a VMware category and tag name into a Vision One custom tag name.
   *
   * Format: {prefix}{categoryName}{separator}{tagName}
   * Example: "vmware:Environment/Production"
   *
   * If the combined name exceeds maxTagNameLength, it is truncated and a
   * 6-character hash suffix is appended for uniqueness.
   *
   * @param categoryName - The VMware tag category name.
   * @param tagName - The VMware tag name within the category.
   * @returns The formatted Vision One tag name.
   */
  toVisionOneTagName(categoryName: string, tagName: string): string {
    if (!categoryName || !tagName) {
      throw new Error(
        'Both categoryName and tagName are required to form a Vision One tag name.'
      );
    }

    const fullName =
      this.config.tagPrefix +
      categoryName +
      this.config.categorySeparator +
      tagName;

    if (fullName.length <= this.config.maxTagNameLength) {
      return fullName;
    }

    return this.truncateWithHash(fullName);
  }

  /**
   * Parse a Vision One tag name back to its VMware category and tag components.
   *
   * Returns null if the tag name does not match the expected managed format
   * (i.e., does not start with the configured prefix or lacks the separator).
   *
   * Note: truncated tag names cannot be reliably parsed back to their
   * original values, so this returns null for truncated names.
   *
   * @param v1TagName - The Vision One tag name to parse.
   * @returns Parsed category and tag name, or null if not parseable.
   */
  parseVisionOneTagName(v1TagName: string): ParsedTagName | null {
    if (!this.isManagedTag(v1TagName)) {
      return null;
    }

    // Truncated tags cannot be reliably parsed
    if (this.isTruncated(v1TagName)) {
      return null;
    }

    const withoutPrefix = v1TagName.slice(this.config.tagPrefix.length);
    const separatorIndex = withoutPrefix.indexOf(this.config.categorySeparator);

    if (separatorIndex < 0) {
      return null;
    }

    const categoryName = withoutPrefix.slice(0, separatorIndex);
    const tagName = withoutPrefix.slice(
      separatorIndex + this.config.categorySeparator.length
    );

    if (!categoryName || !tagName) {
      return null;
    }

    return { categoryName, tagName };
  }

  /**
   * Check whether a Vision One tag name is managed by this system.
   *
   * A tag is considered managed if it starts with the configured prefix.
   *
   * @param v1TagName - The Vision One tag name to check.
   * @returns true if the tag is managed.
   */
  isManagedTag(v1TagName: string): boolean {
    return v1TagName.startsWith(this.config.tagPrefix);
  }

  /**
   * Truncate a tag name to fit within maxTagNameLength while preserving uniqueness
   * by appending a hash suffix.
   *
   * The result format is: {truncated_name}{TRUNCATION_INDICATOR}{6-char-hash}
   */
  private truncateWithHash(fullName: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(fullName)
      .digest('hex')
      .slice(0, HASH_SUFFIX_LENGTH);

    const suffixPart = TRUNCATION_INDICATOR + hash;
    const maxBodyLength = this.config.maxTagNameLength - suffixPart.length;
    const truncatedBody = fullName.slice(0, maxBodyLength);

    return truncatedBody + suffixPart;
  }

  /**
   * Detect whether a tag name was truncated by this service.
   */
  private isTruncated(v1TagName: string): boolean {
    if (v1TagName.length !== this.config.maxTagNameLength) {
      return false;
    }

    const potentialIndicatorPos =
      v1TagName.length - HASH_SUFFIX_LENGTH - TRUNCATION_INDICATOR.length;

    if (potentialIndicatorPos < 0) {
      return false;
    }

    return (
      v1TagName.charAt(potentialIndicatorPos) === TRUNCATION_INDICATOR &&
      /^[0-9a-f]+$/.test(v1TagName.slice(potentialIndicatorPos + 1))
    );
  }
}
