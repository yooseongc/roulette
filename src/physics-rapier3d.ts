import type RAPIER_TYPE from '@dimforge/rapier3d-compat';
import { IPhysics, MarbleTransform3D } from './IPhysics';
import { StageDef } from './data/maps';
import { MapEntity, MapEntityState } from './types/MapEntity.type';

const CORRIDOR_HALF_DEPTH = 1.2;  // narrow Z corridor keeps marbles near center
const WALL_THICKNESS = 0.15;     // thin enough to avoid wedge pockets at junctions
const PHYSICS_SUBSTEPS = 6;      // more substeps → less tunneling from fast kinematic arms
const MAX_MARBLE_SPEED = 25;     // cap marble speed to prevent escaping from fast rotators

type Rapier = typeof RAPIER_TYPE;
type RigidBody = RAPIER_TYPE.RigidBody;

interface EntityRecord {
  /** Non-null for kinematic entities AND static entities with life > 0. */
  body: RigidBody | null;
  state: MapEntityState;
  isKinematic: boolean;
}

interface MarbleRecord {
  body: RigidBody;
}

export class Rapier3dPhysics implements IPhysics {
  private RAPIER!: Rapier;
  private world!: RAPIER_TYPE.World;

  private marbleMap: Map<number, MarbleRecord> = new Map();
  /** One record per original MapEntity (for getEntities / minimap rendering) */
  private entityRecords: EntityRecord[] = [];
  /** All collision bodies (for cleanup) */
  private allEntityBodies: RigidBody[] = [];

  async init(): Promise<void> {
    this.RAPIER = await import('@dimforge/rapier3d-compat');
    await this.RAPIER.init();
    this.world = new this.RAPIER.World({ x: 0, y: -10, z: 0 });
    console.log('rapier3d ready');
  }

  clear(): void {
    this.clearEntities();
  }

  clearMarbles(): void {
    this.marbleMap.forEach(({ body }) => {
      this.world.removeRigidBody(body);
    });
    this.marbleMap.clear();
  }

  createStage(stage: StageDef): void {
    this.createEntities(stage.entities);
    this.createCorridorWalls();
  }

  private createCorridorWalls(): void {
    for (const sign of [1, -1]) {
      const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(
        0,
        0,
        sign * CORRIDOR_HALF_DEPTH,
      );
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(1000, 1000, 0.05);
      this.world.createCollider(colliderDesc, body);
      this.allEntityBodies.push(body);
    }
  }

  private createEntities(entities?: MapEntity[]): void {
    if (!entities) return;

    entities.forEach((entity) => {
      const px = entity.position.x;
      const py = -entity.position.y; // map Y-down → Rapier Y-up

      switch (entity.shape.type) {
        case 'polyline':
          this.createPolylineEntity(entity, px, py);
          break;
        case 'box':
          this.createBoxEntity(entity, px, py);
          break;
        case 'circle':
          this.createCircleEntity(entity, px, py);
          break;
      }
    });
  }

  private createPolylineEntity(entity: MapEntity, _px: number, _py: number): void {
    if (entity.shape.type !== 'polyline') return;
    const points = entity.shape.points;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      const x1 = entity.position.x + p1[0];
      const y1 = -(entity.position.y + p1[1]); // map Y-down → Rapier Y-up
      const x2 = entity.position.x + p2[0];
      const y2 = -(entity.position.y + p2[1]);

      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length < 0.001) continue;

      const angle = Math.atan2(dy, dx);
      const qz = Math.sin(angle / 2);
      const qw = Math.cos(angle / 2);

      const bodyDesc = this.RAPIER.RigidBodyDesc.fixed()
        .setTranslation(mx, my, 0)
        .setRotation({ x: 0, y: 0, z: qz, w: qw });
      const body = this.world.createRigidBody(bodyDesc);

      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(
        length / 2,
        WALL_THICKNESS,
        CORRIDOR_HALF_DEPTH,
      )
        .setRestitution(entity.props.restitution)
        .setDensity(entity.props.density);
      this.world.createCollider(colliderDesc, body);
      this.allEntityBodies.push(body);
    }

    // One entity record for the whole polyline (static — angle stays 0)
    this.entityRecords.push({
      body: null,
      isKinematic: false,
      state: {
        x: entity.position.x,
        y: entity.position.y,
        angle: 0,
        shape: entity.shape,
        life: entity.props.life ?? -1,
      },
    });
  }

  private createBoxEntity(entity: MapEntity, px: number, py: number): void {
    if (entity.shape.type !== 'box') return;
    const rot = entity.shape.rotation;
    const qz = Math.sin(rot / 2);
    const qw = Math.cos(rot / 2);

    const isKinematic = entity.type === 'kinematic';
    const bodyDesc = isKinematic
      ? this.RAPIER.RigidBodyDesc.kinematicVelocityBased()
          .setTranslation(px, py, 0)
          .setRotation({ x: 0, y: 0, z: qz, w: qw })
      : this.RAPIER.RigidBodyDesc.fixed()
          .setTranslation(px, py, 0)
          .setRotation({ x: 0, y: 0, z: qz, w: qw });
    const body = this.world.createRigidBody(bodyDesc);

    if (isKinematic) {
      // Negate: Box2D (Y-up physics + Y-down rendering) had opposite sign convention
      body.setAngvel({ x: 0, y: 0, z: -entity.props.angularVelocity }, true);
    }

    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(
      entity.shape.width,
      entity.shape.height,
      CORRIDOR_HALF_DEPTH,
    )
      .setRestitution(entity.props.restitution)
      .setDensity(entity.props.density);
    this.world.createCollider(colliderDesc, body);
    this.allEntityBodies.push(body);

    const hasLife = (entity.props.life ?? -1) > 0;
    this.entityRecords.push({
      body: isKinematic || hasLife ? body : null,
      isKinematic,
      state: {
        x: entity.position.x,
        y: entity.position.y,
        angle: 0,
        shape: entity.shape,
        life: entity.props.life ?? -1,
      },
    });
  }

  private createCircleEntity(entity: MapEntity, px: number, py: number): void {
    if (entity.shape.type !== 'circle') return;
    const isKinematic = entity.type === 'kinematic';

    const bodyDesc = isKinematic
      ? this.RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(
          px,
          py,
          0,
        )
      : this.RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, 0);
    const body = this.world.createRigidBody(bodyDesc);

    if (isKinematic) {
      // Negate: Box2D (Y-up physics + Y-down rendering) had opposite sign convention
      body.setAngvel({ x: 0, y: 0, z: -entity.props.angularVelocity }, true);
    }

    // Cylinder oriented along Z axis (collider rotated 90° around X)
    const sinQ = Math.sin(Math.PI / 4);
    const cosQ = Math.cos(Math.PI / 4);
    const colliderDesc = this.RAPIER.ColliderDesc.cylinder(
      CORRIDOR_HALF_DEPTH,
      entity.shape.radius,
    )
      .setRotation({ x: sinQ, y: 0, z: 0, w: cosQ })
      .setRestitution(entity.props.restitution)
      .setDensity(entity.props.density);
    this.world.createCollider(colliderDesc, body);
    this.allEntityBodies.push(body);

    const hasLife = (entity.props.life ?? -1) > 0;
    this.entityRecords.push({
      body: isKinematic || hasLife ? body : null,
      isKinematic,
      state: {
        x: entity.position.x,
        y: entity.position.y,
        angle: 0,
        shape: entity.shape,
        life: entity.props.life ?? -1,
      },
    });
  }

  clearEntities(): void {
    this.allEntityBodies.forEach((body) => {
      this.world.removeRigidBody(body);
    });
    this.allEntityBodies = [];
    this.entityRecords = [];
  }

  createMarble(id: number, x: number, y: number): void {
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, -y, 0)
      .setEnabled(false)
      .setCcdEnabled(true)  // continuous collision detection prevents tunneling
      .setLinearDamping(0.3)
      .setAngularDamping(0.5);
    const body = this.world.createRigidBody(bodyDesc);

    // restitution=0 on marble + CombineRule.Max → effective restitution = obstacle's value
    // This lets bumpers (1.5) stay super-bouncy while walls (0.0) stay inelastic
    const colliderDesc = this.RAPIER.ColliderDesc.ball(0.25)
      .setDensity(1 + Math.random())
      .setRestitution(0)
      .setRestitutionCombineRule(this.RAPIER.CoefficientCombineRule.Max);
    this.world.createCollider(colliderDesc, body);

    this.marbleMap.set(id, { body });
  }

  shakeMarble(id: number): void {
    const record = this.marbleMap.get(id);
    if (!record) return;
    record.body.applyImpulse(
      {
        x: (Math.random() - 0.5) * 15,
        y: (Math.random() - 0.5) * 15,
        z: 0,  // no Z impulse — keep marbles near corridor center
      },
      true,
    );
  }

  removeMarble(id: number): void {
    const record = this.marbleMap.get(id);
    if (!record) return;
    this.world.removeRigidBody(record.body);
    this.marbleMap.delete(id);
  }

  getMarblePosition(id: number): { x: number; y: number; angle: number } | null {
    const record = this.marbleMap.get(id);
    if (!record) return null;
    const pos = record.body.translation();
    const rot = record.body.rotation();
    // angle from Z-rotation quaternion component
    const angle = 2 * Math.atan2(rot.z, rot.w);
    return { x: pos.x, y: -pos.y, angle };
  }

  getMarble3DTransform(id: number): MarbleTransform3D | null {
    const record = this.marbleMap.get(id);
    if (!record) return null;
    const pos = record.body.translation();
    const rot = record.body.rotation();
    return {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      qx: rot.x,
      qy: rot.y,
      qz: rot.z,
      qw: rot.w,
    };
  }

  /** Returns one MapEntityState per original entity (for minimap / UI rendering). */
  getEntities(): MapEntityState[] {
    return this.entityRecords.map((record) => {
      if (record.body === null || !record.isKinematic) {
        return record.state;
      }
      // Kinematic entity: update angle from body rotation
      const rot = record.body.rotation();
      const angle = 2 * Math.atan2(rot.z, rot.w);
      return { ...record.state, angle };
    });
  }

  impact(id: number): void {
    const src = this.marbleMap.get(id);
    if (!src) return;
    const srcPos = src.body.translation();

    this.marbleMap.forEach((record, rid) => {
      if (rid === id) return;
      const pos = record.body.translation();
      const dx = pos.x - srcPos.x;
      const dy = pos.y - srcPos.y;
      const dz = pos.z - srcPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 100 && distSq > 0.001) {
        const dist = Math.sqrt(distSq);
        const power = (1 - dist / 10) * 5;
        record.body.applyImpulse(
          {
            x: (dx / dist) * power,
            y: (dy / dist) * power,
            z: (dz / dist) * power,
          },
          true,
        );
      }
    });
  }

  start(): void {
    this.marbleMap.forEach((record) => {
      record.body.setEnabled(true);
    });
  }

  step(deltaSeconds: number): void {
    this.world.timestep = deltaSeconds / PHYSICS_SUBSTEPS;
    for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
      this.world.step();
    }
    // Gentle Z-spring to keep marbles near z=0 (corridor walls already block escape)
    // wakeup=true so sleeping marbles respond after being hit
    this.marbleMap.forEach(({ body }) => {
      if (!body.isEnabled()) return;
      const pos = body.translation();
      const vel = body.linvel();
      body.applyImpulse({ x: 0, y: 0, z: -pos.z * 0.4 - vel.z * 0.08 }, true);
      // Cap speed to prevent escape; setLinvel is safe here (called between frames)
      const speedSq = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
      if (speedSq > MAX_MARBLE_SPEED * MAX_MARBLE_SPEED) {
        const scale = MAX_MARBLE_SPEED / Math.sqrt(speedSq);
        body.setLinvel({ x: vel.x * scale, y: vel.y * scale, z: vel.z * scale }, true);
      }
    });

    // Life entities: destroy when touched by a marble (proximity check in XY plane)
    this.entityRecords.forEach((record) => {
      if (record.body === null || record.state.life < 1) return;
      if (record.state.shape.type !== 'circle') return;
      const ePos = record.body.translation();
      const { radius } = record.state.shape;
      let hit = false;
      this.marbleMap.forEach(({ body: mb }) => {
        if (hit || !mb.isEnabled()) return;
        const mPos = mb.translation();
        const dx = mPos.x - ePos.x;
        const dy = mPos.y - ePos.y;
        if (Math.sqrt(dx * dx + dy * dy) < radius + 0.25 + 0.05) hit = true;
      });
      if (hit) {
        record.state.life--;
        if (record.state.life <= 0) {
          this.allEntityBodies = this.allEntityBodies.filter((b) => b !== record.body);
          this.world.removeRigidBody(record.body!);
          record.body = null;
        }
      }
    });
  }
}
