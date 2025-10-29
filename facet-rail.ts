import { OmniboxToken } from './omnibox';

/**
 * AST Node Types for Facet Rail Controls
 */
export type FacetASTNodeType =
  | 'time_window'
  | 'degree_limit'
  | 'tag_family'
  | 'provenance'
  | 'similarity_threshold';

export interface FacetASTNode {
  type: FacetASTNodeType;
  value: any;
  metadata?: Record<string, any>;
}

/**
 * Facet Rail AST - Unified state representation
 */
export class FacetRailAST {
  private nodes: Map<FacetASTNodeType, FacetASTNode> = new Map();
  private listeners: Set<(ast: FacetRailAST) => void> = new Set();

  constructor() {
    // Initialize with default values
    this.nodes.set('time_window', { type: 'time_window', value: null });
    this.nodes.set('degree_limit', { type: 'degree_limit', value: null });
    this.nodes.set('tag_family', { type: 'tag_family', value: new Set<string>() });
    this.nodes.set('provenance', { type: 'provenance', value: 'all' }); // 'all' | 'human' | 'extracted'
    this.nodes.set('similarity_threshold', { type: 'similarity_threshold', value: 0.3 });
  }

  /**
   * Get a node by type
   */
  getNode(type: FacetASTNodeType): FacetASTNode | undefined {
    return this.nodes.get(type);
  }

  /**
   * Set a node value
   */
  setNode(type: FacetASTNodeType, value: any, metadata?: Record<string, any>) {
    this.nodes.set(type, { type, value, metadata });
    this.notify();
  }

  /**
   * Subscribe to AST changes
   */
  subscribe(listener: (ast: FacetRailAST) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of changes
   */
  private notify() {
    this.listeners.forEach(listener => listener(this));
  }

  /**
   * Convert AST to Omnibox tokens (AST → Omnibox)
   */
  toOmniboxTokens(): OmniboxToken[] {
    const tokens: OmniboxToken[] = [];
    let idCounter = 0;

    // Time window
    const timeNode = this.nodes.get('time_window');
    if (timeNode && timeNode.value) {
      tokens.push({
        id: `facet-time-${idCounter++}`,
        kind: 'operator',
        raw: `time:${timeNode.value}`,
        value: timeNode.value,
        operator: 'time'
      });
    }

    // Degree limit
    const degreeNode = this.nodes.get('degree_limit');
    if (degreeNode && degreeNode.value) {
      tokens.push({
        id: `facet-degree-${idCounter++}`,
        kind: 'operator',
        raw: `degree:${degreeNode.value}`,
        value: degreeNode.value,
        operator: 'degree'
      });
    }

    // Tag families
    const tagNode = this.nodes.get('tag_family');
    if (tagNode && tagNode.value instanceof Set && tagNode.value.size > 0) {
      for (const tag of tagNode.value) {
        tokens.push({
          id: `facet-tag-${idCounter++}`,
          kind: 'operator',
          raw: `tag:${tag}`,
          value: tag,
          operator: 'tag'
        });
      }
    }

    // Provenance filter (custom token for now, can be expanded)
    const provNode = this.nodes.get('provenance');
    if (provNode && provNode.value !== 'all') {
      tokens.push({
        id: `facet-provenance-${idCounter++}`,
        kind: 'operator',
        raw: `tag:${provNode.value}`,
        value: provNode.value,
        operator: 'tag' // Using tag operator to filter by provenance tags
      });
    }

    return tokens;
  }

  /**
   * Update AST from Omnibox tokens (Omnibox → AST)
   */
  fromOmniboxTokens(tokens: OmniboxToken[]) {
    // Reset collections
    const newTags = new Set<string>();
    let hasTimeToken = false;
    let hasDegreeToken = false;

    for (const token of tokens) {
      if (token.operator === 'time') {
        this.nodes.set('time_window', { type: 'time_window', value: token.value });
        hasTimeToken = true;
      } else if (token.operator === 'degree') {
        this.nodes.set('degree_limit', { type: 'degree_limit', value: token.value });
        hasDegreeToken = true;
      } else if (token.operator === 'tag') {
        newTags.add(String(token.value));
      }
    }

    // Clear if no tokens found
    if (!hasTimeToken) {
      this.nodes.set('time_window', { type: 'time_window', value: null });
    }
    if (!hasDegreeToken) {
      this.nodes.set('degree_limit', { type: 'degree_limit', value: null });
    }

    this.nodes.set('tag_family', { type: 'tag_family', value: newTags });

    // Don't notify here since this is called FROM the omnibox
    // (prevents circular updates)
  }

  /**
   * Get all nodes
   */
  getAllNodes(): Map<FacetASTNodeType, FacetASTNode> {
    return new Map(this.nodes);
  }

  /**
   * Clear all filters
   */
  clear() {
    this.nodes.set('time_window', { type: 'time_window', value: null });
    this.nodes.set('degree_limit', { type: 'degree_limit', value: null });
    this.nodes.set('tag_family', { type: 'tag_family', value: new Set<string>() });
    this.nodes.set('provenance', { type: 'provenance', value: 'all' });
    this.nodes.set('similarity_threshold', { type: 'similarity_threshold', value: 0.3 });
    this.notify();
  }
}

/**
 * Facet Rail Component - Compact left-side control panel
 */
export class FacetRail {
  private container: HTMLElement;
  private ast: FacetRailAST;
  private onChange: (ast: FacetRailAST) => void;
  private allTags: Set<string> = new Set();

  constructor(
    container: HTMLElement,
    ast: FacetRailAST,
    options: {
      onChange: (ast: FacetRailAST) => void;
      allTags?: Set<string>;
    }
  ) {
    this.container = container;
    this.ast = ast;
    this.onChange = options.onChange;
    this.allTags = options.allTags || new Set();

    this.render();

    // Subscribe to AST changes to update UI
    this.ast.subscribe(() => this.updateFromAST());
  }

  /**
   * Render the facet rail UI
   */
  private render() {
    this.container.empty();
    this.container.addClass('facet-rail');

    // Header
    const header = this.container.createDiv({ cls: 'facet-rail-header' });
    header.createEl('h4', { text: '🔍 Filters' });

    const clearBtn = header.createEl('button', {
      text: 'Clear',
      cls: 'facet-rail-clear-btn'
    });
    clearBtn.addEventListener('click', () => {
      this.ast.clear();
      this.onChange(this.ast);
    });

    // Time Window
    this.renderTimeWindow();

    // Degree Limit
    this.renderDegreeLimit();

    // Tag Families
    this.renderTagFamilies();

    // Provenance
    this.renderProvenance();

    // Similarity Threshold
    this.renderSimilarityThreshold();
  }

  /**
   * Render Time Window control
   */
  private renderTimeWindow() {
    const section = this.container.createDiv({ cls: 'facet-section' });
    section.createEl('label', { text: 'Time Window', cls: 'facet-label' });

    const select = section.createEl('select', { cls: 'facet-select' });
    const options = [
      { value: '', label: 'All time' },
      { value: '1d', label: 'Last day' },
      { value: '7d', label: 'Last week' },
      { value: '30d', label: 'Last month' },
      { value: '90d', label: 'Last 3 months' },
      { value: '365d', label: 'Last year' }
    ];

    options.forEach(opt => {
      const el = select.createEl('option', { value: opt.value, text: opt.label });
    });

    select.addEventListener('change', () => {
      const value = select.value || null;
      this.ast.setNode('time_window', value);
      this.onChange(this.ast);
    });

    // Store reference for updates
    (section as any).__select = select;
  }

  /**
   * Render Degree Limit control
   */
  private renderDegreeLimit() {
    const section = this.container.createDiv({ cls: 'facet-section' });
    section.createEl('label', { text: 'Connection Degree', cls: 'facet-label' });

    const wrapper = section.createDiv({ cls: 'facet-input-wrapper' });
    const input = wrapper.createEl('input', {
      type: 'text',
      placeholder: 'e.g., >=2, <=5',
      cls: 'facet-input'
    });

    input.addEventListener('input', () => {
      const value = input.value.trim() || null;
      this.ast.setNode('degree_limit', value);
      this.onChange(this.ast);
    });

    // Store reference for updates
    (section as any).__input = input;
  }

  /**
   * Render Tag Families control
   */
  private renderTagFamilies() {
    const section = this.container.createDiv({ cls: 'facet-section' });
    section.createEl('label', { text: 'Tags', cls: 'facet-label' });

    const tagContainer = section.createDiv({ cls: 'facet-tag-container' });

    // If we have known tags, show checkboxes
    if (this.allTags.size > 0) {
      const tagList = Array.from(this.allTags).sort();
      tagList.slice(0, 10).forEach(tag => { // Show first 10 tags
        const tagItem = tagContainer.createDiv({ cls: 'facet-tag-item' });

        const checkbox = tagItem.createEl('input', { type: 'checkbox' });
        checkbox.id = `tag-${tag}`;

        const label = tagItem.createEl('label', { text: tag });
        label.htmlFor = `tag-${tag}`;

        checkbox.addEventListener('change', () => {
          const currentTags = (this.ast.getNode('tag_family')?.value as Set<string>) || new Set();
          const newTags = new Set(currentTags);

          if (checkbox.checked) {
            newTags.add(tag);
          } else {
            newTags.delete(tag);
          }

          this.ast.setNode('tag_family', newTags);
          this.onChange(this.ast);
        });
      });

      if (tagList.length > 10) {
        tagContainer.createEl('div', {
          text: `+${tagList.length - 10} more tags`,
          cls: 'facet-tag-more'
        });
      }
    } else {
      tagContainer.createEl('div', {
        text: 'No tags found',
        cls: 'facet-empty'
      });
    }

    // Store reference for updates
    (section as any).__tagContainer = tagContainer;
  }

  /**
   * Render Provenance control
   */
  private renderProvenance() {
    const section = this.container.createDiv({ cls: 'facet-section' });
    section.createEl('label', { text: 'Provenance', cls: 'facet-label' });

    const select = section.createEl('select', { cls: 'facet-select' });
    const options = [
      { value: 'all', label: 'All notes' },
      { value: 'human', label: 'Human-created' },
      { value: 'extracted', label: 'Auto-extracted' }
    ];

    options.forEach(opt => {
      select.createEl('option', { value: opt.value, text: opt.label });
    });

    select.addEventListener('change', () => {
      this.ast.setNode('provenance', select.value);
      this.onChange(this.ast);
    });

    // Store reference for updates
    (section as any).__select = select;
  }

  /**
   * Render Similarity Threshold control
   */
  private renderSimilarityThreshold() {
    const section = this.container.createDiv({ cls: 'facet-section' });
    const labelRow = section.createDiv({ cls: 'facet-label-row' });
    labelRow.createEl('label', { text: 'Similarity Threshold', cls: 'facet-label' });
    const valueLabel = labelRow.createEl('span', {
      text: '0.30',
      cls: 'facet-value-label'
    });

    const slider = section.createEl('input', {
      type: 'range',
      cls: 'facet-slider'
    });
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.05';
    slider.value = '0.3';

    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);
      valueLabel.textContent = value.toFixed(2);
      this.ast.setNode('similarity_threshold', value);
      this.onChange(this.ast);
    });

    // Store references for updates
    (section as any).__slider = slider;
    (section as any).__valueLabel = valueLabel;
  }

  /**
   * Update UI from AST (for bidirectional binding)
   */
  private updateFromAST() {
    // Time Window
    const timeSection = this.container.querySelector('.facet-section:nth-child(2)') as any;
    if (timeSection?.__select) {
      const timeNode = this.ast.getNode('time_window');
      timeSection.__select.value = timeNode?.value || '';
    }

    // Degree Limit
    const degreeSection = this.container.querySelector('.facet-section:nth-child(3)') as any;
    if (degreeSection?.__input) {
      const degreeNode = this.ast.getNode('degree_limit');
      degreeSection.__input.value = degreeNode?.value || '';
    }

    // Provenance
    const provSection = this.container.querySelector('.facet-section:nth-child(5)') as any;
    if (provSection?.__select) {
      const provNode = this.ast.getNode('provenance');
      provSection.__select.value = provNode?.value || 'all';
    }

    // Similarity Threshold
    const simSection = this.container.querySelector('.facet-section:nth-child(6)') as any;
    if (simSection?.__slider && simSection?.__valueLabel) {
      const simNode = this.ast.getNode('similarity_threshold');
      const value = simNode?.value || 0.3;
      simSection.__slider.value = String(value);
      simSection.__valueLabel.textContent = value.toFixed(2);
    }
  }

  /**
   * Update available tags
   */
  updateTags(tags: Set<string>) {
    this.allTags = tags;
    // Re-render tag section
    const tagSection = this.container.querySelector('.facet-section:nth-child(4)');
    if (tagSection) {
      tagSection.remove();
      this.renderTagFamilies();
    }
  }

  /**
   * Destroy the facet rail
   */
  destroy() {
    this.container.empty();
  }
}
