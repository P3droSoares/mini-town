import * as THREE from 'three';

/**
 * Céu em gradiente (barato) com disco solar, halo, lua e estrelas.
 * Segue a câmera; cor do horizonte = cor da névoa (esconde o fim do mapa).
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTop: { value: new THREE.Color('#6fa6d6') },
    uHorizon: { value: new THREE.Color('#cfe3ee') },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color('#fff2d0') },
    uSunVisible: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = normalize(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
          gl_Position.z = gl_Position.w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
        uniform float uSunVisible; uniform vec3 uMoonDir; uniform float uNight; uniform float uTime;
        varying vec3 vDir;
        float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.55, h), 0.75));
          float sd = max(dot(d, uSunDir), 0.0);
          // halo largo (pôr do sol) + disco
          col += uSunColor * pow(sd, 6.0) * 0.35;
          col += uSunColor * smoothstep(0.9993, 0.9997, sd) * 4.0 * uSunVisible;
          // lua
          float md = dot(d, uMoonDir);
          col += vec3(0.85, 0.9, 1.0) * smoothstep(0.9994, 0.9997, md) * uNight * 1.6;
          col += vec3(0.3, 0.35, 0.5) * pow(max(md, 0.0), 40.0) * uNight * 0.25;
          // estrelas
          if (uNight > 0.01 && h > 0.0) {
            vec3 p = d * 220.0;
            vec3 id = floor(p);
            float s = hash(id);
            vec3 f = fract(p) - 0.5;
            float star = step(0.985, s) * smoothstep(0.2, 0.0, length(f));
            float tw = 0.6 + 0.4 * sin(uTime * (1.5 + s * 3.0) + s * 60.0);
            col += vec3(star * tw * uNight * smoothstep(0.0, 0.25, h));
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), mat);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  follow(camera: THREE.Camera) {
    this.mesh.position.copy(camera.position);
  }
}
