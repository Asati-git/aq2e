// Polymarket Cosmos — a 3D space view of active prediction markets.
// Each event is rendered as a glowing orb; size = log(volume), color = "heat" by 24h volume.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ─────────────────────────────────────── Data ──────────────────────────────────────
const API_URL =
  "https://gamma-api.polymarket.com/events/keyset?active=true&closed=false&limit=120&order=volume24hr&ascending=false";
const FALLBACK_URL = "./data/events.json";

async function fetchEvents() {
  // Try the live API first; fall back to the bundled snapshot if CORS or the
  // network blocks us. Either way we get a populated cosmos.
  try {
    const res = await fetch(API_URL, { mode: "cors" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    const events = json.events ?? json;
    if (Array.isArray(events) && events.length) {
      return { events, source: "live" };
    }
    throw new Error("empty response");
  } catch (err) {
    console.warn("[cosmos] live fetch failed, using snapshot:", err.message);
    const res = await fetch(FALLBACK_URL);
    const json = await res.json();
    return { events: json.events ?? [], source: "snapshot" };
  }
}

const fmtMoney = (n) => {
  if (!n && n !== 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
const polyUrl = (slug) => `https://polymarket.com/event/${slug ?? ""}`;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pseudo-random with a fixed seed so the cosmos layout is stable between loads.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────── Scene setup ──────────────────────────────────
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x03050d, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05071a, 0.0009);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 60, 320);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.7;
controls.panSpeed = 0.6;
controls.minDistance = 30;
controls.maxDistance = 900;
controls.enablePan = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;

// Subtle ambient + a couple of soft fill lights (orbs are mostly emissive).
scene.add(new THREE.AmbientLight(0x4060a0, 0.3));
const keyLight = new THREE.DirectionalLight(0xb0c8ff, 0.4);
keyLight.position.set(200, 400, 300);
scene.add(keyLight);
const rimLight = new THREE.PointLight(0xb066ff, 1.0, 1200, 2);
rimLight.position.set(-200, -120, -200);
scene.add(rimLight);

// ─────────────────────────────────── Star field ──────────────────────────────────
function buildStars(count, radius, sizeMin, sizeMax, brightness) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phase = new Float32Array(count);
  const rand = mulberry32(7);

  for (let i = 0; i < count; i++) {
    // Distribute on a sphere with bias toward the equatorial band for cinematic feel.
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = radius * (0.6 + rand() * 0.4);
    const sinPhi = Math.sqrt(1 - u * u);
    positions[i * 3 + 0] = Math.cos(theta) * sinPhi * r;
    positions[i * 3 + 1] = u * r * 0.55;
    positions[i * 3 + 2] = Math.sin(theta) * sinPhi * r;

    const tint = rand();
    let color;
    if (tint < 0.6) color = new THREE.Color().setHSL(0.6, 0.1, 0.85 + rand() * 0.15);
    else if (tint < 0.85) color = new THREE.Color().setHSL(0.55, 0.4, 0.7 + rand() * 0.2);
    else color = new THREE.Color().setHSL(0.85, 0.5, 0.7 + rand() * 0.2);
    color.toArray(colors, i * 3);

    sizes[i] = sizeMin + rand() * (sizeMax - sizeMin);
    phase[i] = rand() * Math.PI * 2;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uBrightness: { value: brightness },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uTime;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        float t = sin(uTime * 1.2 + aPhase) * 0.5 + 0.5;
        vTwinkle = mix(0.55, 1.0, t);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (220.0 / -mv.z) * vTwinkle;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uBrightness;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float core = smoothstep(0.5, 0.0, d);
        float halo = smoothstep(0.5, 0.15, d) * 0.45;
        float a = core + halo;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor * (uBrightness + vTwinkle * 0.4), a);
      }
    `,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  return new THREE.Points(geom, mat);
}

const starsFar = buildStars(2400, 1800, 0.6, 1.4, 0.55);
const starsNear = buildStars(900, 700, 1.0, 2.4, 0.85);
scene.add(starsFar, starsNear);

// ─────────────────────────────── Distant nebula billboards ───────────────────────
function buildNebula() {
  const sprites = new THREE.Group();
  const colors = [0x7b2bff, 0x00bcd4, 0xff3d8b, 0x4f6dff];
  const rand = mulberry32(42);
  for (let i = 0; i < 6; i++) {
    const c = new THREE.Color(colors[i % colors.length]);
    const tex = makeRadialTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    const r = 600 + rand() * 400;
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const sinPhi = Math.sqrt(1 - u * u);
    s.position.set(Math.cos(t) * sinPhi * r, u * r * 0.45, Math.sin(t) * sinPhi * r);
    const scale = 320 + rand() * 280;
    s.scale.set(scale, scale, 1);
    s.userData.spin = (rand() - 0.5) * 0.0004;
    sprites.add(s);
  }
  return sprites;
}

function makeRadialTexture(color) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const r = Math.round(color.r * 255);
  const gr = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  g.addColorStop(0, `rgba(${r},${gr},${b},0.9)`);
  g.addColorStop(0.4, `rgba(${r},${gr},${b},0.35)`);
  g.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const nebula = buildNebula();
scene.add(nebula);

// ───────────────────────────────── Glow sprite (orb halo) ─────────────────────────
const haloTexture = (() => {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(0.55, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

// ───────────────────────────────── Event orbs ────────────────────────────────────
const orbsGroup = new THREE.Group();
scene.add(orbsGroup);

const orbGeometry = new THREE.IcosahedronGeometry(1, 3);

function createOrb(event, layout) {
  const v = event.volume || 0;
  const v24 = event.volume24hr || 0;

  // Heat from 24h volume against the field maximum.
  const heat = clamp(Math.log10(1 + v24) / Math.log10(1 + layout.maxV24), 0, 1);
  const colorCool = new THREE.Color(0x00d2ff);
  const colorMid = new THREE.Color(0xb066ff);
  const colorHot = new THREE.Color(0xff3d8b);
  const color = new THREE.Color();
  if (heat < 0.5) color.lerpColors(colorCool, colorMid, heat / 0.5);
  else color.lerpColors(colorMid, colorHot, (heat - 0.5) / 0.5);

  // Radius from total volume — log scaled so blockbusters don't drown out the rest.
  const sizeT = clamp(Math.log10(1 + v) / Math.log10(1 + layout.maxV), 0, 1);
  const radius = 1.6 + sizeT * 5.2;

  const mat = new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.18),
    emissive: color.clone(),
    emissiveIntensity: 1.1 + heat * 0.9,
    roughness: 0.35,
    metalness: 0.1,
  });

  const mesh = new THREE.Mesh(orbGeometry, mat);
  mesh.scale.setScalar(radius);

  // Outer halo billboard — gives the bloomed glow a soft falloff.
  const haloMat = new THREE.SpriteMaterial({
    map: haloTexture,
    color: color.clone(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.95,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(radius * 4.2);
  mesh.add(halo);

  // Distribute orbs in a flattened-disk galaxy with golden-angle spiral arms.
  const i = layout.index;
  const total = layout.total;
  const rand = layout.rand;
  const tIdx = i / Math.max(1, total - 1);
  const armCount = 4;
  const arm = i % armCount;
  const tArm = (i - arm) / armCount / (total / armCount);
  const baseR = 50 + Math.pow(tArm, 0.6) * 220;
  const angle = arm * ((Math.PI * 2) / armCount) + tArm * Math.PI * 6 + rand() * 0.4;
  const rJitter = (rand() - 0.5) * 25;
  const yJitter = (rand() - 0.5) * 60 * (1 - tArm * 0.6);
  const r = baseR + rJitter;
  mesh.position.set(Math.cos(angle) * r, yJitter, Math.sin(angle) * r);

  mesh.userData = {
    event,
    baseColor: color.clone(),
    baseEmissive: 1.1 + heat * 0.9,
    baseScale: radius,
    haloMat,
    haloBaseScale: radius * 4.2,
    orbitAxis: new THREE.Vector3(rand() - 0.5, 1, rand() - 0.5).normalize(),
    orbitSpeed: 0.02 + rand() * 0.06,
    bobPhase: rand() * Math.PI * 2,
    bobAmt: 0.6 + rand() * 1.6,
    heat,
    sizeT,
    pulsePhase: rand() * Math.PI * 2,
    homeY: yJitter,
    spinSpeed: (rand() - 0.5) * 0.4,
  };

  return mesh;
}

// ─────────────────────────────────── Picking ─────────────────────────────────────
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 1.2 };
const pointer = new THREE.Vector2();
let hovered = null;
let selected = null;

function setPointer(e) {
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const y = e.touches ? e.touches[0].clientY : e.clientY;
  pointer.x = (x / window.innerWidth) * 2 - 1;
  pointer.y = -(y / window.innerHeight) * 2 + 1;
  return { x, y };
}

function pick() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(orbsGroup.children, false);
  return hits.length ? hits[0].object : null;
}

// ─────────────────────────────────── Camera fly-to ───────────────────────────────
let flight = null;

function flyTo(target, lookAt, duration = 1100) {
  flight = {
    t0: performance.now(),
    duration,
    fromPos: camera.position.clone(),
    toPos: target.clone(),
    fromTarget: controls.target.clone(),
    toTarget: lookAt.clone(),
  };
  controls.autoRotate = false;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateFlight() {
  if (!flight) return;
  const t = clamp((performance.now() - flight.t0) / flight.duration, 0, 1);
  const k = easeInOutCubic(t);
  camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
  controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
  if (t >= 1) flight = null;
}

function focusOrb(orb) {
  if (!orb) return;
  const orbPos = orb.position.clone();
  const dist = 18 + orb.userData.baseScale * 4;
  const dir = camera.position.clone().sub(orbPos).normalize();
  const target = orbPos.clone().add(dir.multiplyScalar(dist));
  target.y += 4;
  flyTo(target, orbPos);
}

// ───────────────────────────────── Postprocessing ────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.05, // strength
  0.85, // radius
  0.18, // threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ──────────────────────────────────── UI bindings ────────────────────────────────
const $ = (id) => document.getElementById(id);
const tooltip = $("tooltip");
const panel = $("panel");

function setTooltip(orb, x, y) {
  if (!orb) {
    tooltip.classList.remove("show");
    return;
  }
  const e = orb.userData.event;
  const m0 = e.markets?.[0];
  const odds = m0 ? readYesPct(m0) : null;
  tooltip.innerHTML = `
    <div class="tooltip-title">${escapeHtml(e.title || "Untitled market")}</div>
    <div class="tooltip-meta">
      ${fmtMoney(e.volume)} vol · ${fmtMoney(e.volume24hr)} 24h${
        odds != null ? ` · ${odds}% YES` : ""
      }
    </div>`;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.add("show");
}

function readYesPct(market) {
  try {
    const prices = JSON.parse(market.outcomePrices ?? "[]");
    const outcomes = JSON.parse(market.outcomes ?? "[]");
    const yesIdx = outcomes.findIndex((o) => /yes/i.test(o));
    const idx = yesIdx >= 0 ? yesIdx : 0;
    const p = parseFloat(prices[idx]);
    if (!Number.isFinite(p)) return null;
    return Math.round(p * 100);
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function showPanel(orb) {
  const e = orb.userData.event;
  $("panel-title").textContent = e.title || "Untitled market";
  $("panel-desc").textContent = e.description || "";
  $("panel-volume").textContent = fmtMoney(e.volume);
  $("panel-volume24").textContent = fmtMoney(e.volume24hr);
  $("panel-liquidity").textContent = fmtMoney(e.liquidity);
  $("panel-end").textContent = fmtDate(e.endDate);
  const img = $("panel-image");
  const src = e.image || e.icon;
  img.style.backgroundImage = src ? `url('${src}')` : "none";

  const list = $("panel-markets");
  list.innerHTML = "";
  const markets = (e.markets || []).slice(0, 6);
  for (const m of markets) {
    const pct = readYesPct(m);
    const row = document.createElement("div");
    row.className = "market-row";
    row.innerHTML = `
      <span class="market-q">${escapeHtml(m.question || "—")}</span>
      <span class="market-bar"><span style="width:${pct ?? 0}%"></span></span>
      <span class="market-pct">${pct != null ? pct + "%" : "—"}</span>`;
    list.appendChild(row);
  }

  $("panel-cta").href = polyUrl(e.slug);
  panel.classList.add("show");
  panel.setAttribute("aria-hidden", "false");
}

function hidePanel() {
  panel.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  if (selected) {
    setOrbHighlight(selected, false);
    selected = null;
  }
  controls.autoRotate = true;
}

function setOrbHighlight(orb, on) {
  if (!orb) return;
  const u = orb.userData;
  const targetEm = on ? u.baseEmissive * 1.9 : u.baseEmissive;
  const targetScale = on ? u.baseScale * 1.18 : u.baseScale;
  u.targetEmissive = targetEm;
  u.targetScale = targetScale;
}

$("panel-close").addEventListener("click", hidePanel);

// ─────────────────────────────────── Search filter ───────────────────────────────
const searchInput = $("search");
searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  for (const orb of orbsGroup.children) {
    const e = orb.userData.event;
    const matches =
      !q ||
      (e.title && e.title.toLowerCase().includes(q)) ||
      (e.description && e.description.toLowerCase().includes(q));
    orb.userData.dim = !matches;
  }
});

// ─────────────────────────────────── Pointer events ──────────────────────────────
let lastPointer = { x: 0, y: 0 };
canvas.addEventListener("pointermove", (e) => {
  const p = setPointer(e);
  lastPointer = p;
  const hit = pick();
  if (hit !== hovered) {
    if (hovered && hovered !== selected) setOrbHighlight(hovered, false);
    hovered = hit;
    if (hovered && hovered !== selected) setOrbHighlight(hovered, true);
    canvas.style.cursor = hovered ? "pointer" : "";
  }
  setTooltip(hovered, p.x, p.y);
});

canvas.addEventListener("pointerleave", () => {
  if (hovered && hovered !== selected) setOrbHighlight(hovered, false);
  hovered = null;
  setTooltip(null);
});

// Distinguish click from drag.
let downAt = null;
canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const dx = e.clientX - downAt.x;
  const dy = e.clientY - downAt.y;
  const dt = performance.now() - downAt.t;
  downAt = null;
  if (dx * dx + dy * dy > 25 || dt > 350) return; // dragged
  setPointer(e);
  const hit = pick();
  if (hit) {
    if (selected && selected !== hit) setOrbHighlight(selected, false);
    selected = hit;
    setOrbHighlight(selected, true);
    showPanel(selected);
    focusOrb(selected);
  } else if (e.target === canvas) {
    hidePanel();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hidePanel();
});

// ─────────────────────────────────── Resize handler ──────────────────────────────
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener("resize", onResize, { passive: true });

// ───────────────────────────────────── Main loop ─────────────────────────────────
const clock = new THREE.Clock();
let dimAlpha = 1; // for global filter dim transitions

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // Stars / nebula motion.
  starsFar.material.uniforms.uTime.value = t;
  starsNear.material.uniforms.uTime.value = t;
  starsFar.rotation.y += dt * 0.005;
  starsNear.rotation.y -= dt * 0.008;
  for (const s of nebula.children) s.material.rotation += s.userData.spin;

  // Orbs.
  for (const orb of orbsGroup.children) {
    const u = orb.userData;
    // Orbit around scene center on a slight tilt.
    orb.position.applyAxisAngle(u.orbitAxis, u.orbitSpeed * dt);
    // Vertical bob + spin around its own axis.
    orb.position.y = u.homeY + Math.sin(t * 0.6 + u.bobPhase) * u.bobAmt;
    orb.rotation.y += u.spinSpeed * dt;
    orb.rotation.x += u.spinSpeed * 0.6 * dt;

    // Pulse emissive intensity.
    const pulse = 1 + Math.sin(t * 1.4 + u.pulsePhase) * 0.08;
    const targetEm = (u.targetEmissive ?? u.baseEmissive) * pulse;
    orb.material.emissiveIntensity = lerp(orb.material.emissiveIntensity, targetEm, 0.12);

    const targetScale = u.targetScale ?? u.baseScale;
    const dim = u.dim ? 0.25 : 1;
    const wantScale = targetScale * (u.dim ? 0.55 : 1);
    const cur = orb.scale.x;
    const ns = lerp(cur, wantScale, 0.12);
    orb.scale.setScalar(ns);
    u.haloMat.opacity = lerp(u.haloMat.opacity, 0.95 * dim, 0.12);
    orb.material.opacity = 1;
  }

  controls.update();
  updateFlight();
  composer.render();
  requestAnimationFrame(tick);
}

// ──────────────────────────────────── Bootstrap ──────────────────────────────────
const loader = $("loader");
const loaderSub = $("loader-sub");

(async () => {
  loaderSub.textContent = "Pulling active markets from Polymarket";
  const { events, source } = await fetchEvents();
  loaderSub.textContent = `Plotting ${events.length} markets in 3D space`;

  // Compute layout extrema once.
  const maxV = events.reduce((m, e) => Math.max(m, e.volume || 0), 0);
  const maxV24 = events.reduce((m, e) => Math.max(m, e.volume24hr || 0), 0);
  const layout = { maxV, maxV24, total: events.length, index: 0, rand: mulberry32(1337) };

  let totalVolume = 0;
  let totalVolume24 = 0;
  events.forEach((event, i) => {
    layout.index = i;
    const orb = createOrb(event, layout);
    orbsGroup.add(orb);
    totalVolume += event.volume || 0;
    totalVolume24 += event.volume24hr || 0;
  });

  $("stat-count").textContent = events.length.toLocaleString();
  $("stat-volume").textContent = fmtMoney(totalVolume);
  $("stat-volume24").textContent = fmtMoney(totalVolume24);

  // Initial cinematic intro: pull camera in from far away.
  camera.position.set(0, 360, 720);
  flyTo(new THREE.Vector3(0, 90, 360), new THREE.Vector3(0, 0, 0), 2200);

  // Tag source for debugging.
  document.documentElement.dataset.source = source;

  // Hide loader after a short beat so the intro plays under it.
  setTimeout(() => loader.classList.add("hide"), 350);

  tick();
})().catch((err) => {
  console.error("[cosmos] fatal:", err);
  loaderSub.textContent = "Could not load events. Check your connection.";
});
