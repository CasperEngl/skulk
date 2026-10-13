import { shader } from "./gpu.js"

const figure = document.querySelector(".timeline")
const stage = figure?.querySelector(".stage")
const svg = figure?.querySelector(".flow")
const steps = figure ? [...figure.querySelectorAll(".steps li")] : []

const NS = "http://www.w3.org/2000/svg"
const CYCLE = 10000
const DOTS = 7
const MAX_POINTS = 48
const PARTICLES = 18

const clamp = (t) => Math.min(1, Math.max(0, t))
const seg = (t, a, b) => clamp((t - a) / (b - a))
const sine = (t) => (1 - Math.cos(Math.PI * t)) / 2
const outCubic = (t) => 1 - (1 - t) ** 3
const lerp = (a, b, t) => a + (b - a) * t

// Moments in the cycle (ms). The session line draws along these pieces in order.
const T = { start: 300, watch: 1800, asleep: 2600, event: 6600, rise: 6750, landed: 7350, end: 8700, fade: 9300 }

function geometry(width, height) {
  const narrow = width < 520
  const yT = Math.round(height * 0.3)
  const yB = Math.round(height * 0.78)
  const d = narrow ? 34 : 64
  const xA = width * 0.24
  const xB = width * 0.76
  const a0 = [xA - d / 2, yT]
  const a1 = [xA + d / 2, yB]
  const b0 = [xB - d / 2, yB]
  const b1 = [xB + d / 2, yT]
  const curve = (p, q) => [p, [p[0] + d * 0.5, p[1]], [q[0] - d * 0.5, q[1]], q]
  const pieces = [
    { kind: "line", p: [[0, yT], a0] },
    { kind: "curve", p: curve(a0, a1) },
    { kind: "line", p: [a1, b0] },
    { kind: "curve", p: curve(b0, b1) },
    { kind: "line", p: [b1, [width, yT]] },
  ]
  const at = (piece, t) => {
    const p = piece.p
    if (piece.kind === "line") return [lerp(p[0][0], p[1][0], t), lerp(p[0][1], p[1][1], t)]
    const s = 1 - t
    return [0, 1].map((k) => s * s * s * p[0][k] + 3 * s * s * t * p[1][k] + 3 * s * t * t * p[2][k] + t * t * t * p[3][k])
  }
  const awake = (y) => clamp((yB - y) / (yB - yT))
  // Polyline with arc length, for the shader and the head position.
  const points = []
  let length = 0
  for (const [i, piece] of pieces.entries()) {
    const n = piece.kind === "line" ? 1 : 18
    piece.start = length
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const p = at(piece, k / n)
      const prev = points.at(-1)
      if (prev) length += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      points.push([p[0], p[1], length, awake(p[1])])
    }
    piece.length = length - piece.start
  }
  const left = a1[0] + (narrow ? 14 : 22)
  const dots = Array.from({ length: DOTS }, (_, i) => [lerp(left, b0[0], i / (DOTS - 1)), yB])
  return { width, height, yT, yB, pieces, points, length, dots, at, awake, event: b0, land: b1 }
}

// Where the head is: which piece, and how far along it.
function head(t) {
  t %= CYCLE
  if (t < T.start) return { piece: 0, u: 0, visible: 0 }
  if (t < T.watch) return { piece: 0, u: sine(seg(t, T.start, T.watch)) * 0.5 + seg(t, T.start, T.watch) * 0.5, visible: 1 }
  if (t < T.asleep) return { piece: 1, u: sine(seg(t, T.watch, T.asleep)), visible: 1 }
  if (t < T.event) return { piece: 2, u: seg(t, T.asleep, T.event), visible: 1 }
  if (t < T.rise) return { piece: 3, u: 0, visible: 1 }
  if (t < T.landed) return { piece: 3, u: outCubic(seg(t, T.rise, T.landed)), visible: 1 }
  if (t < T.end) return { piece: 4, u: sine(seg(t, T.landed, T.end)), visible: 1 }
  return { piece: 4, u: 1, visible: 1 }
}

function state(t, g) {
  t %= CYCLE
  const h = head(t)
  const piece = g.pieces[h.piece]
  const s = piece.start + piece.length * h.u
  const [x, y] = g.at(piece, h.u)
  const fade = 1 - sine(seg(t, T.fade, CYCLE))
  // Each daemon check pings as the sleeping session passes it; the last one is the event.
  const pings = g.dots.map(([dx], i) => {
    if (i === DOTS - 1) return t >= T.event ? (t - T.event) / 1000 : -1
    const when = T.asleep + ((dx - g.pieces[2].p[0][0]) / g.pieces[2].length) * (T.event - T.asleep)
    return t >= when ? (t - when) / 1000 : -1
  })
  const step = t >= T.start && t < T.asleep ? 0 : t >= T.asleep && t < T.event ? 1 : t >= T.event && t < T.fade ? 2 : -1
  return {
    s,
    x,
    y,
    awake: g.awake(y),
    visible: h.visible * fade,
    fade: t < T.start ? 0 : fade,
    pings,
    flare: t >= T.event ? (t - T.event) / 1000 : -1,
    land: t >= T.landed ? (t - T.landed) / 1000 : -1,
    step,
    piece: h.piece,
    u: h.u,
  }
}

const el = (name, attrs, parent) => {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  parent?.appendChild(node)
  return node
}

function pathFor(piece) {
  const p = piece.p.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`)
  return piece.kind === "line" ? `M${p[0]}L${p[1]}` : `M${p[0]}C${p[1]} ${p[2]} ${p[3]}`
}

// Crisp layer: the path, its drawn progress, the daemon's dots and the head.
function vector() {
  let g
  let nodes
  const build = (geo) => {
    g = geo
    svg.replaceChildren()
    svg.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`)
    const defs = el("defs", {}, svg)
    for (const [id, a, b] of [["dip", g.yT, g.yB], ["rise", g.yT, g.yB]]) {
      const grad = el("linearGradient", { id: `flow-${id}`, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: a, y2: b }, defs)
      el("stop", { offset: 0, "stop-color": "#fff4ee" }, grad)
      el("stop", { offset: 1, "stop-color": "#ff6a52", "stop-opacity": 0.5 }, grad)
    }
    const glow = el("filter", { id: "flow-glow", filterUnits: "userSpaceOnUse", x: -60, y: -60, width: g.width + 120, height: g.height + 120 }, defs)
    el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 3, result: "blur" }, glow)
    el("feFlood", { "flood-color": "#ff3a22", "flood-opacity": 0.85 }, glow)
    el("feComposite", { in2: "blur", operator: "in", result: "tint" }, glow)
    const merge = el("feMerge", {}, glow)
    el("feMergeNode", { in: "tint" }, merge)
    el("feMergeNode", { in: "SourceGraphic" }, merge)
    const ghost = g.pieces.map(pathFor).join("")
    el("path", { d: ghost, fill: "none", stroke: "rgba(255,255,255,0.07)", "stroke-width": 1 }, svg)
    const style = [
      { stroke: "#fff4ee", "stroke-width": 2, class: "lit" },
      { stroke: "url(#flow-dip)", "stroke-width": 1.6, class: "lit" },
      { stroke: "#ff6a52", "stroke-width": 1, "stroke-opacity": 0.32 },
      { stroke: "url(#flow-rise)", "stroke-width": 1.6, class: "lit" },
      { stroke: "#fff4ee", "stroke-width": 2, class: "lit" },
    ]
    const drawn = g.pieces.map((piece, i) =>
      el("path", { d: pathFor(piece), fill: "none", "stroke-linecap": "round", pathLength: 1, "stroke-dasharray": "1 2", "stroke-dashoffset": 1, ...style[i] }, svg),
    )
    const dots = g.dots.map(([x, y], i) => ({
      ring: el("circle", { cx: x, cy: y, r: 2, fill: "none", stroke: i === DOTS - 1 ? "#ff3a24" : "#ff7a62", "stroke-width": 1, opacity: 0 }, svg),
      dot: el("circle", { cx: x, cy: y, r: i === DOTS - 1 ? 2.2 : 1.6, fill: "#ffffff", "fill-opacity": 0.18 }, svg),
    }))
    const landRing = el("circle", { cx: g.land[0], cy: g.land[1], r: 3, fill: "none", stroke: "#fff4ee", "stroke-width": 1, opacity: 0 }, svg)
    const headDot = el("circle", { r: 2, fill: "#fff4ee", class: "lit" }, svg)
    nodes = { drawn, dots, landRing, headDot }
  }
  const render = (st, breath) => {
    if (!nodes) return
    for (const [i, path] of nodes.drawn.entries()) {
      const local = i < st.piece ? 1 : i === st.piece ? st.u : 0
      path.setAttribute("stroke-dashoffset", (1 - local).toFixed(4))
      path.setAttribute("opacity", (st.fade * (i === 2 ? breath : 1)).toFixed(3))
    }
    for (const [i, { ring, dot }] of nodes.dots.entries()) {
      const age = st.pings[i]
      const event = i === DOTS - 1
      if (age < 0) {
        dot.setAttribute("fill", "#ffffff")
        dot.setAttribute("fill-opacity", 0.18)
        dot.setAttribute("r", event ? 2.2 : 1.6)
        ring.setAttribute("opacity", 0)
        continue
      }
      const k = Math.exp(-age * 3)
      dot.setAttribute("fill", event ? "#ff3a24" : "#ff7a62")
      dot.setAttribute("fill-opacity", ((event ? 1 : 0.5 + 0.5 * k) * st.fade).toFixed(3))
      dot.setAttribute("r", (event ? 3 + 1.5 * Math.exp(-age * 4) : 1.6 + 0.8 * k).toFixed(2))
      const spread = event ? 3 + outCubic(clamp(age / 1.1)) * 24 : 2 + outCubic(clamp(age / 0.8)) * 9
      ring.setAttribute("r", spread.toFixed(2))
      ring.setAttribute("opacity", ((event ? 0.8 : 0.45) * Math.max(0, 1 - age / (event ? 1.1 : 0.8)) * st.fade).toFixed(3))
    }
    const la = st.land
    nodes.landRing.setAttribute("r", (3 + outCubic(clamp(la / 0.9)) * 18).toFixed(2))
    nodes.landRing.setAttribute("opacity", la < 0 ? 0 : (0.6 * Math.max(0, 1 - la / 0.9)).toFixed(3))
    const r = lerp(1.5, 3, st.awake)
    nodes.headDot.setAttribute("cx", st.x.toFixed(2))
    nodes.headDot.setAttribute("cy", st.y.toFixed(2))
    nodes.headDot.setAttribute("r", r.toFixed(2))
    nodes.headDot.setAttribute("fill", st.awake > 0.5 ? "#fff4ee" : "#ff7a62")
    nodes.headDot.setAttribute("opacity", (st.visible * lerp(0.75 * breath, 1, st.awake)).toFixed(3))
  }
  return { build, render }
}

const WGSL = `
struct U { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, dots: array<vec4f, ${DOTS}>, p: array<vec4f, ${MAX_POINTS}> }

fn sq(x: f32) -> f32 { return x * x; }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn h1(n: f32) -> f32 { return fract(sin(n * 91.345) * 47453.5453); }

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let q = frag.xy / u.a.z - u.c.xy;
  let headS = u.b.x;
  let headP = u.b.yz;
  let headAwake = u.b.w;
  let fade = u.c.z;
  let breath = u.c.w;
  let yT = u.d.x;
  let n = i32(u.d.y);
  let visible = u.d.z;
  let ember = vec3f(1.0, 0.16, 0.07);
  let warm = vec3f(1.0, 0.72, 0.55);

  // Glow along the drawn path: bright and wide where awake, faint where asleep.
  var path = 0.0;
  var core = 0.0;
  var sky = 0.0;
  for (var i = 0; i < n - 1; i++) {
    let a = u.p[i];
    var b = u.p[i + 1];
    if (a.z >= headS) { break; }
    if (b.z > headS) {
      let k = (headS - a.z) / max(b.z - a.z, 1e-3);
      b = vec4f(mix(a.xy, b.xy, k), headS, mix(a.w, b.w, k));
    }
    let pa = q - a.xy;
    let ba = b.xy - a.xy;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    let dd = length(pa - ba * h);
    let aw = mix(a.w, b.w, h);
    let weight = mix(0.06 * breath, 1.0, aw);
    path = max(path, weight * (0.5 * exp(-dd / (1.4 + 2.6 * aw)) + 0.24 * exp(-dd / (5.0 + 13.0 * aw))));
    core = max(core, aw * exp(-dd / 1.1));
    sky = max(sky, aw * exp(-dd / 52.0) * smoothstep(yT + 3.0, yT - 24.0, q.y));
  }
  var col = ember * (path + sky * 0.1) + warm * core * 0.9 + warm * sky * 0.025;

  // The head: a hot spark while awake, a dim ember while asleep.
  let dh = length(q - headP);
  let spark = (exp(-dh / (1.6 + 2.0 * headAwake)) * 1.1 + exp(-dh / (8.0 + 16.0 * headAwake)) * 0.4) * mix(0.28 * breath, 1.0, headAwake) * visible;
  col += mix(ember, warm, headAwake * 0.6) * spark;

  // The daemon's checks, each pinging as the sleeping session passes.
  for (var i = 0; i < ${DOTS}; i++) {
    let dot = u.dots[i];
    let dd = length(q - dot.xy);
    let age = dot.z;
    if (dot.w > 0.5) { continue; }
    col += vec3f(1.0, 0.4, 0.3) * exp(-dd / 2.2) * 0.07 * breath;
    if (age >= 0.0) {
      let k = exp(-age * 3.0);
      col += ember * (exp(-dd / 3.5) * (0.25 + 0.7 * k) + exp(-abs(dd - (2.0 + 9.0 * (1.0 - exp(-age * 4.0)))) / 1.2) * 0.3 * k) * fade;
    }
  }

  // The event: one dot flares hot, throws a ring and a spray of embers.
  let ev = u.dots[${DOTS - 1}];
  let f = ev.z;
  let df = length(q - ev.xy);
  col += vec3f(1.0, 0.4, 0.3) * exp(-df / 2.4) * 0.08;
  if (f >= 0.0) {
    let burst = exp(-f * 1.8) * (exp(-df / 4.5) * 2.2 + exp(-df / 24.0) * 0.8);
    let steady = exp(-df / 4.0) * 0.55 + exp(-df / 14.0) * 0.18;
    let ring = exp(-abs(df - (4.0 + 70.0 * (1.0 - exp(-f * 2.2)))) / 2.0) * exp(-f * 2.4) * 0.7;
    col += (ember * (steady + ring) + mix(ember, warm, 0.7) * burst) * fade;
    for (var k = 0; k < ${PARTICLES}; k++) {
      let id = f32(k);
      let ang = -1.5708 + (h1(id) - 0.5) * 2.6;
      let speed = 26.0 + 52.0 * h1(id + 7.1);
      let life = exp(-f * (1.1 + 1.4 * h1(id + 3.3)));
      let travel = speed * (1.0 - exp(-f * 2.0)) / 2.0;
      let pos = ev.xy + vec2f(cos(ang), sin(ang)) * travel + vec2f(0.0, -9.0 * f);
      let dp = length(q - pos);
      col += mix(ember, warm, 0.5) * (exp(-dp / 0.9) * 0.9 + exp(-dp / 3.5) * 0.15) * life * fade;
    }
  }

  // The message landing back in the awake world.
  let la = u.e.z;
  if (la >= 0.0) {
    let dl = length(q - u.e.xy);
    let flash = exp(-la * 2.2) * (exp(-dl / 3.5) * 1.5 + exp(-dl / 20.0) * 0.55);
    let ring = exp(-abs(dl - (3.0 + 30.0 * (1.0 - exp(-la * 3.0)))) / 1.5) * exp(-la * 2.6) * 0.45;
    col += (warm * flash + ember * ring) * fade;
  }

  col = 1.0 - exp(-col * 1.1);
  col += (hash(frag.xy) - 0.5) / 255.0 * min(max(col.r, max(col.g, col.b)) * 60.0, 1.0);
  col = max(col, vec3f(0.0));
  let alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  return vec4f(min(col, vec3f(alpha)), alpha);
}
`

async function procedural() {
  const canvas = document.createElement("canvas")
  canvas.className = "flow-gl"
  canvas.setAttribute("aria-hidden", "true")
  const floats = 20 + DOTS * 4 + MAX_POINTS * 4
  const draw = await shader(canvas, WGSL, floats)
  if (!draw) return null
  figure.prepend(canvas)
  figure.classList.add("gpu")
  const data = new Float32Array(floats)
  let box = { dpr: 1, ox: 0, oy: 0 }
  const fit = () => {
    const c = canvas.getBoundingClientRect()
    const s = stage.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(c.width * dpr)
    canvas.height = Math.round(c.height * dpr)
    box = { dpr, ox: s.left - c.left, oy: s.top - c.top }
  }
  return {
    fit,
    render: (st, breath, g) => {
      data.fill(0)
      data.set([canvas.width, canvas.height, box.dpr, 0, st.s, st.x, st.y, st.awake, box.ox, box.oy, st.fade, breath, g.yT, g.points.length, st.visible, 0, 0, 0, st.land >= 0 ? st.land : -1, 0])
      data.set([g.land[0], g.land[1], st.land, 0], 16)
      g.dots.forEach(([x, y], i) => data.set([x, y, st.pings[i], 0], 20 + i * 4))
      data.set([...g.event, st.flare, 1], 20 + (DOTS - 1) * 4)
      g.points.slice(0, MAX_POINTS).forEach((p, i) => data.set(p, 20 + DOTS * 4 + i * 4))
      draw(data)
    },
  }
}

if (figure && stage && svg) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches
  const crisp = vector()
  let gpu = null
  let g = null
  let clock = still ? T.end + 100 : 0
  let frozen = null
  const breathAt = (now) => (still ? 1 : 0.8 + 0.2 * Math.sin(now / 900))
  const paint = (t, now) => {
    if (!g) return
    const st = state(t, g)
    const breath = breathAt(now)
    crisp.render(st, breath)
    gpu?.render(st, breath, g)
    for (const [i, li] of steps.entries()) li.classList.toggle("on", still || st.step === i)
  }
  const layout = () => {
    const r = stage.getBoundingClientRect()
    g = geometry(r.width, r.height)
    crisp.build(g)
    gpu?.fit()
    paint(frozen ?? clock, frozen ?? clock)
  }
  layout()
  new ResizeObserver(layout).observe(stage)

  window.__flowAt = (t) => {
    frozen = t
    paint(t, t)
  }
  window.__flowReady = procedural().then((renderer) => {
    gpu = renderer
    gpu?.fit()
    paint(frozen ?? clock, frozen ?? clock)
    return gpu ? "webgpu" : "svg"
  })

  if (!still) {
    let visible = false
    let started = false
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        started ||= visible
      },
      { threshold: 0.35 },
    ).observe(figure)
    let last = performance.now()
    const tick = (now) => {
      requestAnimationFrame(tick)
      const dt = now - last
      last = now
      if (frozen !== null || !visible || !started) return
      clock = (clock + dt) % CYCLE
      paint(clock, now)
    }
    requestAnimationFrame(tick)
  }
}
