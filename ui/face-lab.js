import * as THREE from "/vendor/three.module.min.js";
import { DecalGeometry } from "/vendor/DecalGeometry.js";
import { createOrbEffects } from "/orb-effects.js";

const FACE_COLOR = "#f5f0e8";
const DEFAULT_FACE_STYLE = {
  color: FACE_COLOR,
  outlineColor: FACE_COLOR,
  lineWidth: 10,
  shadowColor: "rgba(0, 0, 0, 0.32)",
  shadowBlur: 10
};
const ORB_COLOR = 0x50504e;
const EXPRESSIONS = [
  { key: "scrunch", label: ">_<" },
  { key: "curious", label: "o_o" },
  { key: "flat", label: "-_-" },
  { key: "smile", label: ">)<" }
];

function expressionAt(elapsed) {
  return EXPRESSIONS[Math.floor(elapsed / 2.6) % EXPRESSIONS.length];
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function makeCanvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function drawSmile(ctx, width, height, fontSize, color) {
  const centerX = width / 2;
  const eyeY = height / 2 - height * 0.03;
  ctx.font = `900 ${fontSize}px "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.fillText(">", centerX - width * 0.2, eyeY);
  ctx.fillText("<", centerX + width * 0.2, eyeY);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(8, fontSize * 0.11);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(centerX - width * 0.16, height / 2 + height * 0.15);
  ctx.quadraticCurveTo(centerX, height / 2 + height * 0.29, centerX + width * 0.16, height / 2 + height * 0.15);
  ctx.stroke();
  ctx.restore();
}

function drawExpression(ctx, expression, faceStyle = DEFAULT_FACE_STYLE, fontSize = 234) {
  const style = { ...DEFAULT_FACE_STYLE, ...faceStyle };
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = style.lineWidth;
  ctx.strokeStyle = style.outlineColor;
  ctx.shadowColor = style.shadowColor;
  ctx.shadowBlur = style.shadowBlur;
  ctx.shadowOffsetY = 2;
  if (expression.key === "smile") {
    drawSmile(ctx, width, height, fontSize, style.color);
    return;
  }
  ctx.font = `900 ${fontSize}px "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.strokeText(expression.label, width / 2, height / 2 + 2);
  ctx.fillText(expression.label, width / 2, height / 2 + 2);
}

function createFaceDecal(orb, texture) {
  orb.updateMatrixWorld(true);
  const geometry = new DecalGeometry(orb, new THREE.Vector3(0, 0.06, 1), new THREE.Euler(0, 0, 0), new THREE.Vector3(1.02, 0.64, 0.52));
  const face = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4
    })
  );
  face.renderOrder = 50;
  return face;
}

function createEffectControls(effectManager, onActiveEffect) {
  const controls = document.getElementById("effect-controls");
  const description = document.getElementById("effect-description");
  if (!controls || !description) return;

  const buttons = effectManager.effects.map((effect) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "effect-button";
    button.dataset.effectId = effect.id;
    button.innerHTML = `<span>${effect.label}</span><small>${effect.category}</small>`;
    button.addEventListener("click", () => {
      const active = effectManager.setActive(effect.id);
      buttons.forEach((candidate) => {
        candidate.classList.toggle("is-active", candidate.dataset.effectId === active.id);
      });
      description.textContent = active.description;
      onActiveEffect(active);
    });
    controls.appendChild(button);
    return button;
  });

  buttons[0]?.click();
}

async function createScene() {
  const host = document.getElementById("official-decal-orb");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 0.05, 3.25);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const root = new THREE.Group();
  root.scale.setScalar(0.94);
  scene.add(root);
  const frameCallbacks = [];
  const pointer = { x: 0, y: 0 };
  const look = { x: 0, y: 0 };
  let activeFaceStyle = DEFAULT_FACE_STYLE;

  const orbMaterial = new THREE.MeshStandardMaterial({
    color: ORB_COLOR,
    roughness: 0.7,
    metalness: 0.18,
    emissive: new THREE.Color(0x111111),
    emissiveIntensity: 0.08
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), orbMaterial);
  root.add(orb);

  const faceCanvas = makeCanvas(512, 320);
  const faceCtx = faceCanvas.getContext("2d");
  drawExpression(faceCtx, EXPRESSIONS[0], activeFaceStyle);
  const faceTexture = makeCanvasTexture(faceCanvas);
  const faceDecal = createFaceDecal(orb, faceTexture);

  const effectManager = createOrbEffects(root, pointer, orbMaterial);
  root.add(faceDecal);
  createEffectControls(effectManager, (effect) => {
    activeFaceStyle = effect.faceStyle || DEFAULT_FACE_STYLE;
    drawExpression(faceCtx, expressionAt(performance.now() * 0.001), activeFaceStyle);
    faceTexture.needsUpdate = true;
    render.activeExpression = undefined;
  });

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 48),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, -1.18, 0.18);
  shadow.scale.set(1.55, 0.32, 1);
  scene.add(shadow);

  scene.add(new THREE.AmbientLight(0xd8e3ff, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(-2.2, 2.8, 3.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x68a7ff, 1.25);
  rim.position.set(2.4, -0.6, 2.2);
  scene.add(rim);

  function resize() {
    const box = host.getBoundingClientRect();
    const size = Math.max(1, Math.floor(Math.min(box.width || 320, box.height || 320)));
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }

  function handlePointerMove(event) {
    const box = host.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const reach = Math.max(90, Math.min(window.innerWidth, window.innerHeight) * 0.32);
    pointer.x = Math.max(-1, Math.min(1, (event.clientX - centerX) / reach));
    pointer.y = Math.max(-1, Math.min(1, (event.clientY - centerY) / reach));
  }

  function render(time) {
    const elapsed = time * 0.001;
    const expression = expressionAt(elapsed);
    look.x += (pointer.x - look.x) * 0.08;
    look.y += (pointer.y - look.y) * 0.08;
    root.rotation.y = Math.sin(elapsed * 0.5) * 0.08 + look.x * 0.3;
    root.rotation.x = Math.sin(elapsed * 0.38) * 0.024 - 0.02 - look.y * 0.18;
    root.position.y = Math.sin(elapsed * 0.8) * 0.035;
    if (render.activeExpression !== expression.key) {
      render.activeExpression = expression.key;
      drawExpression(faceCtx, expression, activeFaceStyle);
      faceTexture.needsUpdate = true;
    }
    effectManager.update(elapsed);
    frameCallbacks.forEach((callback) => callback(elapsed));
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  resize();
  new ResizeObserver(resize).observe(host);
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  requestAnimationFrame(render);
}

createScene().catch((error) => {
  document.body.insertAdjacentHTML("beforeend", `<pre class="lab-error">${String(error && error.stack ? error.stack : error)}</pre>`);
});
