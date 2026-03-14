import * as THREE from 'three';
import { Camera } from './camera';
import { StageDef } from './data/maps';
import { Marble } from './marble';
import { UIObject } from './UIObject';
import { IPhysics } from './IPhysics';
import { RenderParameters } from './rouletteRenderer';
import { DefaultEntityColor, DefaultBloomColor } from './data/constants';

const CORRIDOR_DEPTH = 5.0;
const WALL_THICKNESS = 0.2;
const CAMERA_Y_OFFSET = 5;   // small upward offset — nearly side-on view
const CAMERA_Z_OFFSET = 35;  // further back for better field of view

/** Tracks a mesh that belongs to a kinematic entity (for rotation updates). */
interface KineticMeshEntry {
  entityIndex: number; // index into params.entities[]
  mesh: THREE.Mesh;
}

export class ThreeRenderer {
  private _glCanvas!: HTMLCanvasElement;
  private _uiCanvas!: HTMLCanvasElement;
  private _uiCtx!: CanvasRenderingContext2D;

  private _renderer!: THREE.WebGLRenderer;
  private _scene!: THREE.Scene;
  private _camera3d!: THREE.PerspectiveCamera;

  private _marbleMeshes: Map<number, THREE.Mesh> = new Map();
  private _entityMeshes: THREE.Object3D[] = [];
  /** Maps entity index → its meshes (for life-based removal). */
  private _entityMeshMap: Map<number, THREE.Mesh[]> = new Map();
  /** Subset of entity meshes that need per-frame rotation updates. */
  private _kineticMeshes: KineticMeshEntry[] = [];

  private _physics: IPhysics | null = null;

  public sizeFactor = 1;

  get canvas(): HTMLCanvasElement {
    return this._uiCanvas;
  }

  get glCanvas(): HTMLCanvasElement {
    return this._glCanvas;
  }

  get width(): number {
    return this._uiCanvas.width;
  }

  get height(): number {
    return this._uiCanvas.height;
  }

  setPhysics(physics: IPhysics): void {
    this._physics = physics;
  }

  async init(): Promise<void> {
    await this._loadImages();

    // Three.js WebGL canvas
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._glCanvas = this._renderer.domElement;
    this._glCanvas.style.position = 'absolute';
    this._glCanvas.style.top = '0';
    this._glCanvas.style.left = '0';
    this._glCanvas.style.width = '100%';
    this._glCanvas.style.height = '100%';

    // 2D UI overlay canvas (receives mouse events)
    this._uiCanvas = document.createElement('canvas');
    this._uiCanvas.style.position = 'absolute';
    this._uiCanvas.style.top = '0';
    this._uiCanvas.style.left = '0';
    this._uiCanvas.style.width = '100%';
    this._uiCanvas.style.height = '100%';
    this._uiCanvas.style.background = 'transparent';
    this._uiCtx = this._uiCanvas.getContext('2d', {
      alpha: true,
    }) as CanvasRenderingContext2D;

    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '100%';
    container.style.height = '100vh';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.background = 'black';
    container.appendChild(this._glCanvas);
    container.appendChild(this._uiCanvas);
    document.body.appendChild(container);

    // Scene
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x000000);

    // Camera (perspective, 60° FOV)
    this._camera3d = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    this._camera3d.position.set(13, CAMERA_Y_OFFSET, CAMERA_Z_OFFSET);
    this._camera3d.lookAt(13, 0, 0);

    // Lights — key light from upper-left, fill from right, ambient low
    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    this._scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(-15, 40, 20); // upper-left, different from camera
    this._scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
    fillLight.position.set(20, -10, 15); // lower-right fill
    this._scene.add(fillLight);

    const resizing = (entries?: ResizeObserverEntry[]) => {
      const rect = entries
        ? entries[0].contentRect
        : container.getBoundingClientRect();
      const w = Math.max(rect.width, 1);
      const h = Math.max(rect.height, 1);
      const logicalW = Math.max(w / 2, 640);
      const logicalH = (logicalW / w) * h;
      this._uiCanvas.width = logicalW;
      this._uiCanvas.height = logicalH;
      this._renderer.setSize(w, h);
      this._camera3d.aspect = w / h;
      this._camera3d.updateProjectionMatrix();
      this.sizeFactor = logicalW / w;
    };
    const ro = new ResizeObserver(resizing);
    ro.observe(container);
    resizing();
  }

  private async _loadImages(): Promise<void> {
    // Pre-load custom skin images (kept for marble.render() in minimap)
    const entries = [
      {
        name: '챔루',
        imgUrl: new URL('../assets/images/chamru.png', import.meta.url),
      },
      {
        name: '쿠빈',
        imgUrl: new URL('../assets/images/kubin.png', import.meta.url),
      },
    ];
    await Promise.all(
      entries.map(
        ({ imgUrl }) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = imgUrl.toString();
          }),
      ),
    );
  }

  loadStage(stage: StageDef): void {
    // Remove old entity meshes from scene
    this._entityMeshes.forEach((m) => this._scene.remove(m));
    this._entityMeshes = [];
    this._kineticMeshes = [];
    this._entityMeshMap.clear();

    if (!stage.entities) return;

    stage.entities.forEach((entity, entityIndex) => {
      const colorStr =
        (entity.shape.color ??
          DefaultEntityColor[entity.shape.type]) as string;
      const bloomStr =
        (entity.shape.bloomColor ??
          entity.shape.color ??
          DefaultBloomColor[entity.shape.type]) as string;

      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(colorStr),
        emissive: new THREE.Color(bloomStr),
        emissiveIntensity: 0.3,
      });

      const entityMeshes: THREE.Mesh[] = [];

      switch (entity.shape.type) {
        case 'polyline': {
          const pts = entity.shape.points;
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const x1 = entity.position.x + p1[0];
            const y1 = -(entity.position.y + p1[1]);
            const x2 = entity.position.x + p2[0];
            const y2 = -(entity.position.y + p2[1]);
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.001) continue;
            const angle = Math.atan2(dy, dx);
            const geo = new THREE.BoxGeometry(len, WALL_THICKNESS, CORRIDOR_DEPTH);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, 0);
            mesh.rotation.z = angle;
            this._scene.add(mesh);
            this._entityMeshes.push(mesh);
            entityMeshes.push(mesh);
          }
          break;
        }
        case 'box': {
          const geo = new THREE.BoxGeometry(
            entity.shape.width * 2,
            entity.shape.height * 2,
            CORRIDOR_DEPTH,
          );
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(entity.position.x, -entity.position.y, 0);
          mesh.rotation.z = entity.shape.rotation;
          this._scene.add(mesh);
          this._entityMeshes.push(mesh);
          entityMeshes.push(mesh);
          if (entity.type === 'kinematic') {
            this._kineticMeshes.push({ entityIndex, mesh });
          }
          break;
        }
        case 'circle': {
          const geo = new THREE.CylinderGeometry(
            entity.shape.radius,
            entity.shape.radius,
            CORRIDOR_DEPTH,
            32,
          );
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(entity.position.x, -entity.position.y, 0);
          // Align cylinder axis with world Z (so it appears as a circle in front view)
          mesh.rotation.x = Math.PI / 2;
          this._scene.add(mesh);
          this._entityMeshes.push(mesh);
          entityMeshes.push(mesh);
          if (entity.type === 'kinematic') {
            this._kineticMeshes.push({ entityIndex, mesh });
          }
          break;
        }
      }

      this._entityMeshMap.set(entityIndex, entityMeshes);
    });
  }

  private _syncMarbleMeshes(marbles: Marble[]): void {
    const activeIds = new Set(marbles.map((m) => m.id));

    this._marbleMeshes.forEach((mesh, id) => {
      if (!activeIds.has(id)) {
        this._scene.remove(mesh);
        this._marbleMeshes.delete(id);
      }
    });

    for (const marble of marbles) {
      if (!this._marbleMeshes.has(marble.id)) {
        const geo = new THREE.SphereGeometry(0.25, 16, 16);
        const mat = new THREE.MeshPhongMaterial({
          color: new THREE.Color(marble.color),
          shininess: 80,
        });
        const mesh = new THREE.Mesh(geo, mat);
        this._scene.add(mesh);
        this._marbleMeshes.set(marble.id, mesh);
      }
    }
  }

  private _updateMarbleMeshes(marbles: Marble[], winnerIndex: number): void {
    if (!this._physics) return;
    for (let i = 0; i < marbles.length; i++) {
      const marble = marbles[i];
      const mesh = this._marbleMeshes.get(marble.id);
      if (!mesh) continue;
      const t = this._physics.getMarble3DTransform(marble.id);
      if (!t) continue;
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(t.qx, t.qy, t.qz, t.qw);
      // Highlight the target-rank marble with emissive glow
      const mat = mesh.material as THREE.MeshPhongMaterial;
      if (i === winnerIndex) {
        mat.emissive.set(marble.color);
        mat.emissiveIntensity = 0.5;
      } else {
        mat.emissiveIntensity = 0;
      }
    }
  }

  private _updateKineticMeshes(entities: ReturnType<IPhysics['getEntities']>): void {
    for (const { entityIndex, mesh } of this._kineticMeshes) {
      const entity = entities[entityIndex];
      if (!entity) continue;
      if (entity.shape.type === 'circle') {
        // Body rotates around Z; mesh.rotation.x = π/2 stays; update Z rotation
        mesh.rotation.z = entity.angle;
      } else if (entity.shape.type === 'box') {
        mesh.rotation.z = entity.angle;
      }
    }
  }

  private _updateCamera(camera: Camera): void {
    const tx = camera.x;
    const ty = -camera.y; // map Y-down → Three.js Y-up
    const zoom = Math.max(camera.zoom, 0.1);
    const camZ = CAMERA_Z_OFFSET / zoom;

    const lf = 0.1;
    this._camera3d.position.x += (tx - this._camera3d.position.x) * lf;
    this._camera3d.position.y +=
      (ty + CAMERA_Y_OFFSET - this._camera3d.position.y) * lf;
    this._camera3d.position.z += (camZ - this._camera3d.position.z) * lf;
    this._camera3d.lookAt(tx, ty, 0);
  }

  private _projectToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this._camera3d);
    return {
      x: ((v.x + 1) / 2) * this._uiCanvas.width,
      y: ((-v.y + 1) / 2) * this._uiCanvas.height,
    };
  }

  private _renderMarbleNames(
    marbles: Marble[],
    winners: Marble[],
    winnerRank: number,
  ): void {
    if (!this._physics) return;
    const winnerIndex = winnerRank - winners.length;
    const ctx = this._uiCtx;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < marbles.length; i++) {
      const marble = marbles[i];
      const t = this._physics.getMarble3DTransform(marble.id);
      if (!t) continue;

      const center = this._projectToScreen(t.x, t.y, t.z);
      const edge   = this._projectToScreen(t.x + 0.25, t.y, t.z);
      const screenRadius = Math.abs(edge.x - center.x);

      // Font scales with marble size on screen, but always at least 9px
      const fontSize = Math.max(9, Math.min(18, screenRadius * 3));
      const nameY = center.y - screenRadius - 3;

      ctx.globalAlpha = 0.9;
      ctx.font = `${Math.round(fontSize)}px sans-serif`;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(marble.name, center.x, nameY);
      ctx.fillStyle = marble.color;
      ctx.fillText(marble.name, center.x, nameY);
    }
    ctx.restore();
  }

  private _renderWinner(winner: Marble | null): void {
    if (!winner) return;
    const ctx = this._uiCtx;
    const w = this._uiCanvas.width;
    const h = this._uiCanvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(w / 2, h - 168, w / 2, 168);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Winner', w - 10, h - 120);
    ctx.font = 'bold 72px sans-serif';
    ctx.fillStyle = winner.color;
    ctx.fillText(winner.name, w - 10, h - 55);
    ctx.restore();
  }

  render(params: RenderParameters, uiObjects: UIObject[]): void {
    const { camera, marbles, winners, particleManager, winner, winnerRank, entities } =
      params;

    // Sync and update 3D marble meshes
    const winnerIndex = winnerRank - winners.length;
    this._syncMarbleMeshes(marbles);
    this._updateMarbleMeshes(marbles, winnerIndex);
    this._updateKineticMeshes(entities);

    // Remove meshes for destroyed life entities (life === 0)
    entities.forEach((state, i) => {
      if (state.life === 0) {
        const meshes = this._entityMeshMap.get(i);
        if (meshes?.length) {
          meshes.forEach((m) => this._scene.remove(m));
          this._entityMeshMap.set(i, []);
        }
      }
    });

    // Update Three.js camera based on 2D Camera state
    this._updateCamera(camera);

    // Three.js render pass
    this._renderer.render(this._scene, this._camera3d);

    // 2D overlay render pass
    const ctx = this._uiCtx;
    ctx.clearRect(0, 0, this._uiCanvas.width, this._uiCanvas.height);

    // UI objects (minimap, rank renderer)
    uiObjects.forEach((obj) =>
      obj.render(ctx, params, this._uiCanvas.width, this._uiCanvas.height),
    );

    // Particle effects (screen-space)
    particleManager.render(ctx);

    // Winner display
    this._renderWinner(winner);

    // Marble names at projected 3D positions
    this._renderMarbleNames(marbles, winners, winnerRank);
  }
}
