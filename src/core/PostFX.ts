import { N8AOPostPass } from 'n8ao';
import {
  BloomEffect,
  BrightnessContrastEffect,
  type Effect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  HueSaturationEffect,
  KernelSize,
  type Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  TiltShiftEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import * as THREE from 'three';
import { worldUniforms } from '../world/render/materials';
import type { Game } from './Game';

/**
 * Pós-processamento "cinematográfico" (lib postprocessing — efeitos fundidos
 * numa única passada):
 *  - N8AO: oclusão de ambiente (cantos, beirais, contato com o chão)
 *  - God rays: raios de sol atravessando prédios e árvores
 *  - Bloom: brilho de janelas, postes, faróis e céu
 *  - Gradação de cor + vinheta + tone mapping filmico AgX
 *  - Tilt-shift opcional (efeito maquete)
 * Qualidade baixa: renderização direta (sem composer).
 */
export class PostFX {
  private composer: EffectComposer | null = null;
  private ao: InstanceType<typeof N8AOPostPass> | null = null;
  private bloom: BloomEffect | null = null;
  private rays: GodRaysEffect | null = null;
  private sunMesh: THREE.Mesh;
  tiltShift = false;

  constructor(private readonly game: Game) {
    game.onResizeHooks.push(() => this.resize());
    game.onDegrade.push(() => {
      const q = this.game.quality;
      if (q.ssao) q.ssao = false;
      else if (q.godrays) q.godrays = false;
      else if (q.bloom) q.bloom = false;
      else return;
      console.info('[qualidade] desempenho baixo: efeito desligado', { ssao: q.ssao, godrays: q.godrays, bloom: q.bloom });
      this.rebuild();
    });
    // "sol" visível para os god rays (fonte de luz da máscara)
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(70, 16, 8),
      new THREE.MeshBasicMaterial({ color: '#fff2d6', transparent: true, depthWrite: false, fog: false }),
    );
    this.sunMesh.frustumCulled = false;
    this.sunMesh.name = 'sol';
  }

  private resize() {
    if (!this.composer) return;
    const size = this.game.renderer.getSize(new THREE.Vector2());
    if (size.x < 2 || size.y < 2) return;
    this.composer.setSize(size.x, size.y, false);
  }

  /** (re)monta a cadeia conforme qualidade + tilt-shift */
  rebuild() {
    const { renderer, scene, camera, quality } = this.game;
    this.composer?.dispose();
    this.composer = null;
    this.ao = null;
    this.bloom = null;
    this.rays = null;
    scene.remove(this.sunMesh);
    const any = quality.ssao || quality.bloom || quality.godrays || this.tiltShift;
    if (!any) {
      renderer.toneMapping = THREE.AgXToneMapping;
      this.game.renderOverride = null;
      return;
    }
    // o tone mapping passa a ser feito no fim da cadeia (HDR até lá)
    renderer.toneMapping = THREE.NoToneMapping;
    const c = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: quality.ssao || !quality.antialias ? 0 : 4,
    });
    c.addPass(new RenderPass(scene, camera));
    if (quality.ssao) {
      const size = renderer.getSize(new THREE.Vector2());
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      ao.configuration.aoRadius = 3.5;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 3.2;
      ao.configuration.halfRes = true;
      ao.configuration.gammaCorrection = false;
      ao.setQualityMode('Medium');
      c.addPass(ao as unknown as Pass);
      this.ao = ao;
    }
    const effects: Effect[] = [];
    if (quality.ssao) effects.push(new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
    if (quality.godrays) {
      scene.add(this.sunMesh);
      this.rays = new GodRaysEffect(camera, this.sunMesh, {
        density: 0.95,
        decay: 0.93,
        weight: 0.35,
        exposure: 0.5,
        samples: quality.ssao ? 60 : 40,
        clampMax: 1,
        resolutionScale: 0.5,
        kernelSize: KernelSize.SMALL,
        blur: true,
      });
      effects.push(this.rays);
    }
    if (quality.bloom) {
      this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.6, luminanceThreshold: 0.85, luminanceSmoothing: 0.2, radius: 0.7 });
      effects.push(this.bloom);
    }
    if (this.tiltShift) effects.push(new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: 0.35, feather: 0.25, kernelSize: KernelSize.MEDIUM }));
    // gradação: um pouco mais de contraste/saturação, vinheta suave
    effects.push(new HueSaturationEffect({ saturation: 0.12 }));
    effects.push(new BrightnessContrastEffect({ contrast: 0.08 }));
    effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.45 }));
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.AGX }));
    c.addPass(new EffectPass(camera, ...effects));
    this.composer = c;
    this.resize();
    this.game.renderOverride = () => this.render();
  }

  setTiltShift(v: boolean) {
    this.tiltShift = v;
    this.rebuild();
  }

  private render() {
    const night = worldUniforms.uNight.value;
    const { camera, sunDir } = this.game;
    if (this.rays) {
      // sol acima do horizonte: raios; à noite somem
      const day = sunDir.y > 0.02 && night < 0.5;
      this.sunMesh.visible = day;
      this.sunMesh.position.copy(camera.position).addScaledVector(sunDir, 3200);
      this.rays.godRaysMaterial.weight = day ? 0.35 * (1 - night) : 0;
    }
    if (this.bloom) this.bloom.intensity = 0.45 + night * 0.9;
    if (this.ao) this.ao.configuration.intensity = 3.2 * (1 - night * 0.6);
    this.composer!.render();
  }
}
