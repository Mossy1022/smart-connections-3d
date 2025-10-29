import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type SmartConnections3DPlugin from './main';
import { Omnibox, OmniboxToken } from './omnibox';
import { FacetRail, FacetRailAST } from './facet-rail';
import { ColorStrategy, TagFamily } from './color-strategy';
import { Legend, LegendFilterState } from './legend';
import { Lens, LensManager, LensQuickSwitcher } from './lens';

const VIEW_TYPE_3D = 'smart-3d-view';

interface NodeData {
  key: string;
  name: string;
  path: string;
  embedding: number[];
  mtime: number;
  size: number;
  connections: string[];
  tags: string[];
  pinCount: number;
  isExtracted: boolean;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class ThreeDView extends ItemView {
  plugin: SmartConnections3DPlugin;
  containerEl: HTMLElement;
  scene: THREE.Scene | null = null;
  camera: THREE.PerspectiveCamera | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  controls: OrbitControls | null = null;
  nodes: THREE.Mesh[] = [];
  labels: Map<THREE.Mesh, THREE.Sprite> = new Map();
  layout: SemanticLayout | null = null;
  animationId: number | null = null;
  resizeObserver: ResizeObserver | null = null;
  omnibox: Omnibox | null = null;
  edges: THREE.LineSegments | null = null;
  activeQueryTokens: OmniboxToken[] = [];
  private _lastQueryEmbedding: number[] | null = null;
  facetRail: FacetRail | null = null;
  facetAST: FacetRailAST = new FacetRailAST();
  private _allTags: Set<string> = new Set();
  colorStrategy: ColorStrategy | null = null;
  legend: Legend | null = null;
  legendFilterState: LegendFilterState = { soloTags: new Set(), mutedTags: new Set() };
  hoveredNode: THREE.Mesh | null = null;
  lensManager: LensManager = new LensManager();
  quickSwitcher: LensQuickSwitcher | null = null;
  currentSort: string = 'default';

  
  constructor(leaf: WorkspaceLeaf, plugin: SmartConnections3DPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_3D;
  }

  getDisplayText(): string {
    return '3D Knowledge Graph';
  }

  getIcon(): string {
    return 'box';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('smart-3d-view');
    
    // Check for Smart Connections
    const smart_env = (window as any).smart_env;
    
    if (!smart_env) {
      container.createDiv({ 
        text: '⚠️ Smart Connections not found. Please install and enable Smart Connections plugin first.',
        cls: 'smart-3d-error'
      });
      return;
    }

    if (!smart_env.smart_sources?.items) {
      container.createDiv({ 
        text: '⚠️ No embeddings found. Please wait for Smart Connections to process your vault.',
        cls: 'smart-3d-error'
      });
      return;
    }

    // Create visualization
    await this.initVisualization(container, smart_env);
  }

    // --- helpers inside ThreeDView (or module scope) ---

private cosine(a: number[], b: number[]): number {
    const n = Math.min(a?.length ?? 0, b?.length ?? 0);
    if (n === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) { const ai=a[i], bi=b[i]; dot += ai*bi; na += ai*ai; nb += bi*bi; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }
  
  private parseTimeToken(v: string): {from?: number; to?: number} {
    // supports "30d", "7d", "2024-01..2024-03-31"
    const now = Date.now();
    const rel = /^(\d+)([dhm])$/i.exec(v);
    if (rel) {
      const n = parseInt(rel[1], 10); const unit = rel[2].toLowerCase();
      const ms = unit === 'd' ? n*864e5 : unit === 'h' ? n*36e5 : n*6e4;
      return { from: now - ms, to: now };
    }
    const range = /^(\d{4}-\d{2}-\d{2}|\d{4}-\d{2})(?:\.\.|-)(\d{4}-\d{2}-\d{2}|\d{4}-\d{2})$/.exec(v);
    const toMs = (s:string) => new Date(s.length===7 ? s+'-01' : s).getTime();
    if (range) return { from: toMs(range[1]), to: toMs(range[2]) };
    return {};
  }
  
  private getNodeTags(key: string): string[] {
    // best-effort tags (Smart Connections or Obsidian metadata if available)
    const env: any = (window as any).smart_env;
    const src = env?.smart_sources?.items?.[key];
    if (Array.isArray(src?.tags)) return src.tags.map((t: string)=>t.toLowerCase());
    // fallback: none
    return [];
  }
  
  private getNodeType(path: string): string {
    const dot = path.lastIndexOf('.');
    return dot > -1 ? path.slice(dot + 1).toLowerCase() : '';
  }

  private extractAllTags(nodes: NodeData[], smart_env: any): Set<string> {
    const tags = new Set<string>();
    nodes.forEach(node => {
      const nodeTags = this.getNodeTags(node.key);
      nodeTags.forEach(tag => tags.add(tag));
    });
    return tags;
  }

  private onFacetChange(ast: FacetRailAST) {
    console.log('Facet changed, updating visualization...');

    // Convert AST to tokens
    const facetTokens = ast.toOmniboxTokens();

    // Get current omnibox tokens (user-entered queries)
    const omniboxTokens = this.activeQueryTokens.filter(
      t => !t.id.startsWith('facet-')
    );

    // Merge facet tokens with omnibox tokens
    const mergedTokens = [...omniboxTokens, ...facetTokens];

    // Update active tokens and apply
    this.activeQueryTokens = mergedTokens;
    this.debouncedApply(mergedTokens);
  }

  private onLegendFilterChange(state: LegendFilterState) {
    console.log('Legend filter changed:', state);
    this.legendFilterState = state;
    this.applyLegendFilters();
  }

  private onFamilyChange(family: TagFamily) {
    console.log('Family changed:', family);
    if (this.colorStrategy) {
      this.colorStrategy.setActiveFamily(family);
      this.updateNodeColors();
      this.legend?.refresh();
    }
  }

  private applyLegendFilters() {
    if (!this.nodes || !this.colorStrategy) return;

    for (const mesh of this.nodes) {
      const data = mesh.userData as NodeData;
      const nodeTags = data.tags || [];

      // Check if node should be visible based on legend filters
      let visible = true;

      // Solo mode: only show nodes with solo tags
      if (this.legendFilterState.soloTags.size > 0) {
        visible = nodeTags.some(tag => this.legendFilterState.soloTags.has(tag));
      }

      // Mute mode: hide nodes with muted tags
      if (this.legendFilterState.mutedTags.size > 0) {
        const hasMutedTag = nodeTags.some(tag => this.legendFilterState.mutedTags.has(tag));
        if (hasMutedTag) visible = false;
      }

      mesh.visible = visible;
      const label = this.labels.get(mesh);
      if (label) label.visible = visible;
    }
  }

  private updateNodeColors() {
    if (!this.nodes || !this.colorStrategy) return;

    for (const mesh of this.nodes) {
      const data = mesh.userData as NodeData;
      const isHovered = this.hoveredNode === mesh;

      const visualState = this.colorStrategy.getNodeVisualState(
        data.tags || [],
        data.mtime,
        data.connections?.length || 0,
        data.pinCount || 0,
        data.isExtracted || false,
        isHovered
      );

      const mat = mesh.material as THREE.MeshPhongMaterial;
      mat.color.copy(visualState.fillColor);
      mat.emissive.copy(visualState.emissiveColor);
      mat.emissiveIntensity = visualState.emissiveIntensity * (1 + visualState.haloIntensity);

      // Update size
      const s = visualState.size;
      mesh.scale.set(s, s, s);

      // Store visual state for rendering
      (mesh.userData as any).visualState = visualState;
    }
  }

  /**
   * Capture current state as a lens
   */
  private captureCurrentLens(): Omit<Lens, 'id' | 'name' | 'created' | 'modified'> {
    const facetFilters = {
      timeWindow: (this.facetAST.getNode('time_window')?.value as string) || null,
      degreeLimit: (this.facetAST.getNode('degree_limit')?.value as string) || null,
      tagFamily: Array.from((this.facetAST.getNode('tag_family')?.value as Set<string>) || []),
      provenance: (this.facetAST.getNode('provenance')?.value as string) || 'all',
      similarityThreshold: (this.facetAST.getNode('similarity_threshold')?.value as number) || 0.3
    };

    const legendFilters = {
      soloTags: Array.from(this.legendFilterState.soloTags),
      mutedTags: Array.from(this.legendFilterState.mutedTags)
    };

    const layoutConfig = this.layout ? {
      semanticAttraction: this.layout.config.semanticAttraction,
      repulsion: this.layout.config.repulsion
    } : undefined;

    return {
      description: 'Saved lens',
      query: this.activeQueryTokens,
      facetFilters,
      legendFilters,
      colorFamily: this.colorStrategy?.getActiveFamily() || 'topic',
      colorblindMode: this.colorStrategy?.getConfig().colorblindMode || false,
      sort: this.currentSort as any,
      layoutConfig
    };
  }

  /**
   * Apply a lens to restore scene state
   */
  private applyLens(lens: Lens) {
    console.log('Applying lens:', lens.name);

    // Restore query tokens
    this.activeQueryTokens = [...lens.query];
    if (this.omnibox) {
      // Clear and rebuild omnibox tokens
      // Note: This would require extending Omnibox to support setTokens()
      // For now, we'll just update activeQueryTokens and apply
    }

    // Restore facet filters
    this.facetAST.setNode('time_window', lens.facetFilters.timeWindow);
    this.facetAST.setNode('degree_limit', lens.facetFilters.degreeLimit);
    this.facetAST.setNode('tag_family', new Set(lens.facetFilters.tagFamily));
    this.facetAST.setNode('provenance', lens.facetFilters.provenance);
    this.facetAST.setNode('similarity_threshold', lens.facetFilters.similarityThreshold);

    // Restore legend filters
    this.legendFilterState = {
      soloTags: new Set(lens.legendFilters.soloTags),
      mutedTags: new Set(lens.legendFilters.mutedTags)
    };
    this.applyLegendFilters();

    // Restore color family
    if (this.colorStrategy) {
      this.colorStrategy.setActiveFamily(lens.colorFamily);
      this.colorStrategy.setConfig({ colorblindMode: lens.colorblindMode });
      this.updateNodeColors();
    }

    // Restore sort
    this.currentSort = lens.sort;
    // Apply sort if needed (would require implementing sort logic)

    // Restore layout config
    if (lens.layoutConfig && this.layout) {
      this.layout.config.semanticAttraction = lens.layoutConfig.semanticAttraction;
      this.layout.config.repulsion = lens.layoutConfig.repulsion;
    }

    // Apply query filters
    this.debouncedApply(this.activeQueryTokens);

    // Update UI
    this.legend?.refresh();
    this.facetRail?.updateTags(this._allTags);

    // Mark as active
    this.lensManager.setActiveLens(lens.id);
  }

  /**
   * Save current state as new lens
   */
  private saveAsLens(name: string) {
    const config = this.captureCurrentLens();
    const lens = this.lensManager.createLens(name, config);
    console.log('Saved lens:', lens);
    return lens;
  }

  /**
   * Update existing lens with current state
   */
  private updateCurrentLens() {
    const activeLens = this.lensManager.getActiveLens();
    if (!activeLens) return;

    const config = this.captureCurrentLens();
    this.lensManager.updateLens(activeLens.id, config);
    console.log('Updated lens:', activeLens.name);
  }

  /**
   * Open lens quick switcher
   */
  private openLensQuickSwitcher() {
    if (this.quickSwitcher) return;

    this.quickSwitcher = new LensQuickSwitcher(this.lensManager, {
      onSelect: (lens) => {
        this.applyLens(lens);
      },
      onClose: () => {
        this.quickSwitcher = null;
      }
    });

    this.quickSwitcher.open();
  }
  
  // Call this from onOmniboxTokensChanged via a debounced wrapper
private applyQueryTokens(tokens: OmniboxToken[]) {
    if (!this.nodes) return;
  
    // Fast path: no tokens -> show all, reset styles
    if (!tokens || tokens.length === 0) {
      for (const mesh of this.nodes) {
        mesh.visible = true;
        const mat = mesh.material as THREE.MeshPhongMaterial;
        mat.emissiveIntensity = 0.5;
        mesh.scale.set(1,1,1);
        (mesh.userData as any).explain = [];
      }
      return;
    }
  
    console.log('Applying tokens to graph...', tokens);


    // Precompute semantic embedding if needed
    const semanticTexts: string[] = [];
    const negative: OmniboxToken[] = [];
    const positive: OmniboxToken[] = [];
  
    for (const t of tokens) {
      if ((t.operator === 'similar' || t.operator === 'describe') && typeof t.value === 'string') semanticTexts.push(t.value);
      // Tokens with 'not' operator are treated as negative
      (t.operator === 'not' ? negative : positive).push(t);
    }
  
    let queryEmbedding: number[] | null = null;
    const env: any = (window as any).smart_env;

    if (semanticTexts.length && typeof env?.embed === 'function') {
    const results = semanticTexts.map((s) => env.embed(s)).filter(Boolean);
    const hasPromise = results.some((r: any) => typeof r?.then === 'function');

    if (hasPromise) {
        // Kick off async embedding, then re-apply scoring when ready
        Promise.all(results).then((embs: number[][]) => {
        if (!Array.isArray(embs) || !embs.length) return;
        const avg = embs[0].slice();
        for (let i = 1; i < embs.length; i++) {
            for (let j = 0; j < avg.length; j++) avg[j] += embs[i][j];
        }
        for (let j = 0; j < avg.length; j++) avg[j] /= embs.length;
        this._lastQueryEmbedding = avg;

        // Re-run with the same tokens now that we have embeddings
        this.debouncedApply(this.activeQueryTokens);
        }).catch(() => { /* swallow */ });

        // Use the last cached embedding immediately (if any), so UI still reacts
        queryEmbedding = this._lastQueryEmbedding ?? null;
    } else {
        // Synchronous path
        const embs = results as number[][];
        if (embs.length) {
        queryEmbedding = embs[0].slice();
        for (let i = 1; i < embs.length; i++) {
            for (let j = 0; j < queryEmbedding.length; j++) queryEmbedding[j] += embs[i][j];
        }
        for (let j = 0; j < queryEmbedding.length; j++) queryEmbedding[j] /= embs.length;

        this._lastQueryEmbedding = queryEmbedding;
        }
    }
    }

  
    // Build predicate set
    const timeFilters = positive.filter(t => t.operator === 'time');
    const typeFilters = positive.filter(t => t.operator === 'type');
    const tagFilters  = positive.filter(t => t.operator === 'tag');
    const linkFilters = positive.filter(t => t.operator === 'link');
    const degreeFilters = positive.filter(t => t.operator === 'degree');
    
    // Evaluate per node
    for (const mesh of this.nodes) {
      const data = mesh.userData as NodeData;
      const reasons: string[] = [];
      let pass = true;
  
      // time
      for (const ft of timeFilters) {
        console.log('Checking time filter', ft.value, 'against', new Date(data.mtime).toISOString());
        const {from,to} = this.parseTimeToken(String(ft.value||''));
        if (from && data.mtime < from) { pass=false; break; }
        if (to   && data.mtime > to)   { pass=false; break; }
        if (from || to) reasons.push(`time:${ft.value}`);
      }
      if (!pass) { mesh.visible=false; continue; }
  
      // type
      if (typeFilters.length) {
        const typ = this.getNodeType(data.path);
        const ok = typeFilters.some(t => typ === String(t.value||'').toLowerCase());
        if (!ok) { mesh.visible=false; continue; }
        reasons.push(`type:${typ}`);
      }
  
      // tag
      if (tagFilters.length) {
        const tags = this.getNodeTags(data.key);
        const ok = tagFilters.every(t => tags.includes(String(t.value||'').toLowerCase()));
        if (!ok) { mesh.visible=false; continue; }
        for (const t of tagFilters) reasons.push(`tag:${t.value}`);
      }
  
      // link
      if (linkFilters.length) {
        const names = new Set([data.name.toLowerCase(), data.path.toLowerCase(), data.key.toLowerCase()]);
        const ok = linkFilters.every(t => {
          const q = String(t.value||'').toLowerCase();
          // match direct connections by key or by name/path substring of the *target*; here we only have target keys
          return data.connections?.some(k => k.toLowerCase().includes(q)) || names.has(q);
        });
        if (!ok) { mesh.visible=false; continue; }
        for (const t of linkFilters) reasons.push(`link:${t.value}`);
      }
  
      // degree
      if (degreeFilters.length) {
        const deg = data.connections?.length ?? 0;
        const ok = degreeFilters.every(t => {
          const v = Number(t.value); // support ">=2", "<=3", "==1", or raw "2"
          const raw = String(t.value||'').trim();
          if (/^>=\d+$/.test(raw)) return deg >= parseInt(raw.slice(2),10);
          if (/^<=\d+$/.test(raw)) return deg <= parseInt(raw.slice(2),10);
          if (/^==?\d+$/.test(raw)) return deg === parseInt(raw.replace('==',''),10);
          if (/^\d+$/.test(raw)) return deg === v;
          return true;
        });
        if (!ok) { mesh.visible=false; continue; }
        reasons.push(`degree:${data.connections?.length ?? 0}`);
      }
  
      // negative tokens (exclusions)
      for (const nt of negative) {
        const v = String(nt.value||'').toLowerCase();
        if (nt.operator==='tag' && this.getNodeTags(data.key).includes(v)) { pass=false; reasons.push(`not:tag:${v}`); break; }
        if (nt.operator==='type' && this.getNodeType(data.path)===v) { pass=false; reasons.push(`not:type:${v}`); break; }
        if (nt.operator==='link' && data.connections?.some(k=>k.toLowerCase().includes(v))) { pass=false; reasons.push(`not:link:${v}`); break; }
        if (nt.operator==='time') {
          const {from,to}=this.parseTimeToken(String(nt.value||'')); 
          if ((from && data.mtime>=from) || (to && data.mtime<=to)) { pass=false; reasons.push(`not:time:${nt.value}`); break; }
        }
      }
  
      mesh.visible = pass;

        const lbl = this.labels.get(mesh);
        if (lbl) lbl.visible = pass;

      if (!pass) continue;
  
      // highlight score
      let score = 0;
  
      // name contains free text tokens (any token with type 'text' / operatorless)
      for (const t of tokens) {
        if ((t.kind==='text' || t.operator==='describe') && typeof t.value === 'string') {
          const q = t.value.toLowerCase();
          if (data.name.toLowerCase().includes(q) || data.path.toLowerCase().includes(q)) {
            score += 0.25;
            reasons.push(`text:${q}`);
          }
        }
      }
  
      // semantic
      if (queryEmbedding) {
        const s = this.cosine(data.embedding, queryEmbedding);
        if (s > 0.3) { score += (s - 0.3) * 1.2; reasons.push(`similar:${s.toFixed(2)}`); }
      } else {
        // fallback: simple
        for (const t of tokens) {
          if (t.operator==='similar' && typeof t.value === 'string') {
            const q = t.value.toLowerCase();
            if (data.name.toLowerCase().includes(q)) { score += 0.3; reasons.push(`similar~name`); }
          }
        }
      }
  
      // Tag bump if any tag: token present and matched (already checked for filter); add small visual bias
      if (tagFilters.length) score += 0.1;
  
      // style
      const mat = mesh.material as THREE.MeshPhongMaterial;
      const intensity = THREE.MathUtils.clamp(0.5 + score, 0.3, 1.4);
      mat.emissiveIntensity = intensity;
      const s = THREE.MathUtils.clamp(1 + score * 0.6, 0.85, 1.6);
      mesh.scale.set(s, s, s);
  
      (mesh.userData as any).explain = reasons;
    }
  }

  private debouncedApply = this.debounce((tokens: OmniboxToken[]) => this.applyQueryTokens(tokens), 80);

    private debounce<T extends any[]>(fn: (...args: T)=>void, ms: number) {
    let id: number|undefined;
    return (...args: T) => {
        if (id) cancelAnimationFrame(id);
        const start = performance.now();
        id = requestAnimationFrame(() => {
        // simple time gate: ensure ~ms between executions
        if (performance.now() - start >= ms) fn(...args);
        else id = requestAnimationFrame(()=>fn(...args));
        });
    };
    }

  async initVisualization(container: HTMLElement, smart_env: any) {
    // Create facet rail (left side)
    const facetRailContainer = container.createDiv({ cls: 'facet-rail-container' }) as HTMLElement;

    // Create canvas container
    const canvasContainer = container.createDiv({ cls: 'smart-3d-canvas' }) as HTMLElement;

    // Create legend (right side)
    const legendContainer = container.createDiv({ cls: 'legend-container' }) as HTMLElement;

    // Create controls
    const controlsDiv = container.createDiv({ cls: 'smart-3d-controls' }) as HTMLElement;
    controlsDiv.innerHTML = `
      <h4>🎯 3D Knowledge Graph</h4>
      <div class="smart-omnibox-section">
        <div class="smart-omnibox-label">Query</div>
        <div id="smart-omnibox-root" class="smart-omnibox-mount"></div>
        <div class="smart-omnibox-helper">Operators: tag, type, time, link, similar, not, degree, describe</div>
      </div>

      <div class="lens-controls">
        <div class="lens-controls-header">
          <span class="lens-controls-label">Lens</span>
          <span id="lens-active-name" class="lens-active-name">None</span>
        </div>
        <div class="lens-controls-buttons">
          <button id="lens-switcher-btn" class="lens-btn" title="Quick Switcher (Ctrl+L)">👁️</button>
          <button id="lens-save-btn" class="lens-btn" title="Save Lens">💾</button>
          <button id="lens-update-btn" class="lens-btn" title="Update Current" disabled>🔄</button>
        </div>
      </div>

      <div id="status">Loading...</div>
      <div class="smart-3d-slider">
        <label>Semantic Force: <span id="semantic-value">0.08</span></label>
        <input type="range" id="semantic-slider" min="0" max="0.2" step="0.01" value="0.08" style="width: 100%;">
      </div>
      <div class="smart-3d-slider">
        <label>Repulsion: <span id="repulsion-value">500</span></label>
        <input type="range" id="repulsion-slider" min="100" max="1000" step="50" value="500" style="width: 100%;">
      </div>
      <button id="recompute-btn" class="mod-cta" style="width: 100%; margin-top: 10px;">Recompute Layout</button>
    `;

    const omniboxMount = controlsDiv.querySelector('#smart-omnibox-root') as HTMLElement | null;
    if (omniboxMount) {
      this.omnibox?.destroy();
      this.omnibox = new Omnibox(omniboxMount, {
        onChange: (tokens) => this.onOmniboxTokensChanged(tokens),
        placeholder: 'Search notes or use operators...',
      });
    }
    
    // Extract nodes from Smart Connections
    const nodes = await this.extractNodes(smart_env);

    if (nodes.length === 0) {
      controlsDiv.querySelector('#status')!.textContent = 'No notes with embeddings found';
      return;
    }

    controlsDiv.querySelector('#status')!.textContent = `Found ${nodes.length} notes`;

    // Extract all tags from nodes
    this._allTags = this.extractAllTags(nodes, smart_env);

    // Initialize color strategy
    const allNodeTags = nodes.flatMap(n => n.tags);
    this.colorStrategy = new ColorStrategy({
      maxVisibleTags: 12,
      colorblindMode: false,
      activeFamily: 'topic'
    });
    this.colorStrategy.registerTags(allNodeTags);

    // Initialize facet rail
    this.facetRail = new FacetRail(facetRailContainer, this.facetAST, {
      onChange: (ast) => this.onFacetChange(ast),
      allTags: this._allTags
    });

    // Initialize legend
    this.legend = new Legend(legendContainer, {
      colorStrategy: this.colorStrategy,
      onFilterChange: (state) => this.onLegendFilterChange(state),
      onFamilyChange: (family) => this.onFamilyChange(family)
    });
    
    // Initialize Three.js
    this.initThreeJS(canvasContainer, nodes);
    
    // Setup controls
    this.setupControls(controlsDiv, nodes);

    // Setup lens controls
    this.setupLensControls(controlsDiv);

    // Try to restore active lens
    const activeLens = this.lensManager.getActiveLens();
    if (activeLens) {
      this.applyLens(activeLens);
      this.updateLensUI(activeLens.name);
    }
  }

  async extractNodes(smart_env: any): Promise<NodeData[]> {
    // Ensure SC has finished indexing (the other plugin waits for this)
    try {
      let guard = 0;
      while (!smart_env?.collections_loaded && guard++ < 50) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch {}
  
    const items = smart_env.smart_sources?.items ?? {};
    const nodes: NodeData[] = [];
    const options = { limit: 12, threshold: 0.5 }; // looser threshold = more edges while testing

  
    // helper: await thenables, not just native Promises
    const awaitMaybe = async <T>(v: any): Promise<T> =>
      (v && typeof v.then === 'function') ? await v : v;
  
    // looser while testing so edges show up
    const defaultFindOpts = { limit: 12, threshold: 0.4 };
  
    // build once so we can validate neighbor keys later
    const allNoteKeys = new Set(Object.keys(items));
  
    let count = 0
    for (const [key, src] of Object.entries(items)) {
      const s = src as any;
      if (!Array.isArray(s?.vec) || s.vec.length === 0) continue;
  
      const connections: string[] = [];
        try {
        let res: any;
        if (typeof s.find_connections === 'function') {
            res = await awaitMaybe(s.find_connections(options));
        } else if (typeof smart_env.smart_sources?.find_connections === 'function') {
            res = await awaitMaybe(smart_env.smart_sources.find_connections(key, options));
        }
        if (Array.isArray(res)) {
            for (const conn of res) {
            // map SmartBlock -> its parent note
            const item = conn?.item;

            const candidateNoteKey =
                item?.note_key ?? item?.source_key ?? item?.note?.key ?? null;

            // last-resort fallback if the neighbor is already a note
            const candidateRawKey = conn?.key ?? item?.key ?? null;

            const neighbor =
                (candidateNoteKey && allNoteKeys.has(candidateNoteKey)) ? candidateNoteKey :
                (candidateRawKey   && allNoteKeys.has(candidateRawKey)) ? candidateRawKey   :
                null;

            if (neighbor) connections.push(neighbor);

            // dev probe (first few only)
            // if (connections.length < 3) console.log('[SC-3D] conn fields', {
            //   key: conn?.key, itemKey: item?.key, note_key: item?.note_key, source_key: item?.source_key
            // });
            }
        }
        } catch (e) {
        console.warn('find_connections failed for', key, e);
        }
  
      // Extract tags
      const tags = Array.isArray(s.tags) ? s.tags.map((t: string) => t.toLowerCase()) : [];

      // Check if extracted (heuristic: no manual tags or marked as extracted)
      const isExtracted = s.is_extracted === true || (tags.length === 0 && s.auto_generated === true);

      // Pin count (if available from Smart Connections)
      const pinCount = s.pin_count || s.pins || 0;

      nodes.push({
        key,
        name: s.name || s.path || key,
        path: s.path || key,
        embedding: s.vec,
        mtime: s.mtime || Date.now(),
        size: s.size || 0,
        connections,
        tags,
        pinCount,
        isExtracted
      });
    }
  
    // quick probe + summary
    const withEdges = nodes.filter(n => n.connections.length > 0).length;
    console.log('[SC-3D] nodes:', nodes.length, 'nodesWithConnections:', withEdges);
  
    if (nodes[0]) {
      try {
        const probe = await awaitMaybe(
          (items[nodes[0].key] as any)?.find_connections?.(defaultFindOpts) ??
          smart_env.smart_sources?.find_connections?.(nodes[0].key, defaultFindOpts)
        );
        console.log('[SC-3D] probe for', nodes[0].key, '→', probe);
      } catch (e) {
        console.warn('[SC-3D] probe failed', e);
      }
    }
  
    return nodes;
  }
  

  initThreeJS(container: HTMLElement, nodes: NodeData[]) {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e27);
    this.scene.fog = new THREE.Fog(0x0a0e27, 80, 600);
    
    // Camera
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 30, 100);
    
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // Orbit controls for intuitive navigation
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.panSpeed = 0.4;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 400;
    this.controls.zoomSpeed = 0.9;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    
    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 2);
    this.scene.add(ambient);
    
    const point = new THREE.PointLight(0x6495ff, 2, 200);
    point.position.set(0, 0, 50);
    this.scene.add(point);
    
    // Compute layout
    this.layout = new SemanticLayout(nodes);
    const positions = this.layout.compute(100);
    
    // Create nodes
    this.createNodes(nodes, positions);

    console.log('Loaded nodes:', nodes.length, 'with connections:',
        nodes.filter(n => n.connections.length > 0).length);

    this.createEdges(nodes);


    this.applyQueryTokens(this.activeQueryTokens)
    
    // Setup interaction
    this.setupInteraction(container);
    
    // Start animation
    this.animate();
    
    // Handle resize
    this.resizeObserver = new ResizeObserver(() => {
      if (this.camera && this.renderer) {
        this.camera.aspect = container.clientWidth / container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(container.clientWidth, container.clientHeight);
      }
    });
    this.resizeObserver.observe(container);
  }
  
  private createEdges(_nodes: NodeData[]) {
    if (!this.scene) return;
  
    const keyToNode = new Map<string, THREE.Mesh>();
    this.nodes.forEach(m => keyToNode.set((m.userData as NodeData).key, m));
  
    const positions: number[] = [];
    const seen = new Set<string>(); // avoid duplicates
  
    for (const mesh of this.nodes) {
      const data = mesh.userData as NodeData;
      for (const tgt of data.connections ?? []) {
        const other = keyToNode.get(tgt);
        if (!other) continue;
        const id = [data.key, tgt].sort().join('|');
        if (seen.has(id)) continue;
        seen.add(id);
        positions.push(
          mesh.position.x, mesh.position.y, mesh.position.z,
          other.position.x, other.position.y, other.position.z
        );
      }
    }
  
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x6495ff, transparent: true, opacity: 0.3 });
    const lines = new THREE.LineSegments(geom, mat);
    this.scene.add(lines);
    this.edges = lines;
  
    console.log('[SC-3D] edges built:', positions.length / 6, 'segments');
  }
  

  createNodes(nodesData: NodeData[], positions: Map<string, Vec3>) {
    if (!this.scene || !this.colorStrategy) return;

    nodesData.forEach(data => {
      const pos = positions.get(data.key);
      if (!pos) return;

      // Get visual state from color strategy
      const visualState = this.colorStrategy!.getNodeVisualState(
        data.tags || [],
        data.mtime,
        data.connections?.length || 0,
        data.pinCount || 0,
        data.isExtracted || false,
        false
      );

      const geometry = new THREE.SphereGeometry(visualState.size, 16, 16);
      const material = new THREE.MeshPhongMaterial({
        color: visualState.fillColor,
        emissive: visualState.emissiveColor,
        emissiveIntensity: visualState.emissiveIntensity * (1 + visualState.haloIntensity),
        transparent: true,
        opacity: 0.9
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.userData = data;
      (mesh.userData as any).visualState = visualState;

      this.scene!.add(mesh);
      this.nodes.push(mesh);

      const label = this.createLabelSprite(data.name);
      label.position.set(pos.x, pos.y + 1.8, pos.z);
      this.scene!.add(label);
      this.labels.set(mesh, label);
    });
  }

  setupInteraction(container: HTMLElement) {
    if (!this.renderer || !this.camera) return;
    
    const canvas = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hoveredNode: THREE.Mesh | null = null;
    
    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'smart-3d-tooltip';
    tooltip.style.position = 'fixed';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.top = '0';
    tooltip.style.left = '0';
    tooltip.style.transform = 'translate3d(-9999px,-9999px,0)'; // start offscreen
    document.body.appendChild(tooltip);
    
    // Mouse move for hover
    const updateHover = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, this.camera!);
      const intersects = raycaster.intersectObjects(this.nodes);

      // Reset previous hovered node
      if (hoveredNode) {
        this.hoveredNode = null;
        // Restore original state
        const prevData = hoveredNode.userData as NodeData;
        if (this.colorStrategy) {
          const visualState = this.colorStrategy.getNodeVisualState(
            prevData.tags || [],
            prevData.mtime,
            prevData.connections?.length || 0,
            prevData.pinCount || 0,
            prevData.isExtracted || false,
            false
          );
          const mat = hoveredNode.material as THREE.MeshPhongMaterial;
          mat.emissiveIntensity = visualState.emissiveIntensity * (1 + visualState.haloIntensity);
          const s = visualState.size;
          hoveredNode.scale.set(s, s, s);
        }
      }

      if (intersects.length > 0) {
        hoveredNode = intersects[0].object as THREE.Mesh;
        this.hoveredNode = hoveredNode;

        const data = hoveredNode.userData as NodeData;

        // Update visual state with hover
        if (this.colorStrategy) {
          const visualState = this.colorStrategy.getNodeVisualState(
            data.tags || [],
            data.mtime,
            data.connections?.length || 0,
            data.pinCount || 0,
            data.isExtracted || false,
            true // isHovered = true
          );

          const mat = hoveredNode.material as THREE.MeshPhongMaterial;
          mat.emissiveIntensity = 1.2 * (1 + visualState.haloIntensity);

          // Add outline glow for multi-tag nodes
          if (visualState.outlineColor && visualState.outlineGlowIntensity) {
            // Store outline color for rendering (we'll handle this in animate())
            (hoveredNode.userData as any).outlineColor = visualState.outlineColor;
            (hoveredNode.userData as any).outlineGlowIntensity = visualState.outlineGlowIntensity;
          }

          const s = visualState.size * 1.3; // Scale up on hover
          hoveredNode.scale.set(s, s, s);
        }

        tooltip.textContent = data.name;
        tooltip.style.display = 'block';
        tooltip.style.left = e.clientX + 10 + 'px';
        tooltip.style.top = e.clientY + 10 + 'px';
        canvas.style.cursor = 'pointer';
      } else {
        hoveredNode = null;
        this.hoveredNode = null;
        tooltip.style.display = 'none';
        canvas.style.cursor = 'grab';
      }
    };
    canvas.addEventListener('mousemove', updateHover);
    canvas.addEventListener('mouseleave', () => {
      hoveredNode = null;
      tooltip.style.display = 'none';
      canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('click', () => {
        raycaster.setFromCamera(mouse, this.camera!);
        const hit = raycaster.intersectObjects(this.nodes)[0];
        if (hit) {
          const info = (hit.object.userData as any).explain || [];
          console.info('Explain:', hit.object.userData.name, info);
          this.openNote((hit.object.userData as NodeData).path);
        }
      });
    
    // // Click to open note
    // canvas.addEventListener('click', () => {
    //   raycaster.setFromCamera(mouse, this.camera!);
    //   const intersects = raycaster.intersectObjects(this.nodes);
      
    //   if (intersects.length > 0) {
    //     const data = (intersects[0].object as THREE.Mesh).userData as NodeData;
    //     this.openNote(data.path);
    //   }
    // });
    
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', () => {
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointerup', () => {
      canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    });
    this.controls?.addEventListener('start', () => {
      canvas.style.cursor = 'grabbing';
    });
    this.controls?.addEventListener('end', () => {
      canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    });
  }

  setupLensControls(controlsDiv: HTMLElement) {
    const switcherBtn = controlsDiv.querySelector('#lens-switcher-btn') as HTMLButtonElement;
    const saveBtn = controlsDiv.querySelector('#lens-save-btn') as HTMLButtonElement;
    const updateBtn = controlsDiv.querySelector('#lens-update-btn') as HTMLButtonElement;

    // Quick switcher
    switcherBtn?.addEventListener('click', () => {
      this.openLensQuickSwitcher();
    });

    // Save lens
    saveBtn?.addEventListener('click', () => {
      const name = prompt('Enter lens name:');
      if (name) {
        const lens = this.saveAsLens(name);
        this.updateLensUI(lens.name);
        if (updateBtn) updateBtn.disabled = false;
      }
    });

    // Update lens
    updateBtn?.addEventListener('click', () => {
      this.updateCurrentLens();
    });

    // Keyboard shortcut for quick switcher (Ctrl/Cmd + L)
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        this.openLensQuickSwitcher();
      }
    });
  }

  updateLensUI(lensName: string | null) {
    const nameEl = document.querySelector('#lens-active-name') as HTMLElement;
    const updateBtn = document.querySelector('#lens-update-btn') as HTMLButtonElement;

    if (nameEl) {
      nameEl.textContent = lensName || 'None';
    }

    if (updateBtn) {
      updateBtn.disabled = !lensName;
    }
  }

  setupControls(controlsDiv: HTMLElement, nodes: NodeData[]) {
    const semanticSlider = controlsDiv.querySelector('#semantic-slider') as HTMLInputElement;
    const semanticValue = controlsDiv.querySelector('#semantic-value') as HTMLElement;
    const repulsionSlider = controlsDiv.querySelector('#repulsion-slider') as HTMLInputElement;
    const repulsionValue = controlsDiv.querySelector('#repulsion-value') as HTMLElement;
    const recomputeBtn = controlsDiv.querySelector('#recompute-btn') as HTMLButtonElement;
    const status = controlsDiv.querySelector('#status') as HTMLElement;
    
    semanticSlider.addEventListener('input', () => {
      const val = parseFloat(semanticSlider.value);
      semanticValue.textContent = val.toFixed(2);
      if (this.layout) {
        this.layout.config.semanticAttraction = val;
      }
    });
    
    repulsionSlider.addEventListener('input', () => {
      const val = parseFloat(repulsionSlider.value);
      repulsionValue.textContent = val.toString();
      if (this.layout) {
        this.layout.config.repulsion = val;
      }
    });
    
    recomputeBtn.addEventListener('click', () => {
      if (!this.layout || !this.scene) return;
      
      status.textContent = 'Recomputing...';
      recomputeBtn.disabled = true;
      
      // Clear old nodes
      this.nodes.forEach(node => {
        this.scene!.remove(node);
        node.geometry.dispose();
        (node.material as THREE.Material).dispose();
        const label = this.labels.get(node);
        if (label) {
          this.scene!.remove(label);
          const map = (label.material as THREE.SpriteMaterial).map;
          map?.dispose();
          label.material.dispose();
          this.labels.delete(node);
        }
      });
      this.nodes = [];
      
      // Recompute
      this.layout.reset();
      setTimeout(() => {
        const positions = this.layout!.compute(100);
        this.createNodes(nodes, positions);
        this.applyQueryTokens(this.activeQueryTokens);   // <- add this
        status.textContent = `${nodes.length} notes`;
        recomputeBtn.disabled = false;
      }, 50);
    });
  }


  private onOmniboxTokensChanged(tokens: OmniboxToken[]) {
    console.log('onOmniboxTokensChanged fired:', tokens);

    // Update AST from omnibox tokens (bidirectional binding)
    this.facetAST.fromOmniboxTokens(tokens);

    // Get facet tokens
    const facetTokens = this.facetAST.toOmniboxTokens();

    // Get non-facet tokens (user-entered queries)
    const userTokens = tokens.filter(t => !t.id.startsWith('facet-'));

    // Merge
    const mergedTokens = [...userTokens, ...facetTokens];

    this.activeQueryTokens = mergedTokens;
    this.debouncedApply(mergedTokens);
    }

  openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.app.workspace.getLeaf().openFile(file);
    }
  }

  animate() {
    if (!this.scene || !this.camera || !this.renderer) return;
    
    this.animationId = requestAnimationFrame(() => this.animate());
    
    if (this.controls) {
      this.controls.update();
    }
    
    this.nodes.forEach(node => {
      const label = this.labels.get(node);
      if (!label || !this.camera) return;
      const distance = this.camera.position.distanceTo(node.position);
      label.visible = node.visible && distance < 45;
      label.position.set(node.position.x, node.position.y + 1.8, node.position.z);
      const scale = THREE.MathUtils.clamp((50 - distance) / 25, 0.45, 1.2);
      label.scale.setScalar(scale);
    });
    
    if (this.edges) {
        const geom = this.edges.geometry as THREE.BufferGeometry;
        const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
        const arr = posAttr.array as Float32Array;
        let i = 0;
      
        const keyToNode = new Map<string, THREE.Mesh>();
        this.nodes.forEach(n => keyToNode.set((n.userData as NodeData).key, n));
      
        const seen = new Set<string>(); // ✅ avoids duplicate edges
        for (const mesh of this.nodes) {
          const data = mesh.userData as NodeData;
          if (!data.connections) continue;
          for (const targetKey of data.connections) {
            const target = keyToNode.get(targetKey);
            if (!target) continue;
            const edgeId = [data.key, targetKey].sort().join('|');
            if (seen.has(edgeId)) continue;
            seen.add(edgeId);
            if (!mesh.visible || !target.visible) continue;
            const p1 = mesh.position;
            const p2 = target.position;
            arr[i++] = p1.x; arr[i++] = p1.y; arr[i++] = p1.z;
            arr[i++] = p2.x; arr[i++] = p2.y; arr[i++] = p2.z;
          }
        }
      
        // Clear leftover data in buffer so invisible edges don’t flicker
        for (; i < arr.length; i++) arr[i] = 0;
        posAttr.needsUpdate = true;
      }
      
      
    this.renderer.render(this.scene, this.camera);
  }

  async onClose() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    
    if (this.renderer) {
      this.renderer.dispose();
    }
    
    this.controls?.dispose();
    this.controls = null;
    
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    
    this.nodes.forEach(node => {
      node.geometry.dispose();
      (node.material as THREE.Material).dispose();
    });
    
    this.labels.forEach(label => {
      const map = (label.material as THREE.SpriteMaterial).map;
      map?.dispose();
      label.material.dispose();
    });
    this.labels.clear();

    this.omnibox?.destroy();
    this.omnibox = null;
    this.activeQueryTokens = [];

    this.facetRail?.destroy();
    this.facetRail = null;

    this.legend?.destroy();
    this.legend = null;
  }

  createLabelSprite(text: string): THREE.Sprite {
    const padding = 16;
    const fontSize = 42;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      const material = new THREE.SpriteMaterial({ color: 0xffffff });
      return new THREE.Sprite(material);
    }
    
    context.font = `600 ${fontSize}px Inter, sans-serif`;
    const textMetrics = context.measureText(text);
    const textWidth = textMetrics.width;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.ceil((textWidth + padding * 2) * scale);
    canvas.height = Math.ceil((fontSize + padding * 2) * scale);
    
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const material = new THREE.SpriteMaterial({ color: 0xffffff });
      return new THREE.Sprite(material);
    }
    
    ctx.scale(scale, scale);
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(10, 14, 39, 0.82)';
    ctx.strokeStyle = 'rgba(100, 149, 255, 0.9)';
    ctx.lineWidth = 2;
    const radius = 10;
    const width = textWidth + padding * 2;
    const height = fontSize + padding * 2;
    
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(width - radius, 0);
    ctx.quadraticCurveTo(width, 0, width, radius);
    ctx.lineTo(width, height - radius);
    ctx.quadraticCurveTo(width, height, width - radius, height);
    ctx.lineTo(radius, height);
    ctx.quadraticCurveTo(0, height, 0, height - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padding, height / 2);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    
    const sprite = new THREE.Sprite(material);
    sprite.center.set(0.5, 0);
    sprite.scale.setScalar(0.5);
    
    return sprite;
  }
}

// Semantic Layout Algorithm (simplified for plugin)
class SemanticLayout {
  nodes: NodeData[];
  positions: Map<string, Vec3>;
  velocities: Map<string, Vec3>;
  config: {
    semanticAttraction: number;
    repulsion: number;
    damping: number;
    timeStep: number;
  };
  
  constructor(nodes: NodeData[]) {
    this.nodes = nodes;
    this.positions = new Map();
    this.velocities = new Map();
    this.config = {
      semanticAttraction: 0.08,
      repulsion: 500,
      damping: 0.85,
      timeStep: 0.1
    };
    this.initPositions();
  }
  
  initPositions() {
    this.nodes.forEach((node, i) => {
      const angle = i * 2.4;
      const radius = Math.sqrt(i) * 3;
      const timeNorm = (node.mtime - Date.now() + 365*24*60*60*1000) / (365*24*60*60*1000);
      
      this.positions.set(node.key, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: (timeNorm - 0.5) * 40
      });
      this.velocities.set(node.key, { x: 0, y: 0, z: 0 });
    });
  }
  
  cosineSim(a: number[], b: number[]): number {
    if (!a || !b || !a.length || !b.length) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
  
  iterate() {
    const forces = new Map<string, Vec3>();
    this.nodes.forEach(n => forces.set(n.key, { x: 0, y: 0, z: 0 }));
    
    // Semantic + Repulsion forces
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const n1 = this.nodes[i], n2 = this.nodes[j];
        if (!n1 || !n2) continue;
        
        const p1 = this.positions.get(n1.key)!;
        const p2 = this.positions.get(n2.key)!;
        
        const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
        const distSq = dx*dx + dy*dy + dz*dz;
        const dist = Math.sqrt(distSq) || 0.1;
        
        const f1 = forces.get(n1.key)!;
        const f2 = forces.get(n2.key)!;
        
        // Repulsion
        const repForce = this.config.repulsion / distSq;
        f1.x -= dx/dist * repForce; f1.y -= dy/dist * repForce; f1.z -= dz/dist * repForce;
        f2.x += dx/dist * repForce; f2.y += dy/dist * repForce; f2.z += dz/dist * repForce;
        
        // Semantic attraction
        const sim = this.cosineSim(n1.embedding, n2.embedding);
        if (sim > 0.6) {
          const semForce = this.config.semanticAttraction * sim * (dist - 15);
          f1.x += dx/dist * semForce; f1.y += dy/dist * semForce; f1.z += dz/dist * semForce;
          f2.x -= dx/dist * semForce; f2.y -= dy/dist * semForce; f2.z -= dz/dist * semForce;
        }
      }
    }
    
    // Update positions
    forces.forEach((force, key) => {
      const pos = this.positions.get(key)!;
      const vel = this.velocities.get(key)!;
      
      vel.x = vel.x * this.config.damping + force.x * this.config.timeStep;
      vel.y = vel.y * this.config.damping + force.y * this.config.timeStep;
      vel.z = vel.z * this.config.damping + force.z * this.config.timeStep;
      
      pos.x += vel.x * this.config.timeStep;
      pos.y += vel.y * this.config.timeStep;
      pos.z += vel.z * this.config.timeStep;
    });
  }
  
  compute(iterations: number): Map<string, Vec3> {
    for (let i = 0; i < iterations; i++) {
      this.iterate();
    }
    return this.positions;
  }
  
  reset() {
    this.initPositions();
    this.velocities.clear();
    this.nodes.forEach(node => {
      this.velocities.set(node.key, { x: 0, y: 0, z: 0 });
    });
  }
  
}
