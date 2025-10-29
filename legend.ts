import { ColorStrategy, TagColorInfo, TagFamily } from './color-strategy';

/**
 * Legend Filter State
 */
export interface LegendFilterState {
  soloTags: Set<string>;  // Solo mode: only show these tags
  mutedTags: Set<string>; // Muted: hide these tags
}

/**
 * Legend Component Options
 */
export interface LegendOptions {
  onFilterChange: (state: LegendFilterState) => void;
  onFamilyChange: (family: TagFamily) => void;
  colorStrategy: ColorStrategy;
}

/**
 * Legend Component - Right-docked panel showing tag colors and counts
 */
export class Legend {
  private container: HTMLElement;
  private colorStrategy: ColorStrategy;
  private onFilterChange: (state: LegendFilterState) => void;
  private onFamilyChange: (family: TagFamily) => void;
  private filterState: LegendFilterState;
  private rootEl: HTMLElement | null = null;
  private familySwitcherEl: HTMLElement | null = null;
  private tagListEl: HTMLElement | null = null;

  constructor(container: HTMLElement, options: LegendOptions) {
    this.container = container;
    this.colorStrategy = options.colorStrategy;
    this.onFilterChange = options.onFilterChange;
    this.onFamilyChange = options.onFamilyChange;

    this.filterState = {
      soloTags: new Set(),
      mutedTags: new Set()
    };

    this.render();
  }

  /**
   * Render the legend UI
   */
  private render() {
    this.container.empty();
    this.container.addClass('legend-container');

    this.rootEl = this.container.createDiv({ cls: 'legend' });

    // Header
    const header = this.rootEl.createDiv({ cls: 'legend-header' });
    header.createEl('h4', { text: '🎨 Legend' });

    // Family switcher
    this.renderFamilySwitcher();

    // Tag list
    this.renderTagList();

    // Footer actions
    this.renderFooter();
  }

  /**
   * Render family switcher dropdown
   */
  private renderFamilySwitcher() {
    if (!this.rootEl) return;

    const section = this.rootEl.createDiv({ cls: 'legend-section' });
    section.createEl('label', { text: 'Color by', cls: 'legend-label' });

    const select = section.createEl('select', { cls: 'legend-family-select' });
    this.familySwitcherEl = select;

    const families: { value: TagFamily; label: string }[] = [
      { value: 'topic', label: '📚 Topic' },
      { value: 'status', label: '✓ Status' },
      { value: 'project', label: '📁 Project' },
      { value: 'person', label: '👤 Person' },
      { value: 'source', label: '🔗 Source' }
    ];

    families.forEach(({ value, label }) => {
      const option = select.createEl('option', { value, text: label });
      if (value === this.colorStrategy.getActiveFamily()) {
        option.selected = true;
      }
    });

    select.addEventListener('change', () => {
      const family = select.value as TagFamily;
      this.colorStrategy.setActiveFamily(family);
      this.onFamilyChange(family);
      this.refreshTagList();
    });
  }

  /**
   * Render tag list with swatches and counts
   */
  private renderTagList() {
    if (!this.rootEl) return;

    const section = this.rootEl.createDiv({ cls: 'legend-section legend-tags-section' });
    this.tagListEl = section;

    this.refreshTagList();
  }

  /**
   * Refresh the tag list (called when family changes or state updates)
   */
  private refreshTagList() {
    if (!this.tagListEl) return;

    this.tagListEl.empty();

    const activeFamily = this.colorStrategy.getActiveFamily();
    const visibleTags = this.colorStrategy.getVisibleTags(activeFamily);
    const overflowCount = this.colorStrategy.getOverflowCount(activeFamily);

    // Render visible tags
    visibleTags.forEach(tagInfo => {
      this.renderTagItem(tagInfo);
    });

    // Render "other" group if there are overflow tags
    if (overflowCount > 0) {
      this.renderOtherItem(overflowCount);
    }

    // Empty state
    if (visibleTags.length === 0 && overflowCount === 0) {
      this.tagListEl!.createDiv({
        text: `No ${activeFamily} tags found`,
        cls: 'legend-empty'
      });
    }
  }

  /**
   * Render a single tag item
   */
  private renderTagItem(tagInfo: TagColorInfo) {
    if (!this.tagListEl) return;

    const item = this.tagListEl.createDiv({ cls: 'legend-tag-item' });

    // Check state
    const isSolo = this.filterState.soloTags.has(tagInfo.tag);
    const isMuted = this.filterState.mutedTags.has(tagInfo.tag);

    if (isSolo) item.addClass('is-solo');
    if (isMuted) item.addClass('is-muted');

    // Swatch
    const swatch = item.createDiv({ cls: 'legend-swatch' });
    const rgb = tagInfo.color.getStyle();
    swatch.style.backgroundColor = rgb;

    // Label and count
    const labelWrapper = item.createDiv({ cls: 'legend-label-wrapper' });
    labelWrapper.createEl('span', {
      text: this.formatTagLabel(tagInfo.tag),
      cls: 'legend-tag-label'
    });
    labelWrapper.createEl('span', {
      text: String(tagInfo.count),
      cls: 'legend-tag-count'
    });

    // Click handlers
    item.addEventListener('click', (e) => {
      if (e.shiftKey) {
        // Shift-click: multi-select (toggle solo)
        this.toggleSolo(tagInfo.tag);
      } else {
        // Regular click: toggle mute
        this.toggleMute(tagInfo.tag);
      }
      this.refreshTagList();
      this.notifyFilterChange();
    });

    // Hover preview
    item.addEventListener('mouseenter', () => {
      item.addClass('is-hovered');
    });

    item.addEventListener('mouseleave', () => {
      item.removeClass('is-hovered');
    });
  }

  /**
   * Render "other" group for overflow tags
   */
  private renderOtherItem(count: number) {
    if (!this.tagListEl) return;

    const item = this.tagListEl.createDiv({ cls: 'legend-tag-item legend-other-item' });

    // Gray swatch
    const swatch = item.createDiv({ cls: 'legend-swatch' });
    swatch.style.backgroundColor = '#666';

    // Label and count
    const labelWrapper = item.createDiv({ cls: 'legend-label-wrapper' });
    labelWrapper.createEl('span', {
      text: 'Other',
      cls: 'legend-tag-label'
    });
    labelWrapper.createEl('span', {
      text: String(count),
      cls: 'legend-tag-count'
    });
  }

  /**
   * Render footer with action buttons
   */
  private renderFooter() {
    if (!this.rootEl) return;

    const footer = this.rootEl.createDiv({ cls: 'legend-footer' });

    const clearBtn = footer.createEl('button', {
      text: 'Clear Filters',
      cls: 'legend-btn'
    });

    clearBtn.addEventListener('click', () => {
      this.clearFilters();
      this.refreshTagList();
      this.notifyFilterChange();
    });
  }

  /**
   * Format tag label (remove family prefix)
   */
  private formatTagLabel(tag: string): string {
    // Remove family prefix for cleaner display
    const parts = tag.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : tag;
  }

  /**
   * Toggle solo state for a tag
   */
  private toggleSolo(tag: string) {
    if (this.filterState.soloTags.has(tag)) {
      this.filterState.soloTags.delete(tag);
    } else {
      this.filterState.soloTags.add(tag);
      // Remove from muted if present
      this.filterState.mutedTags.delete(tag);
    }
  }

  /**
   * Toggle mute state for a tag
   */
  private toggleMute(tag: string) {
    if (this.filterState.mutedTags.has(tag)) {
      this.filterState.mutedTags.delete(tag);
    } else {
      this.filterState.mutedTags.add(tag);
      // Remove from solo if present
      this.filterState.soloTags.delete(tag);
    }
  }

  /**
   * Clear all filters
   */
  private clearFilters() {
    this.filterState.soloTags.clear();
    this.filterState.mutedTags.clear();
  }

  /**
   * Notify parent of filter changes
   */
  private notifyFilterChange() {
    this.onFilterChange(this.filterState);
  }

  /**
   * Get current filter state
   */
  getFilterState(): LegendFilterState {
    return {
      soloTags: new Set(this.filterState.soloTags),
      mutedTags: new Set(this.filterState.mutedTags)
    };
  }

  /**
   * Update color strategy (when state changes externally)
   */
  updateColorStrategy(colorStrategy: ColorStrategy) {
    this.colorStrategy = colorStrategy;
    this.refreshTagList();
  }

  /**
   * Refresh the entire legend
   */
  refresh() {
    this.refreshTagList();
  }

  /**
   * Destroy the legend
   */
  destroy() {
    this.container.empty();
    this.rootEl = null;
    this.familySwitcherEl = null;
    this.tagListEl = null;
  }
}
