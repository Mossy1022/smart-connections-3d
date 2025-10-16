import { Plugin, WorkspaceLeaf, ItemView } from 'obsidian';
import { ThreeDView } from './view';

const VIEW_TYPE_3D = 'smart-3d-view';

export default class SmartConnections3DPlugin extends Plugin {
  async onload() {
    console.log('Loading Smart Connections 3D Visualizer');

    // Register view
    this.registerView(
      VIEW_TYPE_3D,
      (leaf) => new ThreeDView(leaf, this)
    );

    // Add ribbon icon
    this.addRibbonIcon('box', 'Open 3D Visualization', () => {
      this.activateView();
    });

    // Add command
    this.addCommand({
      id: 'open-3d-visualization',
      name: 'Open 3D Visualization',
      callback: () => {
        this.activateView();
      }
    });
  }

  async activateView() {
    const { workspace } = this.app;
    
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_3D)[0];
    
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_3D,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  onunload() {
    console.log('Unloading Smart Connections 3D Visualizer');
  }
}