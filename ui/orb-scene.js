import * as THREE from "./vendor/three.module.min.js";
import { createOrbEffects } from "./orb-effects.js";
import { createOrbFace } from "./orb-face.js";

const React = window.React;
const { useEffect, useMemo, useRef } = React;
const h = React.createElement;

const STATUS_SPEED = {
  running: 1,
  pending: 0.58,
  completed: 0.34,
  failed: 0.18,
  cancelled: 0.08
};

const CLICK_EFFECTS = ["dyson", "alien-civilization", "earth", "water", "glass", "dot-points", "mesh", "fire", "rainbow-bands"];
const SUCCESS_EFFECTS = ["earth", "water", "dyson", "dot-points"];
const RUNNING_EFFECTS = ["mesh", "dot-points"];
const ERROR_EFFECTS = ["error-mesh", "fire"];

const STATUS_ORB_STYLES = {
  completed: { color: 0x58645d, roughness: 0.62, metalness: 0.14, emissive: 0x0d2d1d, emissiveIntensity: 0.12, opacity: 1 },
  failed: { color: 0x7d302b, roughness: 0.6, metalness: 0.14, emissive: 0x4b0d0a, emissiveIntensity: 0.2, opacity: 1 },
  running: { color: 0x315f8f, roughness: 0.62, metalness: 0.14, emissive: 0x0f2f59, emissiveIntensity: 0.16, opacity: 1 },
  cancelled: { color: 0x555a58, roughness: 0.76, metalness: 0.08, emissive: 0x111111, emissiveIntensity: 0.06, opacity: 1 },
  pending: { color: 0x50504e, roughness: 0.7, metalness: 0.18, emissive: 0x111111, emissiveIntensity: 0.08, opacity: 1 }
};

const STATUS_AURA_STYLES = {
  completed: { colorA: 0x31f58c, colorB: 0x93ffd1, intensity: 0.7 },
  failed: { colorA: 0xff5a50, colorB: 0xffb199, intensity: 0.74 },
  running: { colorA: 0x60a5fa, colorB: 0xb7d7ff, intensity: 0.72 },
  pending: { colorA: 0xf5b83f, colorB: 0xffdf8f, intensity: 0.58 },
  cancelled: { colorA: 0x8c8c87, colorB: 0xd2d2ca, intensity: 0.42 }
};

function createStatusAura() {
  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uColorA: { value: new THREE.Color(0x31f58c) },
    uColorB: { value: new THREE.Color(0x93ffd1) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;

      void main() {
        vPosition = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying vec3 vPosition;
      varying vec3 vNormal;

      void main() {
        float rim = pow(1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 1.85);
        float ribbon = 0.5 + 0.5 * sin(vPosition.y * 10.0 + vPosition.x * 4.0 + uTime * 1.4);
        float shimmer = 0.5 + 0.5 * sin((vPosition.x - vPosition.y) * 16.0 - uTime * 2.1);
        float band = smoothstep(0.58, 1.0, ribbon) * 0.34 + smoothstep(0.72, 1.0, shimmer) * 0.16;
        float alpha = (rim * 0.74 + band * rim * 0.62) * uIntensity;
        vec3 color = mix(uColorA, uColorB, ribbon) * (0.72 + rim * 0.6);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.026, 96, 64), material);
  mesh.renderOrder = 6;
  mesh.visible = false;
  return {
    mesh,
    setStatus(status) {
      const style = STATUS_AURA_STYLES[status] || STATUS_AURA_STYLES.pending;
      mesh.visible = Boolean(style);
      uniforms.uColorA.value.setHex(style.colorA);
      uniforms.uColorB.value.setHex(style.colorB);
      uniforms.uIntensity.value = style.intensity;
    },
    update(elapsed) {
      uniforms.uTime.value = elapsed;
    }
  };
}

function telemetryFrom(record, graph) {
  const counts = graph?.counts || {};
  const events = Array.isArray(graph?.events) ? graph.events : [];
  const latestEvent = events[events.length - 1] || null;
  return {
    status: record?.status || "pending",
    counts: {
      running: counts.running || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      pending: counts.pending || 0,
      cancelled: counts.cancelled || 0
    },
    eventCount: events.length,
    latestEventType: latestEvent?.type || "",
    latestEventStatus: latestEvent?.status || "",
    nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0
  };
}

function signatureFor(telemetry) {
  const counts = telemetry.counts;
  return [telemetry.status, telemetry.eventCount, counts.running, counts.completed, counts.failed, counts.cancelled, telemetry.latestEventType].join(":");
}

function pick(list, index) {
  return list[index % list.length];
}

function moodForStatus(status) {
  if (status === "running") return "thinking";
  if (status === "failed") return "error";
  if (status === "completed") return "success";
  if (status === "cancelled") return "sleep";
  return "idle";
}

function createOrbScene(host, initialTelemetry) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 0.04, 3.65);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const root = new THREE.Group();
  root.scale.setScalar(0.94);
  scene.add(root);

  const orbMaterial = new THREE.MeshStandardMaterial({
    color: 0x50504e,
    roughness: 0.68,
    metalness: 0.18,
    emissive: new THREE.Color(0x111111),
    emissiveIntensity: 0.08
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), orbMaterial);
  root.add(orb);
  const statusAura = createStatusAura();
  root.add(statusAura.mesh);

  const pointer = { x: 0, y: 0 };
  const look = { x: 0, y: 0 };
  const effectManager = createOrbEffects(root, pointer, orbMaterial, { includeNeutral: true, includeEventVariants: true });
  const face = createOrbFace(orb);
  root.add(face.group);
  effectManager.setActive("neutral", { immediate: true });

  scene.add(new THREE.AmbientLight(0xd8e3ff, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(-2.2, 2.8, 3.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x68a7ff, 1.2);
  rim.position.set(2.4, -0.6, 2.2);
  scene.add(rim);

  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clock = new THREE.Clock();
  const state = {
    telemetry: initialTelemetry,
    previousTelemetry: initialTelemetry,
    signature: signatureFor(initialTelemetry),
    mood: "idle",
    eventEffectUntil: 0,
    suppressedReactionUntil: 0,
    reactionIndex: 0
  };
  let frame = 0;

  function setHostEffect(effectId) {
    host.classList.toggle("effect-rainbow", effectId === "rainbow-bands");
  }

  function applyStatusOrbStyle(status) {
    const style = STATUS_ORB_STYLES[status] || STATUS_ORB_STYLES.pending;
    orbMaterial.color.setHex(style.color);
    orbMaterial.roughness = style.roughness;
    orbMaterial.metalness = style.metalness;
    orbMaterial.emissive.setHex(style.emissive);
    orbMaterial.emissiveIntensity = style.emissiveIntensity;
    orbMaterial.opacity = style.opacity;
    orbMaterial.transparent = style.opacity < 1;
    orbMaterial.depthWrite = style.opacity >= 0.95;
    orbMaterial.needsUpdate = true;
    statusAura.setStatus(status);
  }

  function applyVisual(effectId, mood, elapsed, ttl = 2.8) {
    const active = effectManager.setActive(effectId);
    statusAura.setStatus("pending");
    setHostEffect(effectId);
    face.setFaceStyle(active.faceStyle);
    face.setMood(mood);
    face.burst(mood);
    state.mood = mood;
    state.eventEffectUntil = elapsed + ttl;
  }

  function chooseReaction(next, previous) {
    const counts = next.counts;
    const prev = previous.counts;
    if ((counts.failed > prev.failed || next.status === "failed") && next.status !== previous.status) {
      return { effect: pick(ERROR_EFFECTS, state.reactionIndex++), mood: "error", ttl: 4.2 };
    }
    if (counts.failed > prev.failed) return { effect: pick(ERROR_EFFECTS, state.reactionIndex++), mood: "error", ttl: 4.2 };
    if (counts.completed > prev.completed) return { effect: pick(SUCCESS_EFFECTS, state.reactionIndex++), mood: "success", ttl: 3.4 };
    if (counts.running > prev.running || next.latestEventType.includes("started")) return { effect: pick(RUNNING_EFFECTS, state.reactionIndex++), mood: "thinking", ttl: 2.4 };
    if (next.status === "completed" && previous.status !== "completed") return { effect: "earth", mood: "success", ttl: 5.2 };
    if (next.status === "cancelled" && previous.status !== "cancelled") return { effect: "glass", mood: "sleep", ttl: 3.8 };
    return null;
  }

  function settle(elapsed) {
    if (state.eventEffectUntil && elapsed < state.eventEffectUntil) return;
    state.eventEffectUntil = 0;
    const mood = moodForStatus(state.telemetry.status);
    if (effectManager.activeId !== "neutral") {
      const active = effectManager.setActive("neutral");
      setHostEffect("neutral");
      face.setFaceStyle(active.faceStyle);
    }
    applyStatusOrbStyle(state.telemetry.status);
    face.setMood(mood);
    state.mood = mood;
  }

  function updateTelemetry(nextTelemetry) {
    const nextSignature = signatureFor(nextTelemetry);
    if (nextSignature === state.signature) return;
    state.previousTelemetry = state.telemetry;
    state.telemetry = nextTelemetry;
    state.signature = nextSignature;
    if (clock.getElapsedTime() < state.suppressedReactionUntil) return;
    const reaction = chooseReaction(state.telemetry, state.previousTelemetry);
    if (reaction) applyVisual(reaction.effect, reaction.mood, clock.getElapsedTime(), reaction.ttl);
  }

  function resize() {
    const box = host.getBoundingClientRect();
    const size = Math.max(1, Math.floor(Math.min(box.width || 118, box.height || 118)));
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }

  function handlePointerMove(event) {
    const box = host.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const reach = Math.max(80, Math.min(window.innerWidth, window.innerHeight) * 0.42);
    pointer.x = Math.max(-1, Math.min(1, (event.clientX - centerX) / reach));
    pointer.y = Math.max(-1, Math.min(1, (centerY - event.clientY) / reach));
  }

  function handlePointerLeave() {
    pointer.x = 0;
    pointer.y = 0;
  }

  function handleClick() {
    const elapsed = clock.getElapsedTime();
    if (effectManager.activeId !== "neutral" || state.eventEffectUntil) {
      state.eventEffectUntil = 0;
      state.suppressedReactionUntil = elapsed + 4;
      const active = effectManager.setActive("neutral", { immediate: true });
      setHostEffect("neutral");
      const mood = moodForStatus(state.telemetry.status);
      face.setFaceStyle(active.faceStyle);
      applyStatusOrbStyle(state.telemetry.status);
      face.setMood(mood);
      state.mood = mood;
      return;
    }
    const effect = pick(CLICK_EFFECTS, state.reactionIndex++);
    const mood = effect === "fire" ? "error" : effect === "earth" || effect === "dyson" || effect === "rainbow-bands" ? "delight" : "success";
    applyVisual(effect, mood, elapsed, 3.2);
  }

  function render() {
    const elapsed = clock.getElapsedTime();
    const speed = STATUS_SPEED[state.telemetry.status] || 0.4;
    look.x += (pointer.x - look.x) * 0.08;
    look.y += (pointer.y - look.y) * 0.08;
    root.rotation.y = Math.sin(elapsed * 0.72 * speed) * 0.13 + look.x * 0.26;
    root.rotation.x = Math.sin(elapsed * 0.46 * speed) * 0.04 - 0.03 - look.y * 0.16;
    root.position.y = Math.sin(elapsed * 1.15 * speed) * 0.055;
    settle(elapsed);
    effectManager.update(elapsed);
    if (effectManager.activeId === "neutral") applyStatusOrbStyle(state.telemetry.status);
    statusAura.update(elapsed);
    face.update(elapsed, look);
    renderer.render(scene, camera);
    if (!reducedMotion) frame = window.requestAnimationFrame(render);
  }

  resize();
  render();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerleave", handlePointerLeave, { passive: true });
  host.addEventListener("click", handleClick);

  return {
    updateTelemetry,
    dispose() {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      host.removeEventListener("click", handleClick);
      face.dispose();
      renderer.dispose();
      const geometries = new Set();
      const materials = new Set();
      root.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    }
  };
}

export function OrbScene({ record, graph }) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const telemetry = useMemo(() => telemetryFrom(record || {}, graph || {}), [record, graph]);

  useEffect(() => {
    if (!hostRef.current) return undefined;
    sceneRef.current = createOrbScene(hostRef.current, telemetry);
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.updateTelemetry(telemetry);
  }, [telemetry]);

  return h("button", {
    className: `controller-orb status-${telemetry.status || "pending"}`,
    ref: hostRef,
    type: "button",
    title: "Nudge the Ultracode orb",
    "aria-label": "Animated workflow controller orb"
  });
}
