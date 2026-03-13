/**
 * Handles paginated responses from the Vision One API.
 *
 * Vision One uses a "nextLink" URL or top/skip pattern for
 * pagination. This paginator fetches all pages and merges
 * the item arrays into a single result.
 */

import { VisionOneRestClient } from './VisionOneRestClient';

/** Shape of a paginated Vision One API response. */
interface PaginatedResponse<T> {
  items: T[];
  nextLink?: string;
  totalCount?: number;
}

export class VisionOnePaginator<T> {
  constructor(
    private readonly client: VisionOneRestClient,
    private readonly pageSize: number = 200
  ) {}

  /**
   * Fetch all pages from the given path and return the
   * complete list of items.
   *
   * The first request includes a `top` query parameter
   * set to pageSize. Subsequent requests follow the
   * `nextLink` URL returned in each response.
   */
  async fetchAll(path: string): Promise<T[]> {
    const allItems: T[] = [];
    let currentPath: string | null = path;
    let isFirstRequest = true;

    while (currentPath) {
      const params: Record<string, unknown> = {};

      if (isFirstRequest) {
        params['top'] = this.pageSize;
        isFirstRequest = false;
      }

      const response = await this.client.get<PaginatedResponse<T>>(
        currentPath,
        Object.keys(params).length > 0 ? params : undefined
      );

      if (response.items && Array.isArray(response.items)) {
        allItems.push(...response.items);
      }

      currentPath = this.resolveNextLink(response.nextLink);
    }

    return allItems;
  }

  /**
   * Resolve the nextLink from the API response.
   *
   * The nextLink may be a full URL or a relative path.
   * We extract just the path + query portion to use
   * with the rest client.
   */
  private resolveNextLink(nextLink?: string): string | null {
    if (!nextLink) {
      return null;
    }

    // If the nextLink is a full URL, extract the path.
    try {
      const url = new URL(nextLink);
      return url.pathname + url.search;
    } catch {
      // Already a relative path.
      return nextLink;
    }
  }
}
