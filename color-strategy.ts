import * as THREE from 'three';

/**
 * Tag Family Types
 */
export type TagFamily = 'topic' | 'status' | 'project' | 'person' | 'source';

/**
 * Tag metadata with color information
 */
export interface TagColorInfo {
  tag: string;
  family: TagFamily;
  hue: number;
  color: THREE.Color;
  count: number;
}

/**
 * Color Strategy Configuration
 */
export interface ColorStrategyConfig {
  maxVisibleTags: number; // Cap on visible tags per family
  colorblindMode: boolean; // Enable patterns/shapes instead of colors
  activeFamily: TagFamily; // Currently active tag family
}

/**
 * Node Visual State
 */
export interface NodeVisualState {
  fillColor: THREE.Color;
  emissiveColor: THREE.Color;
  emissiveIntensity: number;
  outlineColor?: THREE.Color;
  outlineGlowIntensity?: number;
  size: number;
  haloIntensity: number; // For recency
  pattern?: string; // For colorblind mode
  shape?: string; // For colorblind mode
  dottedOutline?: boolean; // For extracted provenance
}

/**
 * Tag Family Definitions
 * Define how to identify tags belonging to each family
 */
const TAG_FAMILY_PREFIXES: Record<TagFamily, string[]> = {
  topic: ['topic/', 'category/', 'area/'],
  status: ['status/', 'state/'],
  project: ['project/', 'proj/'],
  person: ['person/', 'people/', 'author/'],
  source: ['source/', 'from/']
};

/**
 * Base hues for each family (0-360)
 */
const FAMILY_BASE_HUES: Record<TagFamily, number> = {
  topic: 210,    // Blue
  status: 120,   // Green
  project: 280,  // Purple
  person: 30,    // Orange
  source: 180    // Cyan
};

/**
 * Colorblind-safe patterns
 */
export const PATTERNS = [
  'solid',
  'dots',
  'stripes',
  'grid',
  'diagonal',
  'crosshatch'
];

/**
 * Colorblind-safe shapes
 */
export const SHAPES = [
  'sphere',
  'box',
  'octahedron',
  'tetrahedron',
  'dodecahedron',
  'icosahedron'
];

/**
 * ColorStrategy - Manages node coloring based on tag families
 */
export class ColorStrategy {
  private config: ColorStrategyConfig;
  private tagRegistry: Map<string, TagColorInfo> = new Map();
  private familyTags: Map<TagFamily, Set<string>> = new Map();
  private tagCounts: Map<string, number> = new Map();

  constructor(config: Partial<ColorStrategyConfig> = {}) {
    this.config = {
      maxVisibleTags: 12,
      colorblindMode: false,
      activeFamily: 'topic',
      ...config
    };

    // Initialize family maps
    Object.keys(TAG_FAMILY_PREFIXES).forEach(family => {
      this.familyTags.set(family as TagFamily, new Set());
    });
  }

  /**
   * Register tags from nodes
   */
  registerTags(tags: string[]) {
    tags.forEach(tag => {
      const family = this.inferTagFamily(tag);
      const familySet = this.familyTags.get(family);
      if (familySet) {
        familySet.add(tag);
      }

      // Increment count
      this.tagCounts.set(tag, (this.tagCounts.get(tag) || 0) + 1);

      // Assign color if not already assigned
      if (!this.tagRegistry.has(tag)) {
        this.assignTagColor(tag, family);
      }
    });
  }

  /**
   * Infer which family a tag belongs to based on prefix
   */
  private inferTagFamily(tag: string): TagFamily {
    const lowerTag = tag.toLowerCase();

    for (const [family, prefixes] of Object.entries(TAG_FAMILY_PREFIXES)) {
      if (prefixes.some(prefix => lowerTag.startsWith(prefix))) {
        return family as TagFamily;
      }
    }

    // Default to topic if no prefix matches
    return 'topic';
  }

  /**
   * Assign a color to a tag based on its family
   */
  private assignTagColor(tag: string, family: TagFamily) {
    const familySet = this.familyTags.get(family);
    if (!familySet) return;

    const baseHue = FAMILY_BASE_HUES[family];
    const familySize = familySet.size;
    const tagIndex = Array.from(familySet).indexOf(tag);

    // Distribute hues within a 60-degree range around base hue
    const hueOffset = (tagIndex / Math.max(familySize, 1)) * 60 - 30;
    const hue = (baseHue + hueOffset + 360) % 360;

    const color = new THREE.Color().setHSL(hue / 360, 0.7, 0.6);

    this.tagRegistry.set(tag, {
      tag,
      family,
      hue,
      color,
      count: this.tagCounts.get(tag) || 0
    });
  }

  /**
   * Get visual state for a node based on its tags
   */
  getNodeVisualState(
    tags: string[],
    mtime: number,
    connections: number,
    pinCount: number = 0,
    isExtracted: boolean = false,
    isHovered: boolean = false
  ): NodeVisualState {
    // Filter tags by active family
    const relevantTags = tags
      .filter(tag => this.inferTagFamily(tag) === this.config.activeFamily)
      .sort((a, b) => {
        // Sort by count (most common first)
        const countA = this.tagCounts.get(a) || 0;
        const countB = this.tagCounts.get(b) || 0;
        return countB - countA;
      });

    // Primary tag determines fill color
    const primaryTag = relevantTags[0];
    const primaryInfo = primaryTag ? this.tagRegistry.get(primaryTag) : null;

    // Default color if no tags
    const fillColor = primaryInfo?.color || new THREE.Color(0.5, 0.5, 0.7);
    const emissiveColor = fillColor.clone();

    // Recency-based halo intensity
    const age = (Date.now() - mtime) / (365 * 24 * 60 * 60 * 1000);
    const haloIntensity = Math.max(0, 1 - age); // Fades over 1 year

    // Size based on in-degree or pin count
    const sizeMultiplier = 1 + Math.log(1 + connections) * 0.15 + pinCount * 0.1;
    const size = 0.6 * sizeMultiplier;

    // Base state
    const state: NodeVisualState = {
      fillColor,
      emissiveColor,
      emissiveIntensity: 0.5,
      size,
      haloIntensity,
      dottedOutline: isExtracted
    };

    // Multi-tag outline glow (secondary tags)
    if (relevantTags.length > 1 && isHovered) {
      // Cycle through secondary tags on hover
      const secondaryTag = relevantTags[1];
      const secondaryInfo = this.tagRegistry.get(secondaryTag);
      if (secondaryInfo) {
        state.outlineColor = secondaryInfo.color;
        state.outlineGlowIntensity = 0.8;
      }
    }

    // Colorblind mode overrides
    if (this.config.colorblindMode) {
      const tagIndex = primaryTag ? Array.from(this.familyTags.get(this.config.activeFamily) || []).indexOf(primaryTag) : 0;
      state.pattern = PATTERNS[tagIndex % PATTERNS.length];
      state.shape = SHAPES[tagIndex % SHAPES.length];
    }

    return state;
  }

  /**
   * Get all tags for a specific family
   */
  getTagsForFamily(family: TagFamily): TagColorInfo[] {
    const familySet = this.familyTags.get(family);
    if (!familySet) return [];

    return Array.from(familySet)
      .map(tag => this.tagRegistry.get(tag))
      .filter((info): info is TagColorInfo => info !== undefined)
      .sort((a, b) => b.count - a.count); // Sort by count descending
  }

  /**
   * Get visible tags (capped at maxVisibleTags)
   */
  getVisibleTags(family: TagFamily): TagColorInfo[] {
    const allTags = this.getTagsForFamily(family);
    return allTags.slice(0, this.config.maxVisibleTags);
  }

  /**
   * Get overflow tags (beyond maxVisibleTags)
   */
  getOverflowTags(family: TagFamily): TagColorInfo[] {
    const allTags = this.getTagsForFamily(family);
    return allTags.slice(this.config.maxVisibleTags);
  }

  /**
   * Get total count of overflow tags
   */
  getOverflowCount(family: TagFamily): number {
    return this.getOverflowTags(family).reduce((sum, info) => sum + info.count, 0);
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ColorStrategyConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ColorStrategyConfig {
    return { ...this.config };
  }

  /**
   * Get tag info by tag name
   */
  getTagInfo(tag: string): TagColorInfo | undefined {
    return this.tagRegistry.get(tag);
  }

  /**
   * Get all registered tags
   */
  getAllTags(): TagColorInfo[] {
    return Array.from(this.tagRegistry.values())
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Update tag count
   */
  updateTagCount(tag: string) {
    const count = (this.tagCounts.get(tag) || 0) + 1;
    this.tagCounts.set(tag, count);

    const info = this.tagRegistry.get(tag);
    if (info) {
      info.count = count;
    }
  }

  /**
   * Check if a node has tags in the active family
   */
  hasActiveFamily(tags: string[]): boolean {
    return tags.some(tag => this.inferTagFamily(tag) === this.config.activeFamily);
  }

  /**
   * Get active family
   */
  getActiveFamily(): TagFamily {
    return this.config.activeFamily;
  }

  /**
   * Set active family
   */
  setActiveFamily(family: TagFamily) {
    this.config.activeFamily = family;
  }
}
