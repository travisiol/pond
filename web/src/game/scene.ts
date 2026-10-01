import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { makeRng } from "@/shared/geometry";
import { FLAG_BOOST, FLAG_CASHING, FLAG_SHIELD } from "@/shared/protocol";
import { RULES, canEat, coinsToEth, lengthFor } from "@/shared/rules";
import { pelletRadius } from "@/shared/sim";
import { EYE, SKINS, makeFishGeometry, makeFishMaterial } from "./fishMesh";
import type { ClientFish, GameClient } from "./net";

/**
 * The ocean, drawn. Game x/y are the horizontal plane (three's x/z); fish
 * swim at y = 0, the seabed lies below, the camera hangs above and behind.
 * Everything is geometry and shaders made here: there are no model or
 * texture files.
 */

// The colour water turns everything into with distance.
const FOG = new THREE.Color(0x063f5e);
const FOG_DENSITY = 0.00066;
const SEABED_Y = -340;
const SURFACE_Y = 460;
const RADAR_RANGE = 1500;

// The seabed's relief. Plain JS so rocks, kelp and shadows can ask how high
// the sand is under them.
function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function groundAt(x: number, z: number): number {
  const dunes = valueNoise(x * 0.0013, z * 0.0013) * 130 + valueNoise(x * 0.0047, z * 0.0047) * 46;
  const ripples = Math.sin(x * 0.045 + valueNoise(x * 0.004, z * 0.004) * 8) * 3;
  return SEABED_Y + dunes + ripples - 88;
}
const MAX_ORBS = 1600;

interface FishView {
  group: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.ShaderMaterial;
  shadow: THREE.Mesh;
  tag: THREE.Mesh;
  tagMat: THREE.ShaderMaterial;
  label: HTMLDivElement;
  labelText: string;
  skin: number;
  lastAngle: number;
  bend: number;
  scale: number;
}

const RING_FRAG = /* glsl */ `
  precision highp float;
  uniform float uProgress;
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float band = smoothstep(0.78, 0.84, r) * smoothstep(1.0, 0.94, r);
    float a = atan(p.x, p.y) / 6.2831853 + 0.5;
    float fill = step(a, uProgress);
    float glow = band * (0.25 + 0.75 * fill);
    gl_FragColor = vec4(uColor * (1.0 + fill * 1.5), glow * uAlpha);
  }
`;

const PLAIN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class OceanScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 6, 9000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly fishGeo = makeFishGeometry();
  private readonly views = new Map<number, FishView>();
  private readonly overlay: HTMLDivElement;
  private readonly pops = new Map<number, HTMLDivElement>();
  private readonly orbs: THREE.Points;
  private readonly orbPos: Float32Array;
  private readonly orbCol: Float32Array;
  private readonly orbSize: Float32Array;
  private readonly seabedMat: THREE.ShaderMaterial;
  private readonly kelpMat: THREE.ShaderMaterial;
  private readonly snow: THREE.Points;
  private readonly bubbles: THREE.Points;
  private readonly lens: ShaderPass;
  private readonly shadowGeo = new THREE.CircleGeometry(1, 20);
  private readonly shadowMat: THREE.ShaderMaterial;
  private readonly shafts: THREE.Group;
  private readonly bursts: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; at: number }[] = [];
  private seenBursts = new WeakSet<object>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly tmp = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  /** Where the camera looks from, as a heading: it trails the shark's own. */
  private camYaw = -Math.PI / 2;
  private camDist = 260;
  private readonly camPos = new THREE.Vector3(0, 200, 400);
  private orbit = 0;
  private readonly aim = new THREE.Vector3();
  private aimSeen = false;
  private readonly aimMark: THREE.Mesh;
  private readonly aimMat: THREE.ShaderMaterial;
  private readonly surfaceMat: THREE.ShaderMaterial;
  private readonly surface: THREE.Mesh;
  private readonly dome: THREE.Mesh;
  private readonly radar: HTMLCanvasElement;
  private w = 1;
  private h = 1;
  private ringGeo = new THREE.PlaneGeometry(2, 2);
  private eyeGeo = new THREE.SphereGeometry(1, 12, 10);
  private eyeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private eyeDark = new THREE.MeshBasicMaterial({ color: 0x07121c });

  constructor(canvas: HTMLCanvasElement, overlay: HTMLDivElement) {
    this.overlay = overlay;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: process.env.NODE_ENV !== "production",
    });
    this.renderer.setClearColor(FOG);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene.fog = new THREE.FogExp2(FOG, FOG_DENSITY);
    this.scene.background = FOG;

    this.scene.add(new THREE.HemisphereLight(0xbfefff, 0x0a2a3a, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(300, 900, 200);
    this.scene.add(sun);

    // ── seabed ──────────────────────────────────────────────────────────
    // Real relief (dunes and ripples), pale sand, and the water's own colour
    // laid over it: red goes first, so everything below drifts to blue-green.
    const SIZE = RULES.arenaRadius * 3.6;
    const SEG = 220;
    const bedGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    bedGeo.rotateX(-Math.PI / 2);
    const bp = bedGeo.attributes.position;
    for (let i = 0; i < bp.count; i++) bp.setY(i, groundAt(bp.getX(i), bp.getZ(i)));
    bedGeo.computeVertexNormals();
    this.seabedMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFogColor: { value: FOG },
        uFogDensity: { value: FOG_DENSITY },
        uRadius: { value: RULES.arenaRadius },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vNormal = normal;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uRadius;
        varying vec3 vWorld;
        varying vec3 vNormal;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        vec2 hash22(vec2 p) { return vec2(hash(p), hash(p + 17.3)); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // Distance to the nearest cell border of a field of drifting points.
        // The bright threads of light on a seabed are exactly those borders.
        float border(vec2 p, float t) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float d1 = 8.0;
          float d2 = 8.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 g = vec2(float(x), float(y));
              vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * hash22(i + g));
              float d = length(g + o - f);
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
            }
          }
          return d2 - d1;
        }
        float caustics(vec2 p, float t) {
          // The surface above wobbles, so the net of light wobbles too.
          // Warp hard at two scales: straight cell walls become the loose,
          // stretched threads real caustics are.
          vec2 w = p + vec2(noise(p * 0.45 + t * 0.21), noise(p * 0.45 - t * 0.17)) * 1.9;
          w += vec2(noise(p * 1.9 - t * 0.3), noise(p * 1.9 + t * 0.26)) * 0.5;
          float a = border(w, t);
          float b = border(w * 1.61 + 4.1, t * 1.31);
          float threads = smoothstep(0.1, 0.0, a) * 0.7 + smoothstep(0.07, 0.0, b) * 0.45;
          // Light gathers in drifting patches, it is never even.
          float patchy = smoothstep(0.25, 0.8, noise(p * 0.33 + t * 0.08));
          return threads * (0.25 + 0.75 * patchy);
        }
        void main() {
          vec2 p = vWorld.xz;
          vec3 n = normalize(vNormal);
          vec3 sun = normalize(vec3(0.25, 1.0, 0.35));
          float lit = 0.35 + 0.65 * max(dot(n, sun), 0.0);
          // Sand: pale, with patches of darker silt and fine grain.
          float patches = noise(p * 0.0035) * 0.6 + noise(p * 0.014) * 0.4;
          float grain = noise(p * 0.5) * 0.5 + noise(p * 1.7) * 0.5;
          vec3 sand = mix(vec3(0.58, 0.52, 0.4), vec3(0.86, 0.8, 0.64), patches);
          sand *= 0.9 + grain * 0.16;
          sand *= lit;
          float c = caustics(p * 0.0165, uTime * 0.9);
          sand += vec3(1.0, 0.98, 0.86) * c * 0.3 * max(dot(n, sun), 0.0);
          // Water takes the red out and leaves blue-green.
          vec3 col = sand * vec3(0.16, 0.5, 0.6) + vec3(0.0, 0.035, 0.06);
          // Past the wall the floor falls into the dark.
          float out_ = smoothstep(uRadius, uRadius + 500.0, length(p));
          col = mix(col, vec3(0.005, 0.05, 0.09), out_);
          float d = length(cameraPosition - vWorld);
          float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(bedGeo, this.seabedMat));

    // Soft shadows on the sand under every fish: the cue that says the
    // fish is up in the water and the floor is far below it.
    this.shadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          gl_FragColor = vec4(0.0, 0.03, 0.06, smoothstep(1.0, 0.1, r) * 0.42);
        }
      `,
    });
    this.shadowGeo.rotateX(-Math.PI / 2);

    // ── rocks, coral, kelp ──────────────────────────────────────────────
    const rng = makeRng(20261001);
    const spot = (): [number, number] => {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * RULES.arenaRadius * 1.15;
      return [Math.cos(a) * r, Math.sin(a) * r];
    };
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s3 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    const color = new THREE.Color();

    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      // Displace by position, not by index: corners shared between faces must move together.
      const h = Math.sin(rp.getX(i) * 12.9898 + rp.getY(i) * 78.233 + rp.getZ(i) * 37.719) * 43758.5453;
      const k = 0.78 + (h - Math.floor(h)) * 0.44;
      rp.setXYZ(i, rp.getX(i) * k, rp.getY(i) * k * 0.7, rp.getZ(i) * k);
    }
    rockGeo.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), 260);
    for (let i = 0; i < 260; i++) {
      const [x, z] = spot();
      const s = 18 + rng() * rng() * 110;
      e.set(rng() * 0.4, rng() * 6.28, rng() * 0.4);
      m4.compose(p3.set(x, groundAt(x, z) + s * 0.15, z), q.setFromEuler(e), s3.set(s, s * (0.5 + rng() * 0.5), s));
      rocks.setMatrixAt(i, m4);
      rocks.setColorAt(i, color.setHSL(0.5 + rng() * 0.08, 0.22, 0.3 + rng() * 0.16));
    }
    this.scene.add(rocks);

    // Coral: squat branching cones in warm colours, clustered near rocks.
    const coralGeo = new THREE.ConeGeometry(1, 2.4, 6, 1);
    coralGeo.translate(0, 1.2, 0);
    const coral = new THREE.InstancedMesh(coralGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), 900);
    const coralHues = [0.96, 0.02, 0.08, 0.83, 0.13, 0.46];
    for (let i = 0; i < 900; ) {
      const [cx, cz] = spot();
      const hue = coralHues[Math.floor(rng() * coralHues.length)];
      const n = 3 + Math.floor(rng() * 6);
      for (let k = 0; k < n && i < 900; k++, i++) {
        const s = 8 + rng() * 22;
        e.set((rng() - 0.5) * 0.9, rng() * 6.28, (rng() - 0.5) * 0.9);
        const kx = cx + (rng() - 0.5) * 70;
        const kz = cz + (rng() - 0.5) * 70;
        m4.compose(p3.set(kx, groundAt(kx, kz) - 3, kz), q.setFromEuler(e), s3.set(s * 0.45, s, s * 0.45));
        coral.setMatrixAt(i, m4);
        coral.setColorAt(i, color.setHSL(hue + (rng() - 0.5) * 0.03, 0.7, 0.34 + rng() * 0.12));
      }
    }
    this.scene.add(coral);

    // Kelp: tall ribbons that sway in the vertex shader.
    const kelpGeo = new THREE.PlaneGeometry(1, 1, 1, 8);
    kelpGeo.translate(0, 0.5, 0);
    this.kelpMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uFogColor: { value: FOG }, uFogDensity: { value: FOG_DENSITY } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying float vY;
        varying vec3 vWorld;
        void main() {
          vY = position.y;
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          float sway = sin(uTime * 0.9 + w.x * 0.01 + w.z * 0.013) * 26.0 + sin(uTime * 1.7 + w.z * 0.02) * 9.0;
          w.x += sway * position.y * position.y;
          w.z += sway * 0.5 * position.y * position.y;
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying float vY;
        varying vec3 vWorld;
        void main() {
          vec3 col = mix(vec3(0.02, 0.14, 0.11), vec3(0.12, 0.42, 0.22), vY);
          float d = length(cameraPosition - vWorld);
          float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
        }
      `,
    });
    const kelp = new THREE.InstancedMesh(kelpGeo, this.kelpMat, 700);
    for (let i = 0; i < 700; ) {
      const [cx, cz] = spot();
      const n = 4 + Math.floor(rng() * 8);
      for (let k = 0; k < n && i < 700; k++, i++) {
        e.set(0, rng() * 6.28, 0);
        const kx = cx + (rng() - 0.5) * 110;
        const kz = cz + (rng() - 0.5) * 110;
        m4.compose(p3.set(kx, groundAt(kx, kz) - 2, kz), q.setFromEuler(e), s3.set(5 + rng() * 6, 110 + rng() * 190, 1));
        kelp.setMatrixAt(i, m4);
      }
    }
    kelp.frustumCulled = false;
    this.scene.add(kelp);

    // ── the wall: a curtain of light around the ocean ───────────────────
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(RULES.arenaRadius, RULES.arenaRadius, 800, 96, 1, true),
      new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: this.seabedMat.uniforms.uTime },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorld;
          void main() {
            vUv = uv;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform float uTime;
          varying vec2 vUv;
          varying vec3 vWorld;
          void main() {
            // A slow shimmer, like a net hanging in the water, warm so it reads as a limit.
            float weave = sin(vUv.x * 520.0 + sin(vUv.y * 9.0 + uTime * 0.5) * 2.0) * 0.5 + 0.5;
            float fade = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.3, vUv.y);
            // Only close up: from far away the water hides it.
            float near = smoothstep(1100.0, 250.0, length(cameraPosition - vWorld));
            gl_FragColor = vec4(vec3(1.0, 0.42, 0.3) * (0.3 + weave * 0.5), fade * near * 0.4);
          }
        `,
      }),
    );
    wall.position.y = SEABED_Y + 400;
    this.scene.add(wall);

    // ── orbs: one glowing point each ────────────────────────────────────
    this.orbPos = new Float32Array(MAX_ORBS * 3);
    this.orbCol = new Float32Array(MAX_ORBS * 3);
    this.orbSize = new Float32Array(MAX_ORBS);
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.BufferAttribute(this.orbPos, 3));
    og.setAttribute("color", new THREE.BufferAttribute(this.orbCol, 3));
    og.setAttribute("aSize", new THREE.BufferAttribute(this.orbSize, 1));
    this.orbs = new THREE.Points(
      og,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uScale: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float aSize;
          attribute vec3 color;
          uniform float uScale;
          varying vec3 vColor;
          void main() {
            vColor = color;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * uScale / -mv.z;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec3 vColor;
          void main() {
            float r = length(gl_PointCoord - 0.5) * 2.0;
            if (r > 1.0) discard;
            float core = smoothstep(0.42, 0.0, r);
            float halo = pow(1.0 - r, 2.2);
            // A saturated bead with a soft edge; the bloom pass adds the glow.
            gl_FragColor = vec4(vColor * (0.85 + core * 1.1), max(halo * 0.75, core));
          }
        `,
      }),
    );
    this.orbs.frustumCulled = false;
    this.scene.add(this.orbs);

    // ── plankton: soft motes at every depth, so the water has volume ────
    const SNOW = 1500;
    const sp = new Float32Array(SNOW * 3);
    const ss = new Float32Array(SNOW);
    for (let i = 0; i < SNOW; i++) {
      sp[i * 3] = (rng() - 0.5) * 3200;
      sp[i * 3 + 1] = SEABED_Y + rng() * 900;
      sp[i * 3 + 2] = (rng() - 0.5) * 3200;
      ss[i] = 2 + rng() * rng() * 9;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    sg.setAttribute("aSize", new THREE.BufferAttribute(ss, 1));
    const moteVert = /* glsl */ `
      attribute float aSize;
      uniform float uScale;
      varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / -mv.z;
        // Motes close to the lens are big and faint, like dust in a beam.
        vFade = smoothstep(60.0, 420.0, -mv.z) * smoothstep(2600.0, 900.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `;
    this.snow = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uScale: { value: 1 } },
        vertexShader: moteVert,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying float vFade;
          void main() {
            float r = length(gl_PointCoord - 0.5) * 2.0;
            if (r > 1.0) discard;
            gl_FragColor = vec4(0.75, 0.95, 1.0, (1.0 - r) * (1.0 - r) * 0.5 * vFade);
          }
        `,
      }),
    );
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);

    // Bubbles: thin bright rings climbing toward the surface.
    const BUB = 160;
    const bpos = new Float32Array(BUB * 3);
    const bs = new Float32Array(BUB);
    for (let i = 0; i < BUB; i++) {
      bpos[i * 3] = (rng() - 0.5) * 3200;
      bpos[i * 3 + 1] = SEABED_Y + rng() * 900;
      bpos[i * 3 + 2] = (rng() - 0.5) * 3200;
      bs[i] = 5 + rng() * 11;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(bpos, 3));
    bg.setAttribute("aSize", new THREE.BufferAttribute(bs, 1));
    this.bubbles = new THREE.Points(
      bg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uScale: { value: 1 } },
        vertexShader: moteVert,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying float vFade;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float r = length(p) * 2.0;
            if (r > 1.0) discard;
            float rim = smoothstep(0.62, 0.95, r) * smoothstep(1.0, 0.93, r);
            float glint = smoothstep(0.3, 0.0, length(p - vec2(-0.16, -0.18)) * 2.0);
            gl_FragColor = vec4(0.85, 0.98, 1.0, (rim * 0.75 + glint * 0.8 + 0.06) * vFade);
          }
        `,
      }),
    );
    this.bubbles.frustumCulled = false;
    this.scene.add(this.bubbles);

    // ── shafts of sunlight ──────────────────────────────────────────────
    this.shafts = new THREE.Group();
    const shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.seabedMat.uniforms.uTime },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float across = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
          float down = smoothstep(0.0, 0.9, vUv.y);
          float flicker = 0.6 + 0.4 * sin(uTime * 0.7 + vUv.x * 9.0);
          gl_FragColor = vec4(vec3(0.62, 0.95, 1.0), across * down * flicker * 0.075);
        }
      `,
    });
    for (let i = 0; i < 11; i++) {
      const shaft = new THREE.Mesh(new THREE.PlaneGeometry(130 + rng() * 260, 1700), shaftMat);
      shaft.position.set((rng() - 0.5) * 2600, 330, (rng() - 0.6) * 2000);
      shaft.rotation.set(0, (rng() - 0.5) * 0.8, 0.22 + rng() * 0.2);
      this.shafts.add(shaft);
    }
    this.scene.add(this.shafts);

    // ── the surface, seen from below ────────────────────────────────────
    // A bright, moving ceiling: the window of light you see when you look up.
    this.surfaceMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.seabedMat.uniforms.uTime, uFogColor: { value: FOG }, uFogDensity: { value: FOG_DENSITY } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          vec2 p = vWorld.xz * 0.006;
          // Swell: slow big waves with fast small ones riding them.
          float h = noise(p + uTime * 0.12) * 0.6 + noise(p * 2.7 - uTime * 0.2) * 0.3 + noise(p * 7.0 + uTime * 0.35) * 0.1;
          float glitter = smoothstep(0.62, 0.9, noise(p * 5.0 + vec2(uTime * 0.5, -uTime * 0.3)) * noise(p * 9.0 - uTime * 0.4) * 2.2);
          vec3 col = mix(vec3(0.05, 0.42, 0.6), vec3(0.45, 0.9, 0.98), smoothstep(0.3, 0.75, h));
          col += vec3(1.0, 1.0, 0.95) * glitter * 0.7;
          float d = length(cameraPosition - vWorld);
          // Straight up it is bright; toward the horizon it sinks into the haze.
          float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity * 0.85);
          gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 0.92);
        }
      `,
    });
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), this.surfaceMat);
    this.surface.rotation.x = Math.PI / 2;
    this.surface.position.y = SURFACE_Y;
    this.scene.add(this.surface);

    // Backdrop: the open water behind everything, lighter above, dark below.
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(7000, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uFogColor: { value: FOG } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform vec3 uFogColor;
          varying vec3 vDir;
          void main() {
            vec3 up = vec3(0.1, 0.5, 0.66);
            vec3 down = vec3(0.005, 0.07, 0.13);
            vec3 col = vDir.y > 0.0 ? mix(uFogColor, up, smoothstep(0.0, 0.6, vDir.y)) : mix(uFogColor, down, smoothstep(0.0, 0.55, -vDir.y));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.scene.add(this.dome);

    // A ring on the water where the pointer is: that is where the shark goes.
    this.aimMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uProgress: { value: 1 }, uColor: { value: new THREE.Color(0xffd34d) }, uAlpha: { value: 0 } },
      vertexShader: PLAIN_VERT,
      fragmentShader: RING_FRAG,
    });
    this.aimMark = new THREE.Mesh(this.ringGeo, this.aimMat);
    this.aimMark.rotation.x = -Math.PI / 2;
    this.aimMark.renderOrder = 5;
    this.scene.add(this.aimMark);

    // Radar: in a chase view you cannot see behind you, so this can.
    this.radar = document.createElement("canvas");
    this.radar.className = "radar";
    this.radar.width = 168;
    this.radar.height = 168;
    overlay.appendChild(this.radar);

    // ── post: bloom makes the orbs and the sprinting fish glow ──────────
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.6, 0.9);
    this.composer.addPass(this.bloom);
    this.lens = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
      vertexShader: PLAIN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 uv = vUv;
          uv.x += sin(uv.y * 17.0 + uTime * 1.25) * 0.0016 + sin(uv.y * 43.0 - uTime * 1.9) * 0.0006;
          uv.y += cos(uv.x * 14.0 + uTime * 1.05) * 0.0014;
          vec2 c = vUv - 0.5;
          float r = length(c);
          // Colours separate a little toward the edge of the lens.
          vec3 col;
          col.r = texture2D(tDiffuse, uv - c * r * 0.006).r;
          col.g = texture2D(tDiffuse, uv).g;
          col.b = texture2D(tDiffuse, uv + c * r * 0.006).b;
          // Light comes from the surface: brighter up the screen, deeper below.
          col *= mix(vec3(0.74, 0.86, 0.95), vec3(1.08, 1.06, 1.02), smoothstep(0.0, 1.0, vUv.y));
          col *= mix(vec3(1.0), vec3(0.42, 0.66, 0.8), smoothstep(0.35, 0.95, r));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.composer.addPass(this.lens);
    this.composer.addPass(new OutputPass());
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Where on the water the pointer is, as a heading from the shark. The
   * shark swims to that spot: point at something and it goes there. A
   * pointer above the horizon means "far away in that direction".
   */
  pointerAim(px: number, py: number, fx: number, fy: number): number | null {
    this.raycaster.setFromCamera(new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1), this.camera);
    const ray = this.raycaster.ray;
    const hit = ray.intersectPlane(this.plane, this.tmp);
    let x: number;
    let z: number;
    if (hit && hit.distanceTo(this.camera.position) < 2600) {
      x = hit.x;
      z = hit.z;
    } else {
      const d = Math.hypot(ray.direction.x, ray.direction.z) || 1;
      x = this.camera.position.x + (ray.direction.x / d) * 2600;
      z = this.camera.position.z + (ray.direction.z / d) * 2600;
    }
    this.aim.set(x, 0, z);
    this.aimSeen = true;
    const dx = x - fx;
    const dy = z - fy;
    // Pointing at the shark itself means nothing: keep going.
    if (dx * dx + dy * dy < 40 * 40) return null;
    return Math.atan2(dy, dx);
  }

  /** The keyboard steers without a pointer: hide the marker. */
  clearAim(): void {
    this.aimSeen = false;
  }

  private drawRadar(client: GameClient, me: ClientFish | undefined, myCoins: number): void {
    const c = this.radar.getContext("2d");
    if (!c) return;
    const size = this.radar.width;
    const mid = size / 2;
    c.clearRect(0, 0, size, size);
    this.radar.style.display = me ? "" : "none";
    if (!me) return;
    c.beginPath();
    c.arc(mid, mid, mid - 2, 0, Math.PI * 2);
    c.fillStyle = "rgba(3,27,43,0.62)";
    c.fill();
    c.strokeStyle = "rgba(160,230,255,0.3)";
    c.lineWidth = 1.5;
    c.stroke();
    c.beginPath();
    c.arc(mid, mid, (mid - 2) / 2, 0, Math.PI * 2);
    c.strokeStyle = "rgba(160,230,255,0.12)";
    c.stroke();
    // Heading up: rotate the world so the way the camera looks is the top.
    const rot = -this.camYaw - Math.PI / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const k = (mid - 6) / RADAR_RANGE;
    for (const p of client.pellets.values()) {
      const dx = p.x - me.x;
      const dy = p.y - me.y;
      if (dx * dx + dy * dy > RADAR_RANGE * RADAR_RANGE) continue;
      c.fillStyle = "rgba(53,224,255,0.4)";
      c.fillRect(mid + (dx * cos - dy * sin) * k, mid + (dx * sin + dy * cos) * k, 1.4, 1.4);
    }
    for (const f of client.fish.values()) {
      if (f.id === me.id) continue;
      const dx = f.x - me.x;
      const dy = f.y - me.y;
      const d = Math.hypot(dx, dy);
      // Sharks past the rim are pinned to it, so you still know which way.
      const kk = d > RADAR_RANGE ? (RADAR_RANGE / d) * k : k;
      const x = mid + (dx * cos - dy * sin) * kk;
      const y = mid + (dx * sin + dy * cos) * kk;
      const threat = canEat(f.coins, myCoins);
      const food = canEat(myCoins, f.coins);
      c.beginPath();
      c.arc(x, y, threat ? 5 : 3.5, 0, Math.PI * 2);
      c.fillStyle = threat ? "#ff5a4a" : food ? "#5dff9a" : "#b8d4e0";
      c.fill();
    }
    c.beginPath();
    c.moveTo(mid, mid - 7);
    c.lineTo(mid + 5, mid + 5);
    c.lineTo(mid - 5, mid + 5);
    c.closePath();
    c.fillStyle = "#ffd34d";
    c.fill();
  }

  private viewFor(f: ClientFish): FishView {
    let v = this.views.get(f.id);
    if (v && v.skin === f.skin) return v;
    if (v) this.dropView(f.id, v);
    const mat = makeFishMaterial(SKINS[f.skin % SKINS.length], FOG, FOG_DENSITY);
    const body = new THREE.Mesh(this.fishGeo, mat);
    body.frustumCulled = false;
    const group = new THREE.Group();
    group.add(body);
    // Eyes sit on the unit model, so they scale with the shark.
    for (const s of [-1, 1]) {
      const dark = new THREE.Mesh(this.eyeGeo, this.eyeDark);
      dark.position.set(EYE.x, EYE.y, EYE.z * s);
      dark.scale.setScalar(EYE.r);
      const glint = new THREE.Mesh(this.eyeGeo, this.eyeWhite);
      glint.position.set(EYE.x + 0.004, EYE.y + 0.006, (EYE.z + 0.008) * s);
      glint.scale.setScalar(EYE.r * 0.3);
      group.add(dark, glint);
    }
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color(0xffd34d) }, uAlpha: { value: 0 } },
      vertexShader: PLAIN_VERT,
      fragmentShader: RING_FRAG,
    });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    const shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    // A ring around the shark says what it is to you: red hunts you, green is a meal.
    const tagMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uProgress: { value: 1 }, uColor: { value: new THREE.Color(0xffffff) }, uAlpha: { value: 0 } },
      vertexShader: PLAIN_VERT,
      fragmentShader: RING_FRAG,
    });
    const tag = new THREE.Mesh(this.ringGeo, tagMat);
    tag.rotation.x = -Math.PI / 2;
    this.scene.add(group, ring, shadow, tag);
    const label = document.createElement("div");
    label.className = "fish-label";
    this.overlay.appendChild(label);
    v = { group, body, mat, ring, ringMat, shadow, tag, tagMat, label, labelText: "", skin: f.skin, lastAngle: f.angle, bend: 0, scale: 0 };
    this.views.set(f.id, v);
    return v;
  }

  private dropView(id: number, v: FishView): void {
    this.scene.remove(v.group, v.ring, v.shadow, v.tag);
    v.tagMat.dispose();
    v.mat.dispose();
    v.ringMat.dispose();
    v.label.remove();
    this.views.delete(id);
  }

  render(client: GameClient, now: number, dt: number): void {
    const entry = client.entry();
    const me = client.myId ? client.fish.get(client.myId) : undefined;
    const myCoins = me?.coins ?? 0;

    // ── camera: behind and a little above the shark, looking where it goes ─
    if (me) {
      const len = lengthFor(me.coins, entry);
      // The camera's heading trails the shark's, so you see it turn first.
      let d = me.angle - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, dt * 1.35);
      const wantDist = (64 + len * 1.9) * (this.w < 700 ? 1.3 : 1);
      this.camDist += (wantDist - this.camDist) * Math.min(1, dt * 2);
      const fx = Math.cos(this.camYaw);
      const fz = Math.sin(this.camYaw);
      this.camPos.set(me.x - fx * this.camDist, this.camDist * 0.34 + 14, me.y - fz * this.camDist);
      this.camera.position.lerp(this.camPos, Math.min(1, dt * 9));
      this.camTarget.set(me.x + fx * len * 1.6, len * 0.12, me.y + fz * len * 1.6);
    } else {
      // Nobody to follow: circle slowly over whatever the server is showing.
      this.orbit += dt * 0.08;
      this.camPos.set(client.camX + Math.cos(this.orbit) * 620, 250, client.camY + Math.sin(this.orbit) * 620);
      this.camera.position.lerp(this.camPos, Math.min(1, dt * 2));
      this.camTarget.set(client.camX, -40, client.camY);
      this.camYaw = this.orbit + Math.PI;
    }
    this.camera.lookAt(this.camTarget);
    this.surface.position.set(this.camera.position.x, SURFACE_Y, this.camera.position.z);
    this.dome.position.copy(this.camera.position);
    this.drawRadar(client, me, myCoins);
    const showAim = !!me && this.aimSeen;
    this.aimMat.uniforms.uAlpha.value += ((showAim ? 0.55 : 0) - this.aimMat.uniforms.uAlpha.value) * Math.min(1, dt * 8);
    if (me) {
      // Keep the marker within reach so it reads as a target, not a horizon.
      const ax = this.aim.x - me.x;
      const az = this.aim.z - me.y;
      const ad = Math.hypot(ax, az) || 1;
      const reach = Math.min(ad, 520);
      this.aimMark.position.set(me.x + (ax / ad) * reach, 1, me.y + (az / ad) * reach);
      this.aimMark.scale.setScalar(16 + reach * 0.03 + Math.sin(now * 5) * 1.5);
    }

    this.seabedMat.uniforms.uTime.value = now;
    this.kelpMat.uniforms.uTime.value = now;
    this.lens.uniforms.uTime.value = now;
    this.shafts.position.set(this.camera.position.x, 0, this.camera.position.z);

    // Motes and bubbles wrap around the camera so there are always some in view.
    const pointScale = (this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * Math.min(2, window.devicePixelRatio || 1);
    const drift = (points: THREE.Points, rise: number, wobble: number) => {
      const a = points.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        let x = a.getX(i) + Math.sin(now * 0.6 + i) * wobble * dt;
        let z = a.getZ(i);
        let y = a.getY(i) + dt * rise;
        if (x - this.camera.position.x > 1600) x -= 3200;
        if (x - this.camera.position.x < -1600) x += 3200;
        if (z - this.camera.position.z > 1600) z -= 3200;
        if (z - this.camera.position.z < -1600) z += 3200;
        if (y > 560) y = SEABED_Y + 40;
        a.setXYZ(i, x, y, z);
      }
      a.needsUpdate = true;
      (points.material as THREE.ShaderMaterial).uniforms.uScale.value = pointScale;
    };
    drift(this.snow, 5, 6);
    drift(this.bubbles, 70, 22);

    // ── fish ────────────────────────────────────────────────────────────
    const proj = this.tmp;
    for (const [id, v] of this.views) if (!client.fish.has(id)) this.dropView(id, v);
    for (const f of client.fish.values()) {
      const v = this.viewFor(f);
      const len = lengthFor(f.coins, entry);
      v.scale += (len - v.scale) * (v.scale === 0 ? 1 : Math.min(1, dt * 6));
      const bob = Math.sin(f.phase * 0.35) * v.scale * 0.035;
      v.group.position.set(f.x, bob, f.y);
      v.group.rotation.y = -f.angle;
      v.group.scale.setScalar(v.scale);
      // The sun is a little off to one side, so the shadow is too.
      const sx = f.x - 60;
      const sz = f.y - 85;
      v.shadow.position.set(sx, groundAt(sx, sz) + 3, sz);
      v.shadow.rotation.y = -f.angle;
      v.shadow.scale.set(v.scale * 0.62, 1, v.scale * 0.3);
      // Lean into turns: the faster the heading changes, the more the body curves.
      let turn = f.angle - v.lastAngle;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      v.lastAngle = f.angle;
      const wantBend = Math.max(-0.5, Math.min(0.5, dt > 0 ? (turn / dt) * 0.09 : 0));
      v.bend += (wantBend - v.bend) * Math.min(1, dt * 8);
      const u = v.mat.uniforms;
      u.uPhase.value = f.phase;
      u.uSwim.value = 0.16 + Math.min(1, f.speed / 260) * 0.3;
      u.uBend.value = v.bend;
      u.uTime.value = now;
      const mine = f.id === client.myId;
      const shield = (f.flags & FLAG_SHIELD) !== 0;
      u.uAlpha.value = Math.min(1, f.age * 3) * (shield ? 0.55 + Math.sin(now * 14) * 0.2 : 1);
      u.uGlow.value = f.flags & FLAG_BOOST ? 0.9 : 0;
      const threat = !!me && !mine && canEat(f.coins, myCoins);
      const food = !!me && !mine && canEat(myCoins, f.coins);
      (u.uRim.value as THREE.Color).setHex(threat ? 0xff3b2f : food ? 0x35d97a : 0x2a8fb0);

      v.tag.position.set(f.x, -v.scale * 0.1, f.y);
      v.tag.scale.setScalar(v.scale * (threat ? 0.72 + Math.sin(now * 7) * 0.05 : 0.66));
      (v.tagMat.uniforms.uColor.value as THREE.Color).setHex(threat ? 0xff3b2f : 0x35e07a);
      v.tagMat.uniforms.uAlpha.value = shield ? 0 : threat ? 0.95 : food ? 0.7 : 0;

      const cashing = (f.flags & FLAG_CASHING) !== 0;
      v.ring.visible = cashing;
      if (cashing) {
        v.ring.position.set(f.x, 2, f.y);
        v.ring.scale.setScalar(v.scale * 0.75);
        v.ringMat.uniforms.uProgress.value = f.cash;
        v.ringMat.uniforms.uAlpha.value = 1;
      }

      // Label: name and what the fish is worth.
      proj.set(f.x, v.scale * 0.36, f.y).project(this.camera);
      const near = this.camera.position.distanceToSquared(v.group.position) < 1500 * 1500;
      const onScreen = near && proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05;
      if (!onScreen) {
        v.label.style.display = "none";
      } else {
        const verdict = mine ? "" : threat ? "DANGER · " : food ? "EAT · " : me ? "same size · " : "";
        const text = `${verdict}${mine ? "you" : f.name} · ${coinsToEth(f.coins)} ETH${cashing ? " · cashing out" : ""}`;
        if (text !== v.labelText) {
          v.labelText = text;
          v.label.textContent = text;
        }
        v.label.className = `fish-label${threat ? " threat" : food ? " food" : mine ? " mine" : ""}`;
        v.label.style.display = "";
        v.label.style.transform = `translate(-50%, -100%) translate(${((proj.x + 1) / 2) * this.w}px, ${((1 - proj.y) / 2) * this.h - 8}px)`;
      }
    }

    // ── orbs ────────────────────────────────────────────────────────────
    let n = 0;
    for (const p of client.pellets.values()) {
      if (n >= MAX_ORBS) break;
      const r = pelletRadius(p.value, entry);
      const grow = Math.min(1, (now - p.born) * 4);
      this.orbPos[n * 3] = p.x;
      this.orbPos[n * 3 + 1] = Math.sin(now * 1.6 + p.id) * 5;
      this.orbPos[n * 3 + 2] = p.y;
      // Small change is aqua, a good bite is gold, a dead fish's share is pink.
      const tier = p.value / entry;
      const c = tier > 0.08 ? [1.0, 0.3, 0.7] : tier > 0.02 ? [1.0, 0.74, 0.12] : [0.15, 0.9, 1.0];
      this.orbCol[n * 3] = c[0];
      this.orbCol[n * 3 + 1] = c[1];
      this.orbCol[n * 3 + 2] = c[2];
      this.orbSize[n] = r * 3.8 * grow * (1 + Math.sin(now * 3 + p.id * 1.3) * 0.1);
      n++;
    }
    const og = this.orbs.geometry;
    og.setDrawRange(0, n);
    (og.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (og.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (og.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    const orbMat = this.orbs.material as THREE.ShaderMaterial;
    orbMat.uniforms.uScale.value = this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * Math.min(2, window.devicePixelRatio || 1);

    // ── bursts where a fish was eaten ───────────────────────────────────
    for (const b of client.bursts) {
      if (this.seenBursts.has(b)) continue;
      this.seenBursts.add(b);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uProgress: { value: 1 }, uColor: { value: new THREE.Color(SKINS[b.skin % SKINS.length].back) }, uAlpha: { value: 1 } },
        vertexShader: PLAIN_VERT,
        fragmentShader: RING_FRAG,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(b.x, 3, b.y);
      mesh.userData.size = lengthFor(b.coins, entry);
      this.scene.add(mesh);
      this.bursts.push({ mesh, mat, at: now });
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      const t = (now - b.at) / 0.7;
      if (t >= 1) {
        this.scene.remove(b.mesh);
        b.mat.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      b.mesh.scale.setScalar(b.mesh.userData.size * (0.3 + t * 0.8));
      b.mat.uniforms.uAlpha.value = 1 - t;
    }

    // ── floating gains ──────────────────────────────────────────────────
    const live = new Set<number>();
    for (const p of client.pops) {
      live.add(p.id);
      let el = this.pops.get(p.id);
      if (!el) {
        el = document.createElement("div");
        el.className = `pop${p.big ? " big" : ""}`;
        el.textContent = `+${coinsToEth(p.coins, 5)} ETH`;
        this.overlay.appendChild(el);
        this.pops.set(p.id, el);
      }
      const t = (now - p.at) / 1.6;
      proj.set(p.x, 30 + t * 120, p.y).project(this.camera);
      el.style.opacity = String(Math.max(0, 1 - t * t));
      el.style.transform = `translate(-50%, -50%) translate(${((proj.x + 1) / 2) * this.w}px, ${((1 - proj.y) / 2) * this.h}px)`;
    }
    for (const [id, el] of this.pops) {
      if (!live.has(id)) {
        el.remove();
        this.pops.delete(id);
      }
    }

    this.composer.render(dt);
  }

  dispose(): void {
    for (const [id, v] of this.views) this.dropView(id, v);
    for (const el of this.pops.values()) el.remove();
    this.renderer.dispose();
  }
}
