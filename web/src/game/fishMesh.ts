import * as THREE from "three";

/**
 * One shark model, built in code: a torpedo body, a tall first dorsal, a
 * small second one, swept pectorals and a tail whose upper lobe is the long
 * one, all in a single geometry one unit long, snout at +X. The vertex
 * shader sweeps it into a swimming wave; the fragment shader paints one of
 * ten looks and lights it like something under water.
 */

const RINGS = 30;
const SIDES = 16;

// Half-height of the body along its length (t = 0 snout, 1 tail root).
function bodyHeight(t: number): number {
  // A pointed snout, deepest a third of the way back, a long taper to a
  // tail root still thick enough to carry the fin.
  const arch = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.9);
  const root = 0.024 * Math.min(1, t / 0.5);
  return Math.max(0.118 * arch, root);
}

const BODY_FRONT = 0.5;
const BODY_LEN = 0.8;

export function makeFishGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const along: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];

  // Body: round on top, a little flat underneath.
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const x = BODY_FRONT - t * BODY_LEN;
    const h = bodyHeight(t);
    const w = h * 0.92;
    for (let j = 0; j <= SIDES; j++) {
      const a = (j / SIDES) * Math.PI * 2;
      const cy = Math.cos(a);
      const cz = Math.sin(a);
      const flat = cy < 0 ? 0.78 : 1;
      pos.push(x, cy * h * flat, cz * w);
      const n = new THREE.Vector3(0, cy / Math.max(h * flat, 0.01), cz / Math.max(w, 0.01)).normalize();
      // Lean the normals forward at the snout so the head reads as a cone.
      if (t < 0.14) n.x += (0.14 - t) * 5;
      n.normalize();
      nor.push(n.x, n.y, n.z);
      along.push(t);
      part.push(0);
    }
  }
  const row = SIDES + 1;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * row + j;
      const b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // Flat fins: each is a small triangle fan, drawn double-sided. `kind`
  // 1 = tail, 2 = other fins; the last coordinate of a point is how far it
  // is from the fin's root (0..1), which the shader uses for dark tips.
  const fin = (pts: [number, number, number, number][], normal: [number, number, number], kind: number) => {
    const base = pos.length / 3;
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      nor.push(normal[0], normal[1], normal[2]);
      // Same bend coordinate as the body at this x, so fins never detach.
      along.push((BODY_FRONT - p[0]) / BODY_LEN);
      part.push(kind + p[3] * 0.49);
    }
    for (let i = 1; i < pts.length - 1; i++) idx.push(base, base + i, base + i + 1);
  };
  const tailX = BODY_FRONT - BODY_LEN;
  // Tail: the upper lobe is the long one.
  fin(
    [
      [tailX + 0.05, 0, 0, 0],
      [tailX - 0.05, 0.1, 0, 0.5],
      [tailX - 0.2, 0.27, 0, 1],
      [tailX - 0.11, 0.07, 0, 0.5],
      [tailX - 0.07, 0, 0, 0.2],
    ],
    [0, 0, 1],
    1,
  );
  fin(
    [
      [tailX + 0.05, 0, 0, 0],
      [tailX - 0.07, 0, 0, 0.2],
      [tailX - 0.13, -0.13, 0, 1],
      [tailX - 0.03, -0.05, 0, 0.4],
    ],
    [0, 0, 1],
    1,
  );
  // First dorsal: the fin everyone knows.
  fin(
    [
      [0.1, 0.1, 0, 0],
      [-0.06, 0.29, 0, 1],
      [-0.1, 0.26, 0, 0.9],
      [-0.09, 0.1, 0, 0],
    ],
    [0, 0, 1],
    2,
  );
  // Second dorsal, small, near the tail.
  fin(
    [
      [-0.16, 0.055, 0, 0],
      [-0.225, 0.105, 0, 1],
      [-0.235, 0.045, 0, 0],
    ],
    [0, 0, 1],
    2,
  );
  for (const s of [-1, 1]) {
    // Pectorals: long wings swept back and down.
    fin(
      [
        [0.2, -0.045, 0.08 * s, 0],
        [-0.05, -0.11, 0.31 * s, 1],
        [-0.03, -0.09, 0.2 * s, 0.6],
        [0.07, -0.045, 0.085 * s, 0],
      ],
      [0, 1, 0],
      2,
    );
    // Pelvic fins, small.
    fin(
      [
        [-0.08, -0.05, 0.035 * s, 0],
        [-0.16, -0.09, 0.09 * s, 1],
        [-0.15, -0.045, 0.03 * s, 0],
      ],
      [0, 1, 0],
      2,
    );
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Where the eyes sit on the unit model: x, y, half the distance between them, radius. */
export const EYE = { x: 0.375, y: 0.018, z: 0.062, r: 0.013 };

export interface Skin {
  name: string;
  back: number;
  belly: number;
  mark: number;
  fin: number;
  /** 0 plain, 1 stripes down the back, 2 pale spots, 3 dark fin tips. */
  pattern: number;
}

export const SKINS: Skin[] = [
  { name: "grey", back: 0x5f7183, belly: 0xf2f5f6, mark: 0x3d4a57, fin: 0x56677a, pattern: 0 },
  { name: "blue", back: 0x2f62c8, belly: 0xe9f3ff, mark: 0x1b3d86, fin: 0x2a55ad, pattern: 0 },
  { name: "tiger", back: 0x8f9368, belly: 0xf4f0dc, mark: 0x3c402c, fin: 0x7d8159, pattern: 1 },
  { name: "spotted", back: 0x1f5d73, belly: 0xe6f6fa, mark: 0xd6f3ff, fin: 0x1b5063, pattern: 2 },
  { name: "bronze", back: 0xb07a3c, belly: 0xf7ead2, mark: 0x7a5021, fin: 0x9c6a31, pattern: 0 },
  { name: "lemon", back: 0xd4bd45, belly: 0xfff8d8, mark: 0x9a8424, fin: 0xc4ad3a, pattern: 0 },
  { name: "blacktip", back: 0x8d9aa5, belly: 0xffffff, mark: 0x12171c, fin: 0x8d9aa5, pattern: 3 },
  { name: "ghost", back: 0xdfe7ec, belly: 0xffffff, mark: 0x9fb0bb, fin: 0xcfd9df, pattern: 1 },
  { name: "violet", back: 0x6d5bd0, belly: 0xe8e2ff, mark: 0xff9bd2, fin: 0x5d4cba, pattern: 2 },
  { name: "sea green", back: 0x1fa38a, belly: 0xddfff3, mark: 0x0c5a4e, fin: 0x1b8f79, pattern: 1 },
];

const VERT = /* glsl */ `
  attribute float aAlong;
  attribute float aPart;
  uniform float uPhase;
  uniform float uSwim;
  uniform float uBend;
  varying vec3 vObj;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vPart;

  void main() {
    vObj = position;
    vPart = aPart;
    vec3 p = position;
    // The swimming wave grows toward the tail; uBend leans the body into a turn.
    float t = aAlong;
    float wave = sin(uPhase - t * 4.6) * uSwim * t * t;
    float lean = uBend * t * t;
    p.z += (wave + lean) * 0.36;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uBack;
  uniform vec3 uBelly;
  uniform vec3 uMark;
  uniform vec3 uFin;
  uniform float uPattern;
  uniform float uAlpha;
  uniform float uGlow;
  uniform vec3 uRim;
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec3 vObj;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vPart;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    bool isFin = vPart > 0.5;
    float tip = isFin ? fract(vPart) / 0.49 : 0.0;

    // The back colour, with the skin's markings on it.
    vec3 base = uBack;
    float up = smoothstep(-0.2, 0.5, n.y);
    if (uPattern > 0.5 && uPattern < 1.5) {
      float stripes = smoothstep(0.35, 0.8, sin(vObj.x * 46.0 + noise(vObj.xy * 9.0) * 2.0) * 0.5 + 0.5);
      base = mix(base, uMark, stripes * up * 0.75);
    } else if (uPattern > 1.5 && uPattern < 2.5) {
      float spots = smoothstep(0.6, 0.68, noise(vec2(vObj.x * 22.0, atan(vObj.z, vObj.y) * 4.5)));
      base = mix(base, uMark, spots * up);
    }
    // Sharks are dark above and white below, with a clean line between.
    float belly = isFin ? 0.0 : smoothstep(0.12, -0.3, n.y);
    vec3 col = mix(base, uBelly, belly);
    if (isFin) {
      col = uFin;
      if (uPattern > 2.5) col = mix(col, uMark, smoothstep(0.55, 0.8, tip));
      else col = mix(col, uFin * 0.72, smoothstep(0.5, 1.0, tip));
    }
    // Gill slits on the flanks, just behind the head.
    float flank = 1.0 - smoothstep(0.35, 0.75, abs(n.y));
    float gillZone = smoothstep(0.17, 0.19, vObj.x) * smoothstep(0.285, 0.265, vObj.x);
    float slit = smoothstep(0.72, 0.95, sin(vObj.x * 250.0));
    if (!isFin) col *= 1.0 - slit * gillZone * flank * 0.5;

    vec3 light = normalize(vec3(0.25, 1.0, 0.35));
    float diff = max(dot(n, light), 0.0);
    // Sunlight wobbling through the surface.
    float caustic = noise(vWorld.xz * 0.02 + uTime * 0.3) * noise(vWorld.xz * 0.034 - uTime * 0.22);
    float lit = 0.34 + diff * 0.52 + caustic * 0.75 * max(n.y, 0.0);
    col *= lit;
    float spec = pow(max(dot(reflect(-light, n), v), 0.0), 24.0);
    col += vec3(1.0) * spec * 0.16;
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    col += uRim * rim * 0.5;
    col += uBack * uGlow * (0.3 + rim);

    float d = length(cameraPosition - vWorld);
    float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity);
    col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
    gl_FragColor = vec4(col, uAlpha);
  }
`;

export function makeFishMaterial(skin: Skin, fogColor: THREE.Color, fogDensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    uniforms: {
      uPhase: { value: 0 },
      uSwim: { value: 0.3 },
      uBend: { value: 0 },
      uBack: { value: new THREE.Color(skin.back) },
      uBelly: { value: new THREE.Color(skin.belly) },
      uMark: { value: new THREE.Color(skin.mark) },
      uFin: { value: new THREE.Color(skin.fin) },
      uPattern: { value: skin.pattern },
      uAlpha: { value: 1 },
      uGlow: { value: 0 },
      uRim: { value: new THREE.Color(0x2a8fb0) },
      uTime: { value: 0 },
      uFogColor: { value: fogColor },
      uFogDensity: { value: fogDensity },
    },
  });
}
