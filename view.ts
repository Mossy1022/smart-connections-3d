import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type SmartConnections3DPlugin from './main';

const VIEW_TYPE_3D = 'smart-3d-view';

interface NodeData {
  key: string;
  name: string;
  path: string;
  embedding: number[];
  mtime: number;
  size: number;
  connections: string[];
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

  async initVisualization(container: HTMLElement, smart_env: any) {
    // Create canvas container
    const canvasContainer = container.createDiv({ cls: 'smart-3d-canvas' }) as HTMLElement;
    
    // Create controls
    const controlsDiv = container.createDiv({ cls: 'smart-3d-controls' }) as HTMLElement;
    controlsDiv.innerHTML = `
      <h4>🎯 3D Knowledge Graph</h4>
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
    
    // Extract nodes from Smart Connections
    const nodes = this.extractNodes(smart_env);
    
    if (nodes.length === 0) {
      controlsDiv.querySelector('#status')!.textContent = 'No notes with embeddings found';
      return;
    }
    
    controlsDiv.querySelector('#status')!.textContent = `Found ${nodes.length} notes`;
    
    // Initialize Three.js
    this.initThreeJS(canvasContainer, nodes);
    
    // Setup controls
    this.setupControls(controlsDiv, nodes);
  }

  extractNodes(smart_env: any): NodeData[] {
    const sources = smart_env.smart_sources.items;
    const nodes: NodeData[] = [];
    
    for (const [key, source] of Object.entries(sources)) {
      const s = source as any;
      
      if (!s.vec || s.vec.length === 0) continue;
      
      // Find connections using Smart Connections API
      const connections: string[] = [];
      try {
        const nearest = smart_env.smart_sources.find_connections?.(key, {
          limit: 10,
          threshold: 0.7
        });
        if (nearest && Array.isArray(nearest)) {
          connections.push(...nearest.map((n: any) => n.key));
        }
      } catch (e) {
        // Fallback to empty connections
      }
      
      nodes.push({
        key,
        name: s.name || s.path || key,
        path: s.path || key,
        embedding: s.vec,
        mtime: s.mtime || Date.now(),
        size: s.size || 0,
        connections
      });
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

  createNodes(nodesData: NodeData[], positions: Map<string, Vec3>) {
    if (!this.scene) return;
    
    nodesData.forEach(data => {
      const pos = positions.get(data.key);
      if (!pos) return;
      
      // Color by age
      const age = (Date.now() - data.mtime) / (365 * 24 * 60 * 60 * 1000);
      const hue = (0.55 + age * 0.15) % 1;
      const color = new THREE.Color().setHSL(hue, 0.7, 0.6);
      
      const geometry = new THREE.SphereGeometry(0.6, 16, 16);
      const material = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.9
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.userData = data;
      
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
    container.appendChild(tooltip);
    
    // Mouse move for hover
    const updateHover = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      
      raycaster.setFromCamera(mouse, this.camera!);
      const intersects = raycaster.intersectObjects(this.nodes);
      
      if (hoveredNode) {
        (hoveredNode.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.5;
        hoveredNode.scale.set(1, 1, 1);
      }
      
      if (intersects.length > 0) {
        hoveredNode = intersects[0].object as THREE.Mesh;
        (hoveredNode.material as THREE.MeshPhongMaterial).emissiveIntensity = 1.2;
        hoveredNode.scale.set(1.5, 1.5, 1.5);
        
        const data = hoveredNode.userData as NodeData;
        tooltip.textContent = data.name;
        tooltip.style.display = 'block';
        tooltip.style.left = e.clientX + 10 + 'px';
        tooltip.style.top = e.clientY + 10 + 'px';
        canvas.style.cursor = 'pointer';
      } else {
        hoveredNode = null;
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
    
    // Click to open note
    canvas.addEventListener('click', () => {
      raycaster.setFromCamera(mouse, this.camera!);
      const intersects = raycaster.intersectObjects(this.nodes);
      
      if (intersects.length > 0) {
        const data = (intersects[0].object as THREE.Mesh).userData as NodeData;
        this.openNote(data.path);
      }
    });
    
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
        status.textContent = `${nodes.length} notes`;
        recomputeBtn.disabled = false;
      }, 50);
    });
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
      label.visible = distance < 45;
      label.position.set(node.position.x, node.position.y + 1.8, node.position.z);
      const scale = THREE.MathUtils.clamp((50 - distance) / 25, 0.45, 1.2);
      label.scale.setScalar(scale);
    });
    
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
        if (sim > 0.7) {
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
