import { OmniboxToken } from './omnibox';
import { TagFamily } from './color-strategy';
import { LegendFilterState } from './legend';
import { FacetRailAST } from './facet-rail';

/**
 * Sort options for nodes
 */
export type LensSortOption =
  | 'default'      // By layout position
  | 'recent'       // By modification time
  | 'connections'  // By connection count
  | 'alphabetical' // By name
  | 'size';        // By file size

/**
 * Lens - A shareable, persistent view configuration
 */
export interface Lens {
  id: string;
  name: string;
  description?: string;
  created: number;
  modified: number;

  // Query and filters
  query: OmniboxToken[];
  facetFilters: {
    timeWindow: string | null;
    degreeLimit: string | null;
    tagFamily: string[];
    provenance: string;
    similarityThreshold: number;
  };

  // Legend state
  legendFilters: {
    soloTags: string[];
    mutedTags: string[];
  };

  // Visual configuration
  colorFamily: TagFamily;
  colorblindMode: boolean;

  // View options
  sort: LensSortOption;
  layoutConfig?: {
    semanticAttraction: number;
    repulsion: number;
  };
}

/**
 * Lens Manager - Handles CRUD operations and persistence
 */
export class LensManager {
  private lenses: Map<string, Lens> = new Map();
  private activeLensId: string | null = null;
  private storageKey = 'smart-3d-lenses';
  private activeKey = 'smart-3d-active-lens';

  constructor() {
    this.loadFromStorage();
  }

  /**
   * Create a new lens
   */
  createLens(name: string, config: Omit<Lens, 'id' | 'name' | 'created' | 'modified'>): Lens {
    const lens: Lens = {
      id: this.generateId(),
      name,
      created: Date.now(),
      modified: Date.now(),
      ...config
    };

    this.lenses.set(lens.id, lens);
    this.saveToStorage();
    return lens;
  }

  /**
   * Update an existing lens
   */
  updateLens(id: string, updates: Partial<Omit<Lens, 'id' | 'created'>>): Lens | null {
    const lens = this.lenses.get(id);
    if (!lens) return null;

    const updated: Lens = {
      ...lens,
      ...updates,
      modified: Date.now()
    };

    this.lenses.set(id, updated);
    this.saveToStorage();
    return updated;
  }

  /**
   * Delete a lens
   */
  deleteLens(id: string): boolean {
    const deleted = this.lenses.delete(id);
    if (deleted) {
      if (this.activeLensId === id) {
        this.activeLensId = null;
        this.saveActiveToStorage();
      }
      this.saveToStorage();
    }
    return deleted;
  }

  /**
   * Get a lens by ID
   */
  getLens(id: string): Lens | null {
    return this.lenses.get(id) || null;
  }

  /**
   * Get all lenses
   */
  getAllLenses(): Lens[] {
    return Array.from(this.lenses.values())
      .sort((a, b) => b.modified - a.modified);
  }

  /**
   * Set active lens
   */
  setActiveLens(id: string | null): void {
    this.activeLensId = id;
    this.saveActiveToStorage();
  }

  /**
   * Get active lens
   */
  getActiveLens(): Lens | null {
    return this.activeLensId ? this.getLens(this.activeLensId) : null;
  }

  /**
   * Get active lens ID
   */
  getActiveLensId(): string | null {
    return this.activeLensId;
  }

  /**
   * Duplicate a lens
   */
  duplicateLens(id: string, newName?: string): Lens | null {
    const original = this.lenses.get(id);
    if (!original) return null;

    const duplicate: Lens = {
      ...original,
      id: this.generateId(),
      name: newName || `${original.name} (Copy)`,
      created: Date.now(),
      modified: Date.now()
    };

    this.lenses.set(duplicate.id, duplicate);
    this.saveToStorage();
    return duplicate;
  }

  /**
   * Export lens to JSON
   */
  exportLens(id: string): string | null {
    const lens = this.lenses.get(id);
    if (!lens) return null;
    return JSON.stringify(lens, null, 2);
  }

  /**
   * Import lens from JSON
   */
  importLens(json: string): Lens | null {
    try {
      const data = JSON.parse(json);

      // Validate required fields
      if (!data.name || !data.colorFamily) {
        throw new Error('Invalid lens data');
      }

      // Create new lens with imported data
      const lens: Lens = {
        id: this.generateId(),
        name: data.name,
        description: data.description,
        created: Date.now(),
        modified: Date.now(),
        query: data.query || [],
        facetFilters: data.facetFilters || {
          timeWindow: null,
          degreeLimit: null,
          tagFamily: [],
          provenance: 'all',
          similarityThreshold: 0.3
        },
        legendFilters: data.legendFilters || {
          soloTags: [],
          mutedTags: []
        },
        colorFamily: data.colorFamily || 'topic',
        colorblindMode: data.colorblindMode || false,
        sort: data.sort || 'default',
        layoutConfig: data.layoutConfig
      };

      this.lenses.set(lens.id, lens);
      this.saveToStorage();
      return lens;
    } catch (e) {
      console.error('Failed to import lens:', e);
      return null;
    }
  }

  /**
   * Search lenses by name or description
   */
  searchLenses(query: string): Lens[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllLenses().filter(lens =>
      lens.name.toLowerCase().includes(lowerQuery) ||
      (lens.description && lens.description.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Load lenses from local storage
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        this.lenses = new Map(Object.entries(data));
      }

      const activeId = localStorage.getItem(this.activeKey);
      if (activeId && this.lenses.has(activeId)) {
        this.activeLensId = activeId;
      }
    } catch (e) {
      console.error('Failed to load lenses from storage:', e);
    }
  }

  /**
   * Save lenses to local storage
   */
  private saveToStorage(): void {
    try {
      const data = Object.fromEntries(this.lenses);
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save lenses to storage:', e);
    }
  }

  /**
   * Save active lens ID to local storage
   */
  private saveActiveToStorage(): void {
    try {
      if (this.activeLensId) {
        localStorage.setItem(this.activeKey, this.activeLensId);
      } else {
        localStorage.removeItem(this.activeKey);
      }
    } catch (e) {
      console.error('Failed to save active lens to storage:', e);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `lens-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

/**
 * Lens Quick Switcher - Modal for quick lens switching
 */
export class LensQuickSwitcher {
  private modal: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private lensManager: LensManager;
  private onSelect: (lens: Lens) => void;
  private onClose: () => void;

  constructor(
    lensManager: LensManager,
    options: {
      onSelect: (lens: Lens) => void;
      onClose: () => void;
    }
  ) {
    this.lensManager = lensManager;
    this.onSelect = options.onSelect;
    this.onClose = options.onClose;
  }

  /**
   * Open the quick switcher
   */
  open(): void {
    if (this.modal) return;

    // Create modal overlay
    this.modal = document.createElement('div');
    this.modal.className = 'lens-quick-switcher-modal';

    // Create switcher container
    const container = this.modal.createDiv({ cls: 'lens-quick-switcher' });

    // Header
    const header = container.createDiv({ cls: 'lens-switcher-header' });
    header.createEl('h3', { text: '🔍 Quick Lens Switcher' });

    // Search input
    const inputWrapper = container.createDiv({ cls: 'lens-switcher-input-wrapper' });
    this.inputEl = inputWrapper.createEl('input', {
      type: 'text',
      placeholder: 'Search lenses by name...',
      cls: 'lens-switcher-input'
    });

    // Results container
    this.resultsEl = container.createDiv({ cls: 'lens-switcher-results' });

    // Bind events
    this.inputEl.addEventListener('input', () => this.updateResults());
    this.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));

    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    // Add to DOM
    document.body.appendChild(this.modal);

    // Initial render
    this.updateResults();

    // Focus input
    this.inputEl.focus();
  }

  /**
   * Close the quick switcher
   */
  close(): void {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      this.inputEl = null;
      this.resultsEl = null;
      this.onClose();
    }
  }

  /**
   * Update results based on search
   */
  private updateResults(): void {
    if (!this.resultsEl || !this.inputEl) return;

    const query = this.inputEl.value.trim();
    const lenses = query
      ? this.lensManager.searchLenses(query)
      : this.lensManager.getAllLenses();

    this.resultsEl.empty();

    if (lenses.length === 0) {
      this.resultsEl.createDiv({
        text: 'No lenses found',
        cls: 'lens-switcher-empty'
      });
      return;
    }

    const activeLensId = this.lensManager.getActiveLensId();

    lenses.forEach((lens, index) => {
      const item = this.resultsEl!.createDiv({ cls: 'lens-switcher-item' });

      if (lens.id === activeLensId) {
        item.addClass('is-active');
      }

      if (index === 0) {
        item.addClass('is-selected');
      }

      // Icon and name
      const main = item.createDiv({ cls: 'lens-switcher-item-main' });
      main.createEl('span', { text: '👁️', cls: 'lens-switcher-icon' });
      main.createEl('span', { text: lens.name, cls: 'lens-switcher-name' });

      // Metadata
      const meta = item.createDiv({ cls: 'lens-switcher-meta' });
      meta.createEl('span', {
        text: this.formatDate(lens.modified),
        cls: 'lens-switcher-date'
      });
      meta.createEl('span', {
        text: `${lens.colorFamily} • ${lens.sort}`,
        cls: 'lens-switcher-info'
      });

      // Description
      if (lens.description) {
        item.createDiv({
          text: lens.description,
          cls: 'lens-switcher-description'
        });
      }

      // Click handler
      item.addEventListener('click', () => {
        this.selectLens(lens);
      });

      // Hover handler
      item.addEventListener('mouseenter', () => {
        this.resultsEl!.querySelectorAll('.lens-switcher-item').forEach(el => {
          el.removeClass('is-selected');
        });
        item.addClass('is-selected');
      });
    });
  }

  /**
   * Handle keyboard navigation
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.resultsEl) return;

    const items = Array.from(this.resultsEl.querySelectorAll('.lens-switcher-item'));
    const selectedIndex = items.findIndex(el => el.hasClass('is-selected'));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (selectedIndex + 1) % items.length;
      items.forEach((el, i) => {
        el.toggleClass('is-selected', i === nextIndex);
      });
      items[nextIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (selectedIndex - 1 + items.length) % items.length;
      items.forEach((el, i) => {
        el.toggleClass('is-selected', i === prevIndex);
      });
      items[prevIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selectedItem = items[selectedIndex];
      if (selectedItem) {
        selectedItem.dispatchEvent(new MouseEvent('click'));
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  /**
   * Select a lens
   */
  private selectLens(lens: Lens): void {
    this.onSelect(lens);
    this.close();
  }

  /**
   * Format date for display
   */
  private formatDate(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    const date = new Date(timestamp);
    return date.toLocaleDateString();
  }
}
