import * as THREE from "./vendor/three.module.min.js";
import { DecalGeometry } from "./vendor/DecalGeometry.js";

const FACE_COLOR = "#f5f0e8";
const DEFAULT_FACE_STYLE = {
  color: FACE_COLOR,
  outlineColor: FACE_COLOR,
  lineWidth: 10,
  shadowColor: "rgba(0, 0, 0, 0.32)",
  shadowBlur: 10
};

const MOOD_EXPRESSIONS = {
  idle: [
    { key: "flat", label: "-_-", hold: 28 },
    { key: "scan", label: "._.", hold: 24 },
    { key: "wavy", label: "~_~", hold: 0.16 }
  ],
  thinking: [
    { key: "scrunch", label: ">_<", hold: 8.4 },
    { key: "spark-focus", label: "*_*", hold: 0.7 },
    { key: "pinch", label: ">-<", hold: 0.7 }
  ],
  success: [
    { key: "satisfied", label: "-)-", hold: 2.4 }
  ],
  error: [
    { key: "panic", label: "x_x", hold: 2.2 },
    { key: "static", label: "#_#", hold: 2 }
  ],
  delight: [
    { key: "smile", label: ">)<", hold: 2.2 }
  ],
  sleep: [
    { key: "sleep", label: "z_z", hold: 2.4 }
  ]
};

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

function drawSatisfied(ctx, width, height, fontSize, color) {
  const centerX = width / 2;
  const eyeY = height / 2 - height * 0.06;
  ctx.font = `900 ${fontSize * 0.82}px "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.fillText("-", centerX - width * 0.2, eyeY);
  ctx.fillText("-", centerX + width * 0.2, eyeY);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(8, fontSize * 0.1);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(centerX - width * 0.12, height / 2 + height * 0.12);
  ctx.quadraticCurveTo(centerX, height / 2 + height * 0.22, centerX + width * 0.12, height / 2 + height * 0.12);
  ctx.stroke();
  ctx.restore();
}

function drawExpression(ctx, expression, faceStyle = DEFAULT_FACE_STYLE, fontSize = 224) {
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
  if (expression.key === "satisfied") {
    drawSatisfied(ctx, width, height, fontSize, style.color);
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

function expressionAt(mood, elapsed, forcedExpression) {
  if (forcedExpression) return forcedExpression;
  const sequence = MOOD_EXPRESSIONS[mood] || MOOD_EXPRESSIONS.idle;
  const total = sequence.reduce((sum, expression) => sum + expression.hold, 0);
  let cursor = elapsed % total;
  for (const expression of sequence) {
    cursor -= expression.hold;
    if (cursor <= 0) return expression;
  }
  return sequence[0];
}

export function createOrbFace(orb) {
  const canvas = makeCanvas(512, 320);
  const ctx = canvas.getContext("2d");
  const texture = makeCanvasTexture(canvas);
  const group = new THREE.Group();
  const decal = createFaceDecal(orb, texture);
  group.add(decal);

  let mood = "idle";
  let style = DEFAULT_FACE_STYLE;
  let forcedExpression = null;
  let forcedUntil = 0;
  let lastKey = "";
  let squash = 0;

  function setMood(nextMood) {
    if (nextMood && nextMood !== mood) {
      mood = nextMood;
      lastKey = "";
    }
  }

  function setFaceStyle(nextStyle) {
    style = nextStyle || DEFAULT_FACE_STYLE;
    lastKey = "";
  }

  function burst(nextMood, expressionKey) {
    if (nextMood) setMood(nextMood);
    const sequence = MOOD_EXPRESSIONS[nextMood] || MOOD_EXPRESSIONS[mood] || MOOD_EXPRESSIONS.idle;
    forcedExpression = expressionKey ? sequence.find((expression) => expression.key === expressionKey) || null : sequence[0];
    forcedUntil = performance.now() * 0.001 + 1.4;
    squash = 1;
    lastKey = "";
  }

  function update(elapsed, look) {
    if (forcedExpression && elapsed > forcedUntil) forcedExpression = null;
    const expression = expressionAt(mood, elapsed * 0.82, forcedExpression);
    const styleKey = `${expression.key}:${style.color}:${style.outlineColor}:${style.lineWidth}`;
    if (styleKey !== lastKey) {
      drawExpression(ctx, expression, style);
      texture.needsUpdate = true;
      lastKey = styleKey;
    }
    squash += (0 - squash) * 0.08;
    const bounce = squash * Math.sin(elapsed * 22) * 0.035;
    decal.position.set((look?.x || 0) * 0.018, -(look?.y || 0) * 0.012 + bounce, 0);
    decal.scale.set(1 + squash * 0.035, 1 - squash * 0.02, 1);
  }

  function dispose() {
    decal.geometry.dispose();
    decal.material.dispose();
    texture.dispose();
  }

  drawExpression(ctx, MOOD_EXPRESSIONS.idle[0], style);
  return { group, setMood, setFaceStyle, burst, update, dispose };
}
