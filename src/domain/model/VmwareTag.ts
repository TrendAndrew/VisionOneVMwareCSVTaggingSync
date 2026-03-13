/**
 * VMware tag and category domain models.
 *
 * A Category groups related Tags (e.g. "Environment" -> "prod", "staging").
 * Cardinality controls whether a VM can have one or many tags per category.
 */

export interface VmwareCategory {
  id: string;
  name: string;
  description: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  associableTypes: string[];
}

export interface VmwareTag {
  id: string;
  name: string;
  categoryId: string;
  /** Resolved after fetch by joining with VmwareCategory. */
  categoryName?: string;
}
