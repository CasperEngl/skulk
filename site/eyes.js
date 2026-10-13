import { shader } from "./gpu.js"

const watcher = document.querySelector(".watcher")
const svg = document.querySelector(".eyes")
const haze = document.querySelector(".haze")

// The right eye, in viewBox units (1 unit = 1 CSS px at desktop size). The left eye mirrors it.
const inner = [30, 3]
const outer = [76, -11]
const upper = [[35, -9], [52, -15]] // inner → outer
const lower = [[44, 11], [64, 7]] // inner → outer
// Where the lids meet: close to the lower lid, so the upper lid does most of the travel.
const seamAt = 0.22
const CYCLE = 12000

const NS = "http://www.w3.org/2000/svg"
const lerp = (a, b, t) => a + (b - a) * t
const mix = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]
const clamp = (t) => Math.min(1, Math.max(0, t))
const seg = (t, a, b) => clamp((t - a) / (b - a))
const sine = (t) => (1 - Math.cos(Math.PI * t)) / 2
const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const inQuad = (t) => t * t
const outQuad = (t) => 1 - (1 - t) ** 2
const smooth = (a, b, t) => {
  const x = clamp((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}
const seam = upper.map((c, i) => mix(lower[i], c, seamAt))

function state(t) {
  t %= CYCLE
  const lidSeam = (o) => 1 - smooth(0, 0.22, o)
  if (t < 900) return { o: 0, seam: 0 }
  if (t < 1700) return { o: 0, seam: sine(seg(t, 900, 1700)) }
  if (t < 2900) {
    const o = sine(seg(t, 1700, 2900))
    return { o, seam: lidSeam(o) }
  }
  if (t < 6200) return { o: 1, seam: 0 }
  if (t < 6360) {
    const o = t < 6270 ? 1 - inQuad(seg(t, 6200, 6270)) : outQuad(seg(t, 6270, 6360))
    return { o, seam: lidSeam(o) }
  }
  if (t < 8800) return { o: 1, seam: 0 }
  if (t < 10200) {
    const o = 1 - inOut(seg(t, 8800, 10200))
    return { o, seam: lidSeam(o) }
  }
  if (t < 11600) return { o: 0, seam: 1 - inOut(seg(t, 10200, 11600)) }
  return { o: 0, seam: 0 }
}

// Slow breathing with a faint, irregular flicker on top.
const intensity = (now) => 1 + 0.06 * Math.sin(now / 720) + 0.022 * Math.sin(now / 173) * Math.sin(now / 61)

const v2 = ([x, y]) => `vec2f(${x}, ${y})`
const N = 24
const bez = (p0, p1, p2, p3, t) => {
  const s = 1 - t
  return [0, 1].map((k) => s * s * s * p0[k] + 3 * s * s * t * p1[k] + 3 * s * t * t * p2[k] + t * t * t * p3[k])
}
const WGSL = `
struct U { a: vec4f, b: vec4f, c: vec4f, p: array<vec4f, ${N + 1}> }
const I = ${v2(inner)};
const O = ${v2(outer)};
const U1 = ${v2(upper[0])};
const U2 = ${v2(upper[1])};
const L1 = ${v2(lower[0])};
const L2 = ${v2(lower[1])};

fn bez(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
  let s = 1.0 - t;
  return s * s * s * p0 + 3.0 * s * s * t * p1 + 3.0 * s * t * t * p2 + t * t * t * p3;
}
fn dbez(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
  let s = 1.0 - t;
  return 3.0 * s * s * (p1 - p0) + 6.0 * s * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
}
// Height and slope of a lid curve (inner → outer) at x.
fn lid(x: f32, c1: vec2f, c2: vec2f) -> vec2f {
  var t = clamp((x - I.x) / (O.x - I.x), 0.0, 1.0);
  for (var k = 0; k < 5; k++) {
    let f = bez(I.x, c1.x, c2.x, O.x, t) - x;
    t = clamp(t - f / max(dbez(I.x, c1.x, c2.x, O.x, t), 1e-3), 0.0, 1.0);
  }
  let slope = dbez(I.y, c1.y, c2.y, O.y, t) / max(dbez(I.x, c1.x, c2.x, O.x, t), 1e-3);
  return vec2f(bez(I.y, c1.y, c2.y, O.y, t), slope);
}
fn ramp(e: f32) -> vec3f {
  let c0 = vec3f(0.32, 0.01, 0.025);
  let c1 = vec3f(0.92, 0.05, 0.06);
  let c2 = vec3f(1.0, 0.3, 0.16);
  let c3 = vec3f(1.0, 0.8, 0.56);
  if (e < 0.45) { return mix(c0, c1, e / 0.45); }
  if (e < 0.8) { return mix(c1, c2, (e - 0.45) / 0.35); }
  return mix(c2, c3, clamp((e - 0.8) / 0.3, 0.0, 1.0));
}
fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
fn sq(x: f32) -> f32 {
  return x * x;
}
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

struct E { eye: vec3f, light: vec3f, fill: f32 }

fn shade(q: vec2f, aa: f32) -> E {
  let o = u.b.x;
  let seamLevel = u.b.y;
  let glow = u.b.z;
  let s1 = mix(L1, U1, ${seamAt});
  let s2 = mix(L2, U2, ${seamAt});
  let lo = sqrt(o);
  let up = lid(q.x, mix(s1, U1, o), mix(s2, U2, o));
  let lw = lid(q.x, mix(s1, L1, lo), mix(s2, L2, lo));
  let upOpen = lid(q.x, U1, U2);
  let lwOpen = lid(q.x, L1, L2);

  // Signed distance to the visible aperture, from the lid polylines; the analytic lids give the sign.
  var dUp = 1e4;
  var dLo = 1e4;
  for (var i = 0; i < ${N}; i++) {
    dUp = min(dUp, segment(q, u.p[i].xy, u.p[i + 1].xy));
    dLo = min(dLo, segment(q, u.p[i].zw, u.p[i + 1].zw));
  }
  let inside = q.x > I.x && q.x < O.x && q.y > up.x && q.y < lw.x;
  let d = select(min(dUp, dLo), -min(dUp, dLo), inside);
  let xr = clamp((q.x - I.x) / (O.x - I.x), 0.0, 1.0);
  let span = exp(-sq((q.x - 53.0) / 22.0));

  // Light inside the eye: a hot core the lids cover rather than squash.
  let cy = (upOpen.x + lwOpen.x) * 0.5;
  let hh = max((lwOpen.x - upOpen.x) * 0.5, 0.5);
  let ex = (q.x - mix(I.x, O.x, 0.46)) / ((O.x - I.x) * 0.5);
  let ey = (q.y - cy) / hh;
  let core = exp(-(ex * ex * 1.3 + ey * ey * 0.8) * 1.5);
  let rim = exp(-max(-d, 0.0) / 1.1);
  let lidShade = mix(0.62, 1.0, smoothstep(0.0, 5.0, select(0.0, dUp, inside)));
  let energy = ((0.24 + 0.9 * core) * lidShade + 0.13 * rim) * glow;
  let fill = (1.0 - smoothstep(-aa, aa, d)) * clamp((lw.x - up.x) / (3.0 * aa), 0.0, 1.0);

  // Light spilling into the dark: tight and mid bloom, an implied brow and cheek, wide atmosphere.
  let outside = max(d, 0.0);
  let open = sqrt(o);
  let brow = -15.5 + sq((q.x - 55.0) / 20.0) * 6.0;
  let cheek = 12.0 + sq((q.x - 50.0) / 22.0) * 5.0;
  let crease = 1.0 - 0.45 * exp(-sq((q.y - brow - 1.8) / 2.2)) * span;
  var light = (exp(-outside / 1.4) * 0.48 + exp(-outside / 7.0) * 0.42) * crease * open;
  light += exp(-sq((q.y - brow + 4.5) / 4.5)) * span * 0.11 * open;
  light += exp(-sq((q.y - cheek) / 6.0)) * span * 0.045 * open;
  let ac = (q - vec2f(52.0, -3.0)) * vec2f(1.0, 1.35);
  light += exp(-length(ac) / 32.0) * 0.16 * open;
  var col = vec3f(1.0, 0.075, 0.07) * light * glow;

  // The seam where the lids meet: hot in the middle, fading to the corners.
  let taper = pow(sin(3.14159 * xr), 0.9);
  let seamE = seamLevel * glow * taper * (exp(-abs(d) / 0.5) * 1.05 + exp(-abs(d) / 2.6) * 0.42 + exp(-abs(d) / 9.0) * 0.12);
  col += ramp(min(seamE * 0.62, 1.0)) * min(seamE * 1.6, 1.0);

  return E(ramp(energy) * fill, col, fill);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let unit = u.c.w;
  let vb = (frag.xy / u.a.z - u.c.yz) / unit - vec2f(u.b.w, u.c.x);
  let aa = 1.0 / (u.a.z * unit);
  let r = shade(vb, aa);
  let l = shade(vec2f(-vb.x, vb.y), aa);
  let fill = max(r.fill, l.fill);
  var col = (1.0 - exp(-(r.light + l.light) * 1.15)) * (1.0 - fill) + r.eye + l.eye;
  col += (hash(frag.xy) - 0.5) / 255.0 * min(max(col.r, max(col.g, col.b)) * 60.0, 1.0) * u.a.w;
  col = max(col, vec3f(0.0));
  let a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  return vec4f(min(col, vec3f(a)), a);
}
`

const fmt = (p, s) => `${(p[0] * s).toFixed(2)} ${p[1].toFixed(2)}`
const curve = (a, c1, c2, b, s) => `M${fmt(a, s)}C${fmt(c1, s)} ${fmt(c2, s)} ${fmt(b, s)}`

function aperture(o, s) {
  const lo = Math.sqrt(o)
  const u = upper.map((c, i) => mix(seam[i], c, o))
  const l = lower.map((c, i) => mix(seam[i], c, lo))
  return `${curve(inner, u[0], u[1], outer, s)}C${fmt(l[1], s)} ${fmt(l[0], s)} ${fmt(inner, s)}Z`
}

const el = (name, attrs, parent) => {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  parent?.appendChild(node)
  return node
}

// Fallback without WebGPU: the same shapes as layered SVG gradients and blurs.
function vector() {
  const defs = el("defs", {}, svg)
  for (const [id, sd] of [["b2", 1.8], ["b5", 5], ["b10", 10]]) {
    const f = el("filter", { id: `eye-${id}`, filterUnits: "userSpaceOnUse", x: -110, y: -60, width: 220, height: 120 }, defs)
    el("feGaussianBlur", { stdDeviation: sd }, f)
  }
  const gaze = el("g", {}, svg)
  const eyes = [-1, 1].map((s) => {
    const side = s < 0 ? "l" : "r"
    const core = el("radialGradient", { id: `eye-core-${side}`, gradientUnits: "userSpaceOnUse", cx: 0, cy: 0, r: 1, gradientTransform: `translate(${51 * s} -3) rotate(${-10 * s}) scale(30 14)` }, defs)
    for (const [offset, color] of [
      [0, "#ffe2c8"],
      [0.16, "#ffa078"],
      [0.38, "#ff4430"],
      [0.72, "#e8121e"],
      [1, "#8c0814"],
    ])
      el("stop", { offset, "stop-color": color }, core)
    const fade = el("linearGradient", { id: `eye-seam-${side}`, gradientUnits: "userSpaceOnUse", x1: inner[0] * s, x2: outer[0] * s, y1: 0, y2: 0 }, defs)
    for (const [offset, alpha] of [[0, 0], [0.46, 1], [1, 0]]) el("stop", { offset, "stop-color": "#ff4a38", "stop-opacity": alpha }, fade)
    const g = el("g", {}, gaze)
    return {
      s,
      wide: el("path", { fill: "#ff1020", filter: "url(#eye-b10)" }, g),
      mid: el("path", { fill: "#ff1a22", filter: "url(#eye-b5)" }, g),
      bloom: el("path", { fill: "#ff2a26", filter: "url(#eye-b2)" }, g),
      fill: el("path", { fill: `url(#eye-core-${side})` }, g),
      seamGlow: el("path", { d: curve(inner, seam[0], seam[1], outer, s), fill: "none", stroke: `url(#eye-seam-${side})`, "stroke-width": 3.5, filter: "url(#eye-b2)" }, g),
      seam: el("path", { d: curve(inner, seam[0], seam[1], outer, s), fill: "none", stroke: `url(#eye-seam-${side})`, "stroke-width": 0.9 }, g),
    }
  })
  return ({ o, seam: level }, glow, look) => {
    for (const eye of eyes) {
      const d = aperture(o, eye.s)
      for (const p of [eye.wide, eye.mid, eye.bloom, eye.fill]) p.setAttribute("d", d)
      eye.wide.setAttribute("opacity", (0.3 * glow * Math.sqrt(o)).toFixed(3))
      eye.mid.setAttribute("opacity", (0.45 * glow * Math.sqrt(o)).toFixed(3))
      eye.bloom.setAttribute("opacity", (0.85 * glow * Math.sqrt(o)).toFixed(3))
      eye.seam.setAttribute("opacity", (level * glow).toFixed(3))
      eye.seamGlow.setAttribute("opacity", (level * glow).toFixed(3))
    }
    gaze.setAttribute("transform", `translate(${look.x.toFixed(2)} ${look.y.toFixed(2)})`)
    if (haze) haze.style.opacity = Math.max(Math.sqrt(o) * glow, level * 0.3).toFixed(3)
  }
}

// WebGPU: the eyes as a signed-distance field, lit procedurally.
async function procedural() {
  const canvas = document.createElement("canvas")
  canvas.className = "eyes-gl"
  canvas.setAttribute("aria-hidden", "true")
  const draw = await shader(canvas, WGSL, 12 + (N + 1) * 4)
  if (!draw) return null
  watcher.append(canvas)
  watcher.classList.add("gpu")
  const data = new Float32Array(12 + (N + 1) * 4)
  let box = { dpr: 1, unit: 1, ox: 0, oy: 0 }
  const fit = () => {
    const c = canvas.getBoundingClientRect()
    const e = svg.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(c.width * dpr)
    canvas.height = Math.round(c.height * dpr)
    box = { dpr, unit: e.width / 200, ox: e.left - c.left + e.width / 2, oy: e.top - c.top + e.height / 2 }
  }
  let last = null
  fit()
  new ResizeObserver(() => {
    fit()
    if (last) paint(...last)
  }).observe(canvas)
  const paint = ({ o, seam: level }, glow, look) => {
    last = [{ o, seam: level }, glow, { ...look }]
    data.set([canvas.width, canvas.height, box.dpr, dither, o, level, glow, look.x, look.y, box.ox, box.oy, box.unit])
    const lo = Math.sqrt(o)
    const u = upper.map((c, i) => mix(seam[i], c, o))
    const l = lower.map((c, i) => mix(seam[i], c, lo))
    for (let i = 0; i <= N; i++) {
      const t = i / N
      data.set([...bez(inner, u[0], u[1], outer, t), ...bez(inner, l[0], l[1], outer, t)], 12 + i * 4)
    }
    draw(data)
  }
  return paint
}

const still = matchMedia("(prefers-reduced-motion: reduce)").matches
const dither = document.documentElement.dataset.dither === "off" ? 0 : 1
const look = { x: 0, y: 0, tx: 0, ty: 0 }
let render = vector()
let frozen = null
const frame = (t, now) => render(state(t), still ? 1 : intensity(now), look)

window.__eyesAt = (p) => {
  frozen = p
  frame(p * CYCLE, p * CYCLE)
}
window.__eyesReady = procedural().then((gpu) => {
  if (gpu) render = gpu
  if (frozen !== null) frame(frozen * CYCLE, frozen * CYCLE)
  else if (still) frame(4000, 0)
  return gpu ? "webgpu" : "svg"
})

if (still) {
  frame(4000, 0)
} else {
  if (matchMedia("(pointer: fine)").matches) {
    addEventListener("pointermove", (event) => {
      const box = svg.getBoundingClientRect()
      look.tx = (clamp((event.clientX - (box.left + box.width / 2)) / 1000 + 0.5) * 2 - 1) * 2
      look.ty = (clamp((event.clientY - (box.top + box.height / 2)) / 800 + 0.5) * 2 - 1) * 1
    })
  }
  let visible = true
  new IntersectionObserver(([entry]) => (visible = entry.isIntersecting)).observe(watcher)
  const start = performance.now()
  const tick = (now) => {
    if (frozen !== null) return
    requestAnimationFrame(tick)
    if (!visible) return
    look.x += (look.tx - look.x) * 0.05
    look.y += (look.ty - look.y) * 0.05
    frame(now - start, now)
  }
  requestAnimationFrame(tick)
}
