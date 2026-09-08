import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { OfficeActivity, OfficeSceneData } from "../../../../packages/contracts/src/office-scene.ts";
import { statePresentation, type OfficeSelection } from "./presentation.ts";
import { alongPath, shortestTurn, appearanceSeed } from "./motion.ts";

type Vec = [number, number, number];
type Actor = { id: string; group: THREE.Group; body: THREE.Group; head: THREE.Group; eyes: THREE.Group[]; arms: THREE.Group[]; legs: THREE.Group[]; paper: THREE.Mesh; cup: THREE.Group; home: THREE.Vector3; state: OfficeActivity["state"]; changed: number; seed: number; label: HTMLButtonElement; screen: THREE.Mesh; lamp: THREE.Mesh; light: THREE.PointLight; ring: THREE.Mesh; signature: string; manager: boolean; facing: number; path: Vec[]; distance: number; direction: number; poseReady: boolean };
export interface OfficeSceneController {
  update(data: OfficeSceneData, selection: OfficeSelection, stale: boolean, page: number): void;
  setMotion(enabled: boolean): void;
  setNight(night: boolean): void;
  setInside(inside: boolean): void;
  zoom(delta: number): void;
  reset(): void;
  focus(selection: OfficeSelection): void;
  dispose(): void;
}

/** A local, self-contained 3D scene. No CDN, external asset requests or simulated work events. */
export function createOfficeScene(host: HTMLElement, onSelect: (selection: OfficeSelection | "intake") => void, onFailure: () => void): OfficeSceneController {
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#c7c2b7");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .92;
  renderer.domElement.className = "vo-canvas";
  renderer.domElement.setAttribute("aria-label", "3D 辦公室；拖曳調整視角，使用縮放按鈕。所有操作也可從下方成員列與設備列進入。");
  host.append(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "vo-scene-labels"; host.append(labels);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; controls.enablePan = false; controls.enableZoom = false;
  controls.minPolarAngle = .55; controls.maxPolarAngle = 1.15;
  controls.minAzimuthAngle = -.45; controls.maxAzimuthAngle = .75;
  const homeCamera = new THREE.Vector3(8.8, 12.6, 20.3);
  const target = new THREE.Vector3(0, .6, -.1);
  let cameraTrip: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromZoom: number; toZoom: number; progress: number } | null = null;
  const setHome = () => { cameraTrip = null; controls.maxPolarAngle = 1.15; camera.position.copy(homeCamera); controls.target.copy(target); camera.zoom = 1; camera.updateProjectionMatrix(); controls.update(); };
  setHome();
  const pmrem = new THREE.PMREMGenerator(renderer); const environment = new RoomEnvironment();
  const env = pmrem.fromScene(environment, .04); scene.environment = env.texture; environment.dispose(); pmrem.dispose();
  scene.environmentIntensity = .35;
  const ambient = new THREE.HemisphereLight(0xeaf0f2, 0x756755, 1.5); scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffecd2, 3.3); sun.position.set(-7, 13, 4); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: .5, far: 40 }); sun.shadow.bias = -.0007; sun.shadow.normalBias = .025; scene.add(sun);
  const fill = new THREE.DirectionalLight(0xe8f1ff, 1.1); fill.position.set(8, 6, 4); scene.add(fill);
  const warm = new THREE.PointLight(0xffce8c, 20, 16, 2); warm.position.set(-4, 3, -2); scene.add(warm);
  const world = new THREE.Group(); scene.add(world);
  const geometries = new Map<string, THREE.BufferGeometry>();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const textures = new Set<THREE.Texture>();
  const ownedMaterials = new Set<THREE.Material>();
  const mat = (color: string, roughness = .75, metalness = 0) => {
    const key = `${color}:${roughness}:${metalness}`;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
    return materials.get(key)!;
  };
  const geo = (key: string, factory: () => THREE.BufferGeometry) => { if (!geometries.has(key)) geometries.set(key, factory()); return geometries.get(key)!; };
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, p: Vec = [0, 0, 0]) => {
    ownedMaterials.add(material); const m = new THREE.Mesh(geometry, material); m.position.set(...p); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (parent: THREE.Object3D, size: Vec, p: Vec, material: THREE.Material) => {
    const m = add(parent, geo("box", () => new THREE.BoxGeometry(1, 1, 1)), material, p); m.scale.set(...size); return m;
  };
  const rounded = (parent: THREE.Object3D, size: Vec, p: Vec, material: THREE.Material, radius = .035) => add(parent, geo(`round:${size}:${radius}`, () => new RoundedBoxGeometry(...size, 2, Math.min(radius, Math.min(...size) / 2))), material, p);
  const sphere = (parent: THREE.Object3D, scale: Vec, p: Vec, material: THREE.Material) => {
    const m = add(parent, geo("sphere", () => new THREE.SphereGeometry(1, 20, 14)), material, p); m.scale.set(...scale); return m;
  };
  const cylinder = (parent: THREE.Object3D, radius: number, height: number, p: Vec, material: THREE.Material, top = radius) => add(parent, geo(`cyl:${radius}:${height}:${top}`, () => new THREE.CylinderGeometry(top, radius, height, 20)), material, p);
  const group = (parent: THREE.Object3D, p: Vec = [0, 0, 0]) => { const g = new THREE.Group(); g.position.set(...p); parent.add(g); return g; };
  const texture = (width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d")!; draw(ctx);
    const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; textures.add(t); return t;
  };
  const oakTexture = texture(1024, 512, (ctx) => {
    const pixels = ctx.createImageData(1024, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 1024; x++) {
      const warp = y + Math.sin(x / 180) * 3 + Math.sin(x / 75 + y / 100) * 2;
      const grain = Math.sin(warp * .37) * 1.8 + Math.sin(warp * .047 + Math.sin(x / 240) * .4) * 4 + Math.sin(warp * 2.4 + x * .006) * .5;
      const pore = ((Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263)) >>> 0) % 19 - 9;
      const offset = (y * 1024 + x) * 4;
      pixels.data[offset] = 143 + grain + pore * .35; pixels.data[offset + 1] = 109 + grain * .83 + pore * .3; pixels.data[offset + 2] = 75 + grain * .61 + pore * .2; pixels.data[offset + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  }); oakTexture.wrapS = oakTexture.wrapT = THREE.RepeatWrapping;
  const oak = new THREE.MeshStandardMaterial({ map: oakTexture, bumpMap: oakTexture, bumpScale: .0015, roughness: .55, color: "#eee3d3" });
  const paleOak = new THREE.MeshStandardMaterial({ map: oakTexture, bumpMap: oakTexture, bumpScale: .0015, roughness: .67, color: "#fff0d9" });
  const dark = mat("#292e30", .55, .12), fabric = mat("#414847", .96), paper = mat("#faf5e8"), wall = mat("#e0dbce", .96), brass = mat("#92774f", .4, .7);
  const weave = texture(128, 128, (ctx) => {
    ctx.fillStyle = "#8b8b8b"; ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 4) for (let x = 0; x < 128; x += 4) { ctx.fillStyle = (x + y) % 8 ? "#aaaaaa" : "#666666"; ctx.fillRect(x, y, 3, 2); }
  }); weave.colorSpace = THREE.NoColorSpace; weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(6, 6);
  fabric.bumpMap = weave; fabric.bumpScale = .009;
  const plaster = texture(128, 128, (ctx) => { const img = ctx.createImageData(128, 128); for (let i = 0; i < img.data.length; i += 4) { const value = 120 + (Math.imul(i + 7, 1103515245) >>> 0) % 35; img.data[i] = img.data[i + 1] = img.data[i + 2] = value; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); });
  plaster.colorSpace = THREE.NoColorSpace; plaster.wrapS = plaster.wrapT = THREE.RepeatWrapping; plaster.repeat.set(12, 5); wall.bumpMap = plaster; wall.bumpScale = .013;
  const contactTexture = texture(128, 128, (ctx) => { const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 64); gradient.addColorStop(0, "rgba(25,22,17,.3)"); gradient.addColorStop(.55, "rgba(25,22,17,.14)"); gradient.addColorStop(1, "rgba(25,22,17,0)"); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128); });
  const contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false });
  const contact = (parent: THREE.Object3D, w: number, d: number, p: Vec) => { const m = add(parent, geo("contact-plane", () => new THREE.PlaneGeometry(1, 1)), contactMaterial, p); m.scale.set(w, d, 1); m.rotation.x = -Math.PI / 2; m.castShadow = false; m.receiveShadow = false; };
  const glass = new THREE.MeshPhysicalMaterial({ color: "#b7cacc", transparent: true, opacity: .13, roughness: .1, metalness: .2, depthWrite: false, side: THREE.DoubleSide });
  const interactables: THREE.Object3D[] = [];
  const mark = (object: THREE.Object3D, key: OfficeSelection | "intake") => { object.userData.selection = key; interactables.push(object); };
  const plaque = (parent: THREE.Object3D, text: string, w: number, h: number, p: Vec, bg = "#263a38", fg = "#eee8d9") => {
    const t = texture(768, 160, (ctx) => { ctx.fillStyle = bg; ctx.fillRect(0, 0, 768, 160); ctx.fillStyle = fg; ctx.font = "500 60px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, 384, 80, 720); });
    return add(parent, geo(`plane:${w}:${h}`, () => new THREE.PlaneGeometry(w, h)), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }), p);
  };
  // Architecture: open front, full-height windows and a furnished manager's corner.
  box(world, [17, .24, 13], [0, -.15, 0], mat("#71614f"));
  const floorMaterials = ["#e4d9c5", "#ddceb8", "#e8d9be", "#d5c6b0"].map((color) => { const m = oak.clone(); m.color.set(color); m.roughness = .72; return m; });
  for (let z = 0; z < 22; z++) {
    const offset = (z % 3) * 1.13;
    for (let x = -1; x < 6; x++) { const left = Math.max(-8.5, -8.5 + x * 3.4 + offset), right = Math.min(8.5, -8.5 + (x + 1) * 3.4 + offset); if (right <= left) continue;
      box(world, [right - left - .009, .05, .582], [(left + right) / 2, 0, -6.2 + z * .587], floorMaterials[(z * 7 + x + 4) % 4]);
    }
  }
  box(world, [17, 3.9, .18], [0, 1.95, -6.5], wall);
  box(world, [17, .11, .1], [0, .09, -6.37], mat("#c9bdab"));
  box(world, [.2, 3.9, 13], [-8.5, 1.95, 0], wall);
  const skyline = texture(2048, 768, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 768); sky.addColorStop(0, "#adc6d0"); sky.addColorStop(.7, "#e7e5d9"); sky.addColorStop(1, "#d0d3c9"); ctx.fillStyle = sky; ctx.fillRect(0, 0, 2048, 768);
    for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 32; i++) {
      const x = i * 72 - layer * 23, w = 24 + (i * 17) % 42, height = 65 + (i * 67 + layer * 31) % 190;
      ctx.fillStyle = ["#c2cdd0", "#aabdc3", "#90aab4"][layer]; ctx.fillRect(x, 670 - height + layer * 27, w, height + 98);
      ctx.fillStyle = "#dce0d9"; for (let row = 0; row < height / 14; row++) for (let col = 0; col < w / 10 - 1; col++) ctx.fillRect(x + 4 + col * 10, 676 - height + layer * 27 + row * 14, 3, 5);
    }
    const haze = ctx.createLinearGradient(0, 400, 0, 768); haze.addColorStop(0, "rgba(235,229,205,0)"); haze.addColorStop(1, "rgba(235,229,205,.5)"); ctx.fillStyle = haze; ctx.fillRect(0, 0, 2048, 768);
  });
  const windowMaterials: THREE.MeshBasicMaterial[] = [];
  for (let z = 0; z < 4; z++) {
    const paneTexture = skyline.clone(); paneTexture.repeat.set(.25, 1); paneTexture.offset.x = z * .25; textures.add(paneTexture);
    const paneMaterial = new THREE.MeshBasicMaterial({ map: paneTexture }); windowMaterials.push(paneMaterial);
    const pane = add(world, geo("window", () => new THREE.PlaneGeometry(2.72, 3.15)), paneMaterial, [-8.21, 2.1, -4.7 + z * 3.06]); pane.rotation.y = Math.PI / 2; pane.castShadow = false;
    box(world, [.27, .055, 2.74], [-8.2, 2.2, -4.7 + z * 3.06], dark);
    box(world, [.3, 3.3, .06], [-8.17, 2.1, -6.06 + z * 3.06], dark);
    box(world, [.38, .09, 2.8], [-8.14, .5, -4.7 + z * 3.06], paleOak);
  }
  box(world, [5.8, .035, 4.3], [-5.15, .05, -3.95], mat("#7c817a", 1));
  for (const x of [-2.25, -8.05]) {
    box(world, [.055, 2.9, .07], [x, 1.48, -1.78], brass);
  }
  box(world, [3.65, 2.6, .035], [-6.17, 1.52, -1.78], glass);
  box(world, [3.65, .04, .05], [-6.17, 2.83, -1.78], brass);
  box(world, [.04, 2.7, 3.95], [-2.25, 1.45, -4.2], glass);
  for (let i = 0; i < 12; i++) box(world, [.025, 2.8, .025], [-2.22, 1.45, -6.1 + i * .34], mat("#b7ab91", .48, .2));
  for (const x of [-7.9, -4.5, -1.1, 2.3, 5.7]) { box(world, [.3, .15, .055], [x, .27, -6.37], mat("#eae7dd")); for (const dx of [-.07, .07]) box(world, [.025, .048, .009], [x + dx, .27, -6.335], mat("#717669")); }
  plaque(world, "HERMES  /  ORCHESTRATOR", 3.35, .31, [-5, 2.97, -6.38]);
  const plant = (p: Vec, scale = 1) => {
    const g = group(world, p); g.scale.setScalar(scale);
    contact(g, 1.2, 1.2, [0, .01, 0]);
    cylinder(g, .32, .47, [0, .25, 0], mat("#c2b6a1"), .4); cylinder(g, .35, .025, [0, .49, 0], mat("#3e3326"));
    for (let i = 0; i < 9; i++) {
      const angle = i * 2.4, y = .7 + (i % 4) * .23; const stem = cylinder(g, .018, y, [Math.sin(angle) * .1, .5 + y / 2, Math.cos(angle) * .1], mat("#5d6943")); stem.rotation.z = Math.sin(angle) * .26;
      const leaf = sphere(g, [.105, .32, .022], [Math.sin(angle) * .3, .6 + y, Math.cos(angle) * .3], mat(i % 2 ? "#435a35" : "#617648")); leaf.rotation.set(.75, angle, Math.sin(angle) * .9);
    }
    return g;
  };
  plant([-7.8, .04, 5.5], 1.3); plant([7.7, .04, -5.8], 1.25); plant([-2.8, .07, -5.8], .8); plant([7.7, .04, 5.5], 1.1);
  const mug = (parent: THREE.Object3D, p: Vec, color = "#e5dfca") => {
    const g = group(parent, p); cylinder(g, .07, .12, [0, .06, 0], mat(color), .076); cylinder(g, .06, .003, [0, .122, 0], mat("#433528"));
    const handle = add(g, geo("mughandle", () => new THREE.TorusGeometry(.044, .011, 8, 14)), mat(color), [.08, .07, 0]); handle.rotation.y = 0; return g;
  };
  const chair = (parent: THREE.Object3D, p: Vec) => {
    const g = group(parent, p);
    contact(g, 1.2, 1.2, [0, .034, 0]);
    cylinder(g, .05, .42, [0, .25, 0], dark);
    for (let i = 0; i < 5; i++) { const foot = box(g, [.04, .04, .4], [Math.sin(i * 1.256) * .16, .09, Math.cos(i * 1.256) * .16], dark); foot.rotation.y = i * 1.256; sphere(g, [.05, .055, .055], [Math.sin(i * 1.256) * .34, .05, Math.cos(i * 1.256) * .34], dark); }
    rounded(g, [.55, .11, .5], [0, .52, 0], fabric); const back = rounded(g, [.54, .68, .095], [0, .88, .25], fabric); back.rotation.x = .12;
    rounded(g, [.44, .075, .035], [0, .91, .312], dark, .016);
    box(g, [.038, .65, .032], [0, .75, .34], dark);
    for (let i = 0; i < 7; i++) box(g, [.38, .008, .006], [0, .67 + i * .066, .297], mat("#5d6560"));
    for (const x of [-.34, .34]) { box(g, [.04, .22, .04], [x, .64, .08], dark); box(g, [.08, .05, .35], [x, .77, -.02], fabric); }
    return g;
  };
  const desk = (p: Vec, manager = false) => {
    const g = group(world, p); const width = manager ? 3.45 : 2.55;
    contact(g, width + .8, 2.2, [0, .033, .1]);
    rounded(g, [width, .12, 1.12], [0, .81, 0], manager ? oak : paleOak, .025);
    for (const x of [-width / 2 + .15, width / 2 - .15]) { box(g, [.06, .76, .85], [x, .39, 0], dark); box(g, [.16, .05, 1.0], [x, .07, 0], dark); }
    box(g, [.52, .66, .77], [width / 2 - .47, .37, -.02], mat("#66675f"));
    for (let i = 0; i < 3; i++) { box(g, [.48, .015, .013], [width / 2 - .47, .3 + i * .19, .374], dark); box(g, [.15, .022, .025], [width / 2 - .47, .36 + i * .17, .392], brass); }
    box(g, [.99, .009, .36], [0, .877, .24], mat("#434a46"));
    box(g, [.54, .024, .18], [-.12, .892, .28], mat("#babdb4"));
    for (let row = 0; row < 3; row++) for (let col = 0; col < 10; col++) box(g, [.035, .008, .035], [-.35 + col * .05, .908, .22 + row * .047], mat("#e2e1d6"));
    sphere(g, [.055, .025, .085], [.42, .9, .28], dark);
    box(g, [.35, .025, .24], [0, .89, -.15], dark); box(g, [.045, .25, .045], [0, 1, -.2], dark);
    rounded(g, [1.01, .51, .06], [0, 1.23, -.22], dark, .016);
    for (let i = 0; i < 12; i++) box(g, [.033, .05, .007], [-.28 + i * .05, 1.12, -.254], mat("#151b1c"));
    sphere(g, [.01, .01, .005], [0, 1.468, -.184], mat("#080e0e"));
    const wire = new THREE.CatmullRomCurve3([new THREE.Vector3(.08, 1.06, -.25), new THREE.Vector3(.12, .79, -.42), new THREE.Vector3(.36, .42, -.44), new THREE.Vector3(.55, .15, -.4)]);
    add(g, geo("monitor-wire", () => new THREE.TubeGeometry(wire, 16, .009, 5, false)), dark);
    rounded(g, [.46, .035, .1], [.2, .12, -.36], paper, .008);
    for (let i = 0; i < 3; i++) box(g, [.045, .008, .035], [.05 + i * .13, .14, -.36], dark);
    const screen = box(g, [.94, .45, .008], [0, 1.23, -.185], new THREE.MeshBasicMaterial({ color: "#1d292c" }));
    if (manager) { const side = box(g, [.68, .51, .04], [.89, 1.26, -.15], dark); side.rotation.y = -.25; }
    const lamp = cylinder(g, .11, .025, [-width / 2 + .26, .89, -.22], brass);
    box(g, [.025, .48, .025], [-width / 2 + .26, 1.13, -.22], brass);
    const shade = cylinder(g, .16, .11, [-width / 2 + .17, 1.4, -.22], mat("#d9ccb0"), .1); shade.rotation.z = -.25;
    const bulb = new THREE.MeshStandardMaterial({ color: "#fff0c1", emissive: "#ffe5a0", emissiveIntensity: 1.2 });
    cylinder(g, .115, .008, [-width / 2 + .17, 1.342, -.22], bulb);
    const light = new THREE.PointLight(0xffd5a0, 1.5, 2, 2); light.position.set(-width / 2 + .17, 1.32, -.2); g.add(light);
    const indicator = sphere(g, [.043, .026, .043], [-width / 2 + .26, .912, -.22], new THREE.MeshStandardMaterial({ color: "#929995", emissive: "#929995", emissiveIntensity: .3 }));
    mug(g, [width / 2 - .3, .876, .28]);
    box(g, [.27, .035, .37], [-.88, .9, .2], mat(manager ? "#364d50" : "#a58f77"));
    box(g, [.23, .01, .3], [-.88, .925, .18], paper);
    for (let i = 0; i < 7; i++) box(g, [.17 - (i % 3) * .025, .001, .003], [-.88, .931, .08 + i * .026], mat("#aaa591"));
    const pen = cylinder(g, .009, .21, [-.69, .896, .2], brass); pen.rotation.x = Math.PI / 2;
    cylinder(g, .065, .15, [width / 2 - .3, .95, -.28], mat("#686c5f"));
    for (let i = 0; i < 3; i++) { const pencil = cylinder(g, .007, .22, [width / 2 - .32 + i * .021, 1.05, -.28], mat(i % 2 ? "#b59b69" : "#343e43")); pencil.rotation.z = (i - 1) * .11; }
    const headphones = add(g, geo("headphones", () => new THREE.TorusGeometry(.12, .013, 8, 24, Math.PI)), dark, [.76, .893, .21]); headphones.rotation.x = Math.PI / 2;
    for (const x of [.64, .88]) rounded(g, [.065, .04, .08], [x, .9, .21], fabric, .015);
    chair(g, [0, 0, .9]);
    return { group: g, screen, indicator, lamp, light };
  };
  // Physical whiteboard: the texture is redrawn from exact, office-wide counters.
  const boardGroup = group(world, [2.25, 2.32, -6.32]);
  box(boardGroup, [6.5, 2.45, .1], [0, 0, 0], oak);
  const boardTexture = texture(1536, 576, () => {});
  const boardMesh = add(boardGroup, geo("board", () => new THREE.PlaneGeometry(6.32, 2.29)), new THREE.MeshBasicMaterial({ map: boardTexture }), [0, 0, .06]); mark(boardGroup, "board");
  box(boardGroup, [6.5, .055, .17], [0, -1.25, .03], brass);
  for (let i = 0; i < 3; i++) { const marker = cylinder(boardGroup, .014, .19, [-1.1 + i * .28, -1.215, .065], mat(["#48614d", "#3d586a", "#966554"][i])); marker.rotation.z = Math.PI / 2; }
  rounded(boardGroup, [.21, .038, .085], [1.9, -1.2, .065], fabric, .008);
  // Clock, hands follow real local time.
  const clock = group(world, [6.7, 2.85, -6.25]);
  const clockFace = cylinder(clock, .47, .07, [0, 0, 0], brass); clockFace.rotation.x = Math.PI / 2;
  const dial = cylinder(clock, .435, .08, [0, 0, .018], paper); dial.rotation.x = Math.PI / 2;
  for (let i = 0; i < 12; i++) { const tick = box(clock, [.024, .055, .01], [Math.sin(i * Math.PI / 6) * .375, Math.cos(i * Math.PI / 6) * .375, .065], dark); tick.rotation.z = -i * Math.PI / 6; }
  const hour = group(clock, [0, 0, .085]); box(hour, [.027, .23, .02], [0, .095, 0], dark);
  const minute = group(clock, [0, 0, .1]); box(minute, [.018, .34, .01], [0, .145, 0], dark);
  // Deliverables cabinet, printed binders, printer and review inbox.
  const cabinet = group(world, [6.05, 0, 3.7]); mark(cabinet, "results");
  box(cabinet, [3.4, 1.05, 1.1], [0, .56, 0], oak);
  for (let i = 0; i < 10; i++) { const book = box(cabinet, [.13, .68, .65], [-1.48 + i * .18, .51, .09], mat(["#3f5257", "#d7c9ad", "#7d816e"][i % 3])); book.rotation.z = i % 3 === 0 ? .035 : 0; box(cabinet, [.08, .13, .01], [-1.48 + i * .18, .62, .422], paper); }
  box(cabinet, [1.05, .47, .7], [.7, 1.33, -.04], mat("#deded4")); box(cabinet, [.8, .1, .34], [.7, 1.56, -.13], dark); box(cabinet, [.7, .07, .2], [.7, 1.18, .36], dark);
  const output = box(cabinet, [.5, .01, .28], [.7, 1.19, .39], paper);
  plaque(cabinet, "成果櫃", .75, .21, [-.95, 1.24, .45]);
  const reviewTray = group(world, [5.9, 1.12, 4.3]); mark(reviewTray, "attention");
  box(reviewTray, [.6, .07, .48], [0, 0, 0], mat("#a5844b"));
  for (const x of [-.31, .31]) box(reviewTray, [.035, .15, .48], [x, .05, 0], brass);
  const reviewPapers = box(reviewTray, [.48, .08, .36], [0, .05, -.02], paper);
  // Reception / actual task intake.
  const reception = group(world, [-4.5, 0, 4.9]); mark(reception, "intake");
  box(reception, [3.7, 1.04, 1.05], [0, .55, 0], oak); box(reception, [3.9, .1, 1.16], [0, 1.1, 0], paleOak);
  plaque(reception, "PERSONAL AI  /  接待台", 2.6, .3, [0, .68, .537]);
  box(reception, [.72, .21, .53], [-.95, 1.23, 0], oak); box(reception, [.62, .025, .43], [-.95, 1.35, 0], paper);
  plaque(reception, "交辦箱", .53, .17, [-.95, 1.23, .272]);
  box(reception, [.43, .08, .27], [.95, 1.2, .03], dark); box(reception, [.46, .045, .08], [.95, 1.28, -.05], dark);
  for (let i = 0; i < 3; i++) box(reception, [.22, .013, .3], [.2 + i * .035, 1.165 + i * .014, .05], paper);
  // Coffee corner and a glass meeting table.
  const coffee = group(world, [6.4, 0, -4.65]);
  box(coffee, [2.8, .95, .85], [0, .5, 0], oak); box(coffee, [2.88, .07, .93], [0, 1.01, 0], mat("#c6c1b3"));
  box(coffee, [.52, .56, .43], [.3, 1.3, 0], dark); box(coffee, [.32, .23, .02], [.3, 1.3, .23], mat("#949f9d", .2, .8));
  mug(coffee, [.3, 1.075, .3]); mug(coffee, [-.6, 1.055, .08]); mug(coffee, [-.85, 1.055, .08]); cylinder(coffee, .12, .27, [1, 1.2, 0], brass);
  const meeting = group(world, [5.75, 0, -1.25]);
  cylinder(meeting, 1.03, .1, [0, .83, 0], paleOak); cylinder(meeting, .09, .77, [0, .4, 0], dark); cylinder(meeting, .45, .05, [0, .07, 0], dark);
  for (let i = 0; i < 3; i++) { const seat = chair(meeting, [Math.sin(i * 2.1) * 1.34, 0, Math.cos(i * 2.1) * 1.34]); seat.rotation.y = i * 2.1; }
  box(meeting, [.52, .025, .36], [0, .905, 0], dark); const laptop = box(meeting, [.52, .34, .025], [0, 1.065, -.17], mat("#6c807e")); laptop.rotation.x = -.12;
  mug(meeting, [.55, .89, .25]);
  // Visible equipment tags remain keyboard accessible and expose the same inspector.
  const equipmentLabels: Array<{ key: OfficeSelection | "intake"; anchor: THREE.Vector3; element: HTMLButtonElement }> = [];
  for (const [key, text, p] of [["board", "工作看板", [2.2, 3.82, -6.1]], ["results", "成果櫃", [6.1, 1.9, 3.7]], ["intake", "＋ 交辦工作", [-4.5, 1.63, 4.9]]] as const) {
    const element = document.createElement("button"); element.type = "button"; element.className = "vo-world-tag vo-equipment-tag"; element.textContent = text; element.onclick = () => onSelect(key); labels.append(element);
    equipmentLabels.push({ key, anchor: new THREE.Vector3(...p), element });
  }
  const actors = new Map<string, Actor>();
  let elapsed = 0, motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches, stale = false, disposed = false, dirty = true;
  let boardSignature = "", rosterSignature = "", selection: OfficeSelection = "overview";
  // An articulated adult-proportion body: shoulder/elbow and hip/knee pivots support seated, typing, review and walking poses.
  const createActor = (id: string, index: number, home: Vec, manager: boolean, station: ReturnType<typeof desk>): Actor => {
    index = manager ? 0 : appearanceSeed(id);
    const root = group(world, home); const body = group(root, [0, .89, 0]);
    const skin = mat(["#c39674", "#d3af92", "#a77a5a", "#d2a385"][index % 4], .88);
    const shirt = mat(manager ? "#263d4b" : ["#627569", "#a89b87", "#425967", "#8d7468", "#6b6e7b", "#647a78"][index % 6], .95);
    const trousers = mat(manager ? "#303a40" : "#3c4547", .93); const hair = mat(index % 3 === 1 ? "#625247" : "#302d28", 1);
    shirt.bumpMap = weave; shirt.bumpScale = .004; trousers.bumpMap = weave; trousers.bumpScale = .004;
    sphere(body, [.215, .32, .125], [0, .29, 0], shirt); box(body, [.33, .1, .22], [0, .02, 0], trousers);
    box(body, [.022, .37, .013], [0, .31, -.123], manager ? mat("#bdc2b8") : shirt);
    for (const side of [-1, 1]) { const collar = box(body, [.075, .115, .016], [side * .052, .57, -.102], mat(manager ? "#e5e2d6" : "#c2bcaa")); collar.rotation.z = side * .37; }
    for (let i = 0; i < 4; i++) sphere(body, [.008, .008, .004], [0, .17 + i * .085, -.133], mat("#c0b9a5"));
    rounded(body, [.072, .085, .012], [.108, .43, -.114], shirt, .005);
    box(body, [.058, .035, .014], [.108, .41, -.122], paper);
    if (manager) { const tie = box(body, [.041, .28, .02], [0, .36, -.139], mat("#79644f")); tie.rotation.z = -.025; }
    cylinder(body, .058, .11, [0, .64, 0], skin);
    const head = group(body, [0, .77, -.006]); sphere(head, [.108, .142, .108], [0, 0, 0], skin);
    sphere(head, [.115, .075, .116], [0, .085, .01], hair);
    if (index % 3 === 1) sphere(head, [.1, .16, .07], [0, -.025, .084], hair);
    for (let i = 0; i < 7; i++) { const lock = sphere(head, [.012, .044, .044], [-.076 + i * .025, .098 + Math.sin(i) * .004, -.058], hair); lock.rotation.z = -.35; }
    if (index % 3 === 2) sphere(head, [.063, .065, .062], [0, .025, .136], hair);
    sphere(head, [.023, .032, .024], [0, -.007, -.111], skin);
    sphere(head, [.034, .007, .006], [0, -.058, -.094], mat("#986b59"));
    const eyes: THREE.Group[] = [];
    for (const x of [-.043, .043]) {
      const eye = group(head, [x, .027, -.1]); eyes.push(eye); sphere(eye, [.022, .009, .009], [0, 0, 0], mat("#e6ddd0")); sphere(eye, [.007, .007, .004], [0, 0, -.008], mat("#3e3931"));
      const brow = sphere(head, [.026, .004, .004], [x, .05, -.099], hair); brow.rotation.z = Math.sign(x) * .08;
      sphere(head, [.018, .029, .022], [Math.sign(x) * .106, 0, 0], skin);
    }
    if (manager || index % 3 === 2) {
      for (const x of [-.044, .044]) { const lens = add(head, geo("glasses", () => new THREE.TorusGeometry(.03, .004, 6, 12)), dark, [x, .027, -.111]); lens.scale.y = .72; box(head, [.004, .004, .1], [Math.sign(x) * .074, .03, -.06], dark); }
      box(head, [.029, .005, .005], [0, .028, -.114], dark);
    }
    const arms: THREE.Group[] = [], legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const shoulder = group(body, [side * .215, .48, 0]); sphere(shoulder, [.073, .17, .075], [0, -.12, 0], shirt);
      const elbow = group(shoulder, [0, -.27, 0]); sphere(elbow, [.052, .13, .052], [0, -.11, 0], skin); sphere(elbow, [.035, .043, .019], [0, -.24, -.004], skin);
      for (let finger = 0; finger < 4; finger++) sphere(elbow, [.007, .032 - Math.abs(finger - 1.5) * .005, .009], [-.024 + finger * .016, -.288, -.01], skin);
      const thumb = sphere(elbow, [.012, .025, .011], [side * .038, -.247, -.004], skin); thumb.rotation.z = side * .55;
      if (side < 0) { cylinder(elbow, .05, .025, [0, -.185, 0], dark); rounded(elbow, [.048, .04, .012], [0, -.185, -.05], brass, .005); }
      arms.push(shoulder, elbow);
      const hip = group(body, [side * .105, -.02, 0]); sphere(hip, [.088, .225, .089], [0, -.17, 0], trousers);
      const knee = group(hip, [0, -.37, 0]); sphere(knee, [.065, .235, .069], [0, -.205, 0], trousers); sphere(knee, [.071, .05, .135], [0, -.44, -.05], dark);
      rounded(knee, [.135, .016, .24], [0, -.477, -.05], mat(manager ? "#252a29" : "#aaa998"), .007);
      for (let i = 0; i < 3; i++) box(knee, [.065, .004, .008], [0, -.397, -.07 - i * .022], mat("#8b8e82")); legs.push(hip, knee);
    }
    const folder = box(body, [.3, .02, .4], [0, .21, -.44], mat("#738c86"));
    box(folder, [.91, .18, .9], [0, .64, 0], paper);
    for (let i = 0; i < 7; i++) box(folder, [.65 - (i % 3) * .08, .025, .012], [0, .75, -.31 + i * .075], mat("#828c80"));
    const cup = mug(arms[3], [.035, -.267, -.035]); cup.visible = false;
    const ring = add(world, geo("ring", () => new THREE.RingGeometry(.62, .642, 56)), new THREE.MeshBasicMaterial({ color: "#88b5ad", transparent: true, opacity: .85, side: THREE.DoubleSide }), [home[0], .064, home[2]]); ring.rotation.x = -Math.PI / 2; ring.visible = false;
    const label = document.createElement("button"); label.type = "button"; label.className = "vo-world-tag vo-person-tag"; label.onclick = () => onSelect(manager && id === "__hermes" ? "orchestrator" : `member:${id}`); labels.append(label);
    mark(root, manager && id === "__hermes" ? "orchestrator" : `member:${id}`); mark(station.group, manager && id === "__hermes" ? "orchestrator" : `member:${id}`);
    const aisle = station.group.rotation.y ? home[2] - .5 : home[2] + .8;
    const path: Vec[] = manager ? [home, [-3.1, 0, -5.15], [-3.1, 0, -1.45], [3.8, 0, -1.45], [4.2, 0, 3.9]] : [home, [home[0], 0, aisle], [3.8, 0, aisle], [4.2, 0, 3.9]];
    const actor: Actor = { id, group: root, body, head, eyes, arms, legs, paper: folder, cup, home: new THREE.Vector3(...home), state: "UNKNOWN", changed: 0, seed: (index % 97) * .73, label, screen: station.screen, lamp: station.indicator, light: station.light, ring, signature: "", manager, facing: station.group.rotation.y, path, distance: 0, direction: 0, poseReady: false };
    actors.set(id, actor); return actor;
  };
  const managerDesk = desk([-5.15, .05, -4.25], true);
  managerDesk.group.rotation.y = Math.PI;
  const stations = [[-4.95, 0, .0], [-1.55, 0, -.2], [1.75, 0, -.2], [-1.55, 0, 2.8], [1.75, 0, 2.8]].map((p) => desk(p as Vec));
  stations.slice(0, 3).forEach((s) => { s.group.rotation.y = Math.PI; });
  function retireActors() {
    for (const a of actors.values()) { world.remove(a.group, a.ring); (a.ring.material as THREE.Material).dispose(); ownedMaterials.delete(a.ring.material as THREE.Material); a.label.remove(); }
    actors.clear();
    for (let i = interactables.length - 1; i >= 0; i--) if (interactables[i].userData.selection === "orchestrator" || String(interactables[i].userData.selection).startsWith("member:")) interactables.splice(i, 1);
  }
  function drawScreen(a: Actor) {
    const material = a.screen.material as THREE.MeshBasicMaterial;
    if (material.map) { material.map.dispose(); textures.delete(material.map); }
    material.map = texture(512, 288, (ctx) => {
      ctx.fillStyle = ["OFFLINE", "UNKNOWN"].includes(a.state) ? "#182024" : "#253637"; ctx.fillRect(0, 0, 512, 288);
      if (a.state === "OFFLINE") return;
      const status = statePresentation[a.state]; ctx.fillStyle = status.color; ctx.font = "500 28px system-ui"; ctx.fillText(status.label, 24, 44);
      if (["WORKING", "PLANNING", "REVIEWING"].includes(a.state)) {
        if (a.manager) { for (let i = 0; i < 3; i++) { ctx.fillStyle = "#5e7974"; ctx.fillRect(28 + i * 158, 94 + (i % 2) * 55, 115, 54); ctx.fillStyle = "#9eb9ac"; ctx.fillRect(143 + i * 158, 117 + (i % 2) * 28, 43, 3); } }
        else for (let i = 0; i < 8; i++) { ctx.fillStyle = ["#a7bab1", "#92ad9a", "#c4b291"][i % 3]; ctx.fillRect(25 + (i % 3) * 12, 78 + i * 22, 150 + (i * 47) % 215, 5); }
      } else { ctx.fillStyle = "#a5b4ab"; ctx.font = "22px system-ui"; ctx.fillText(status.verb, 24, 150, 462); }
    }); material.color.set("#ffffff"); material.needsUpdate = true;
  }
  const updateActor = (a: Actor, name: string, role: string, work: OfficeActivity) => {
    const state = stale ? "UNKNOWN" : work.state;
    if (a.state !== state) { a.state = state; a.changed = elapsed; drawScreen(a); }
    a.direction = state === "DELIVERING" ? 1 : a.distance > 0 && !["UNKNOWN", "ERROR", "OFFLINE"].includes(state) && (state !== "WAITING" || !work.missionId) ? -1 : 0;
    a.group.visible = state !== "OFFLINE";
    const status = statePresentation[state];
    const sig = JSON.stringify([name, role, state, work.workerName, work.model, work.runtime]);
    if (a.signature !== sig) {
      a.signature = sig; a.label.replaceChildren();
      const dot = document.createElement("i"); dot.style.background = status.color;
      const title = document.createElement("strong"); title.textContent = name;
      const stateText = document.createElement("span"); stateText.textContent = status.label; stateText.style.color = status.color;
      const sub = document.createElement("small"); sub.textContent = [work.workerName ?? role, work.model ?? work.runtime].filter(Boolean).join(" · ");
      a.label.append(dot, title, stateText, sub); a.label.setAttribute("aria-label", `${name}，${status.label}，${sub.textContent}`);
    }
    const selected = selection === `member:${a.id}` || selection === "orchestrator" && a.manager;
    a.label.setAttribute("aria-pressed", String(selected)); a.ring.visible = selected;
    const indicator = a.lamp.material as THREE.MeshStandardMaterial; indicator.color.set(status.color); indicator.emissive.set(status.color);
    a.light.visible = !["OFFLINE", "UNKNOWN"].includes(state);
  };
  function update(data: OfficeSceneData, selected: OfficeSelection, isStale: boolean, page: number) {
    selection = selected; stale = isStale;
    const manager = data.members.find((m) => m.binding.kind === "HERMES_PROFILE" && /^(manager|orchestrator|hermes)$/i.test(m.seatKey));
    const employees = data.members.filter((m) => m !== manager).slice(page * 5, page * 5 + 5);
    const roster = JSON.stringify([manager?.id, employees.map((m) => m.id)]);
    if (rosterSignature !== roster) {
      retireActors(); rosterSignature = roster;
      createActor(manager?.id ?? "__hermes", 0, [-5.15, .05, -5.15], true, managerDesk);
      stations.forEach((s, i) => { s.group.visible = true; if (employees[i]) createActor(employees[i].id, i + 1, [s.group.position.x, 0, s.group.position.z + Math.cos(s.group.rotation.y) * .9], false, s); else { const m = s.screen.material as THREE.MeshBasicMaterial; m.color.set("#192124"); if (m.map) { m.map.dispose(); textures.delete(m.map); m.map = null; m.needsUpdate = true; } const light = s.indicator.material as THREE.MeshStandardMaterial; light.color.set("#777d77"); light.emissive.set("#777d77"); } });
    }
    for (const a of actors.values()) {
      const member = data.members.find((m) => m.id === a.id);
      updateActor(a, member?.displayName ?? "Hermes", member?.role.name ?? "Orchestrator", member?.activity ?? data.orchestrator);
    }
    const signature = JSON.stringify([data.board, data.missions.slice(0, 12).map((m) => [m.title, m.bucket]), isStale]);
    if (signature !== boardSignature) {
      boardSignature = signature;
      const canvas = boardTexture.image as HTMLCanvasElement; const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#eee9dd"; ctx.fillRect(0, 0, 1536, 576); ctx.fillStyle = "#35443f"; ctx.font = "600 40px system-ui"; ctx.fillText("團隊工作看板", 42, 64);
      ctx.font = "22px system-ui"; ctx.textAlign = "right"; ctx.fillText(isStale ? "資料待同步" : "依目前委託統計", 1490, 62); ctx.textAlign = "left";
      const columns = [["待辦", "todo", "#b5a489"], ["進行中", "active", "#708eab"], ["待處理", "attention", "#c39761"], ["已完成", "completed", "#769a82"]] as const;
      columns.forEach(([label, key, color], i) => {
        const x = 38 + i * 377; ctx.fillStyle = "#d7d0c1"; ctx.fillRect(x, 105, 346, 2); ctx.font = "500 31px system-ui"; ctx.fillStyle = "#35443f"; ctx.fillText(`${label}   ${data.board[key]}`, x + 8, 155);
        const cards = data.missions.filter((m) => m.bucket === key).slice(0, 3);
        if (!cards.length) { ctx.fillStyle = "#a7a397"; ctx.font = "24px system-ui"; ctx.fillText("目前沒有工作", x + 12, 238); }
        cards.forEach((m, n) => { ctx.fillStyle = "#cfc7b7"; ctx.fillRect(x + 6, 192 + n * 112, 330, 88); ctx.fillStyle = "#fffdf5"; ctx.fillRect(x + 4, 189 + n * 112, 330, 88); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 20, 205 + n * 112, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#4f574e"; ctx.font = "24px system-ui"; ctx.fillText(m.title.slice(0, 15), x + 17, 242 + n * 112, 300); });
      }); boardTexture.needsUpdate = true;
      output.visible = data.board.results > 0; reviewPapers.visible = data.board.attention > 0;
      equipmentLabels.find((l) => l.key === "results")!.element.textContent = `成果櫃 · ${data.board.results}`;
      equipmentLabels.find((l) => l.key === "board")!.element.textContent = `工作看板 · 待辦 ${data.board.todo}`;
    }
    dirty = true;
  }
  const point = new THREE.Vector3(); const projected = new THREE.Vector3();
  const positionLabel = (element: HTMLElement, p: THREE.Vector3, width: number, height: number) => {
    projected.copy(p).project(camera); const visible = Math.abs(projected.x) < .99 && Math.abs(projected.y) < .96 && projected.z < 1;
    element.hidden = !visible; if (visible) element.style.transform = `translate(-50%, -100%) translate(${(projected.x * .5 + .5) * width}px, ${(-projected.y * .5 + .5) * height}px)`;
  };
  function pose(a: Actor, t: number, dt: number) {
    const active = ["WORKING", "PLANNING", "REVIEWING"].includes(a.state), delivery = a.state === "DELIVERING";
    const idle = a.state === "IDLE", phase = t + a.seed;
    const blend = !a.poseReady || !motion ? 1 : 1 - Math.exp(-dt * 9);
    if (a.direction && dt > 0 && t - a.changed > .4) {
      const length = alongPath(a.path, 0).length;
      a.distance = THREE.MathUtils.clamp(a.distance + a.direction * dt * 1.15, 0, length);
      if (a.distance === 0 || a.distance === length) a.direction = 0;
    }
    const route = alongPath(a.path, a.distance);
    a.group.position.set(...route.position);
    const walking = a.direction !== 0, standing = walking || a.distance > .01 || delivery;
    const carrying = delivery || a.distance > 0 && a.direction >= 0;
    const facing = walking ? route.heading + (a.direction < 0 ? Math.PI : 0) : a.distance > 0 ? a.group.rotation.y : a.facing;
    a.group.rotation.y = shortestTurn(a.group.rotation.y, facing, blend);
    a.body.position.y = THREE.MathUtils.lerp(a.body.position.y, standing ? .89 + (walking ? Math.abs(Math.sin(phase * 6)) * .013 : 0) : .54, blend);
    a.body.rotation.x = THREE.MathUtils.lerp(a.body.rotation.x, standing ? -.015 : active ? -.06 : idle ? .035 : 0, blend);
    a.body.scale.y = 1 + (active || idle ? Math.sin(phase * 1.2) * .003 : 0);
    a.head.rotation.y = THREE.MathUtils.lerp(a.head.rotation.y, walking ? 0 : active ? Math.sin(phase * .7) * .08 : idle ? Math.sin(phase * .24) * .15 : 0, blend);
    a.head.rotation.x = THREE.MathUtils.lerp(a.head.rotation.x, a.state === "REVIEWING" ? -.13 + Math.sin(phase) * .03 : Math.sin(phase * .8) * .012, blend);
    const blink = phase % 5.2; for (const eye of a.eyes) eye.scale.y = blink < .16 && (active || idle) ? 1 - Math.sin(blink / .16 * Math.PI) * .94 : 1;
    const sip = idle ? Math.max(0, Math.sin(phase * .42)) ** 3 : 0;
    const flip = a.state === "REVIEWING" ? Math.max(0, Math.sin(phase * .9)) ** 8 : 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1, arm = a.arms[i * 2], elbow = a.arms[i * 2 + 1], hip = a.legs[i * 2], knee = a.legs[i * 2 + 1];
      const upper = carrying ? .55 : walking ? Math.sin(phase * 6 + i * Math.PI) * .3 : active ? .4 + Math.sin(phase * 6 + i * 2) * .035 + (i ? flip * .15 : 0) : idle && i === 1 ? .25 + sip * .65 : .13;
      const lower = carrying ? 1.2 : walking ? .2 : active ? 1.03 + (i ? flip * .2 : 0) : idle && i === 1 ? .8 + sip * .95 : .22;
      arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, upper, blend); arm.rotation.z = side * .06;
      elbow.rotation.x = THREE.MathUtils.lerp(elbow.rotation.x, lower, blend);
      hip.rotation.x = THREE.MathUtils.lerp(hip.rotation.x, standing ? walking ? Math.sin(phase * 6 + i * Math.PI) * .38 : 0 : Math.PI / 2, blend);
      knee.rotation.x = THREE.MathUtils.lerp(knee.rotation.x, standing ? walking ? -.16 - Math.max(0, Math.sin(phase * 6 + i * Math.PI)) * .33 : 0 : -Math.PI / 2, blend);
    }
    a.paper.visible = carrying || a.state === "REVIEWING" && !walking;
    a.paper.rotation.z = flip * .09; a.paper.rotation.x = flip * .07;
    a.cup.visible = idle && !standing;
    a.cup.rotation.x = -(a.arms[2].rotation.x + a.arms[3].rotation.x + a.body.rotation.x);
    a.ring.position.set(a.group.position.x, .064, a.group.position.z);
    a.poseReady = true;
  }
  let lastFrame = 0, lastTime = performance.now(), raf = 0;
  const frame = (time: number) => {
    if (disposed) return; raf = requestAnimationFrame(frame);
    if (document.hidden) { lastTime = time; return; }
    if (time - lastFrame < 33) return;
    const dt = Math.min((time - lastTime) / 1000, .1); lastTime = time;
    const animate = motion && !stale && [...actors.values()].some((a) => a.direction !== 0 || ["IDLE", "WORKING", "PLANNING", "REVIEWING", "DELIVERING"].includes(a.state));
    if (!dirty && !animate && !cameraTrip) return;
    lastFrame = time; if (animate) elapsed += dt;
    if (cameraTrip) {
      cameraTrip.progress = Math.min(1, cameraTrip.progress + dt / .7);
      const k = cameraTrip.progress * cameraTrip.progress * (3 - 2 * cameraTrip.progress);
      camera.position.lerpVectors(cameraTrip.from, cameraTrip.to, k); controls.target.lerpVectors(cameraTrip.fromTarget, cameraTrip.toTarget, k); camera.zoom = THREE.MathUtils.lerp(cameraTrip.fromZoom, cameraTrip.toZoom, k); camera.updateProjectionMatrix(); controls.update();
      if (cameraTrip.progress === 1) cameraTrip = null;
    }
    const width = host.clientWidth, height = host.clientHeight;
    for (const a of actors.values()) { pose(a, elapsed, animate ? dt : 0); point.copy(a.group.visible ? a.group.position : a.home); point.y += a.manager ? 2.03 : 1.9; positionLabel(a.label, point, width, height); }
    for (const l of equipmentLabels) positionLabel(l.element, l.anchor, width, height);
    const date = new Date(); hour.rotation.z = -(date.getHours() % 12 + date.getMinutes() / 60) * Math.PI / 6; minute.rotation.z = -date.getMinutes() * Math.PI / 30;
    renderer.render(scene, camera); dirty = false;
  };
  const resize = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(18)) * Math.max(1, 1.5 / camera.aspect))); camera.updateProjectionMatrix(); dirty = true; }); resize.observe(host);
  const changed = () => { dirty = true; }; controls.addEventListener("change", changed);
  const pointer = new THREE.Vector2(), raycaster = new THREE.Raycaster(); let down: [number, number] = [0, 0];
  const pointerDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; cameraTrip = null; };
  const pointerUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(interactables, true)) { let o: THREE.Object3D | null = hit.object; while (o && !o.userData.selection) o = o.parent; if (o?.userData.selection && o.visible && hit.object.visible && o.parent) { onSelect(o.userData.selection); return; } }
  };
  const lost = (e: Event) => { e.preventDefault(); onFailure(); };
  renderer.domElement.addEventListener("pointerdown", pointerDown); renderer.domElement.addEventListener("pointerup", pointerUp); renderer.domElement.addEventListener("webglcontextlost", lost);
  const visibility = () => { lastTime = performance.now(); dirty = true; }; document.addEventListener("visibilitychange", visibility);
  const clockTimer = setInterval(() => { dirty = true; }, 60_000);
  raf = requestAnimationFrame(frame);
  const moveCamera = (to: THREE.Vector3, toTarget: THREE.Vector3, zoom = 1) => {
    if (!motion) { cameraTrip = null; camera.position.copy(to); controls.target.copy(toTarget); camera.zoom = zoom; camera.updateProjectionMatrix(); controls.update(); }
    else cameraTrip = { from: camera.position.clone(), to, fromTarget: controls.target.clone(), toTarget, fromZoom: camera.zoom, toZoom: zoom, progress: 0 };
    dirty = true;
  };
  return {
    update,
    setMotion(value) { motion = value; dirty = true; },
    setNight(night) { ambient.intensity = night ? .65 : 1.5; sun.intensity = night ? .4 : 3.3; fill.intensity = night ? .4 : 1.1; warm.intensity = night ? 45 : 20; for (const s of [managerDesk, ...stations]) s.light.intensity = night ? 4 : 1.5; for (const m of windowMaterials) m.color.set(night ? "#334864" : "#ffffff"); scene.background = new THREE.Color(night ? "#333d3e" : "#c7c2b7"); renderer.toneMappingExposure = night ? .95 : .92; dirty = true; },
    setInside(inside) { controls.maxPolarAngle = inside ? 1.4 : 1.15; moveCamera(inside ? new THREE.Vector3(6.2, 5.9, 14.8) : homeCamera.clone(), inside ? new THREE.Vector3(0, 1.1, -1.1) : target.clone()); },
    zoom(delta) { cameraTrip = null; camera.zoom = THREE.MathUtils.clamp(camera.zoom + delta, .7, 2.4); camera.updateProjectionMatrix(); dirty = true; },
    reset() { setHome(); dirty = true; },
    focus(key) { const a = key === "orchestrator" ? [...actors.values()].find((x) => x.manager) : actors.get(key.replace("member:", "")); const p = a?.group.position ?? (key === "attention" ? new THREE.Vector3(5.9, 1.1, 4.3) : equipmentLabels.find((l) => l.key === key)?.anchor); if (p) { const offset = camera.position.clone().sub(controls.target); const toTarget = p.clone().setY(key === "board" ? 2.2 : 1); moveCamera(toTarget.clone().add(offset), toTarget, 1.65); } },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); clearInterval(clockTimer); resize.disconnect(); controls.dispose(); document.removeEventListener("visibilitychange", visibility);
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp); renderer.domElement.removeEventListener("webglcontextlost", lost);
      const allMaterials = new Set<THREE.Material>([...ownedMaterials, ...materials.values(), oak, paleOak, glass]);
      scene.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => allMaterials.add(m)); } });
      geometries.forEach((g) => g.dispose()); textures.forEach((t) => t.dispose()); allMaterials.forEach((m) => m.dispose()); env.dispose(); renderer.dispose(); renderer.domElement.remove(); labels.remove();
    },
  };
}
