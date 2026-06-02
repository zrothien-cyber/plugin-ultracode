import * as THREE from "/vendor/three.module.min.js";

const RAINBOW_COLORS = [0xd71920, 0xf28c19, 0xf6df2d, 0x45b936, 0x1e58d8, 0x66baf4, 0x8b3fb8].map((hex) => new THREE.Color(hex));
const IMAGE_TEXTURES = {
  earth: "/assets/orb-earth-generated.png",
  alien: "/assets/orb-alien-civilization-generated.png",
  dyson: "/assets/orb-dyson-sphere-generated.png",
  water: "/assets/orb-water-generated.png",
  glass: "/assets/orb-glass-generated.png"
};
const DEFAULT_ORB_STYLE = {
  color: 0x50504e,
  roughness: 0.7,
  metalness: 0.18,
  emissive: 0x111111,
  emissiveIntensity: 0.08,
  opacity: 1
};
let pointSpriteTexture;

function makeImageTexture(src) {
  const texture = new THREE.TextureLoader().load(src);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function makePointSpriteTexture() {
  if (pointSpriteTexture) return pointSpriteTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.42, "rgba(255, 255, 255, 0.9)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  pointSpriteTexture = new THREE.CanvasTexture(canvas);
  pointSpriteTexture.needsUpdate = true;
  return pointSpriteTexture;
}

function createShell(material, radius = 1.012, widthSegments = 128, heightSegments = 96) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, widthSegments, heightSegments), material);
}

function makeOrbDustPoints({
  count = 520,
  size = 0.018,
  opacity = 0.72,
  radiusMin = 0.96,
  radiusJitter = 0.42,
  yScale = 0.98,
  hue = 0.62,
  hueSpread = 0.18,
  saturation = 0.72,
  lightness = 0.64
} = {}) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const shellRadius = Math.sqrt(1 - y * y) * (radiusMin + ((i * 23) % 100) / 100 * radiusJitter);
    const theta = i * 2.399963;
    positions[i * 3] = Math.cos(theta) * shellRadius;
    positions[i * 3 + 1] = y * yScale;
    positions[i * 3 + 2] = Math.sin(theta) * shellRadius;
    color.setHSL(hue + ((i * 11) % 100) / 100 * hueSpread, saturation, lightness);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size, map: makePointSpriteTexture(), vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, alphaTest: 0.05 })
  );
}

function applyOrbStyle(material, style = {}) {
  const next = { ...DEFAULT_ORB_STYLE, ...style };
  material.color.setHex(next.color);
  material.roughness = next.roughness;
  material.metalness = next.metalness;
  material.emissive.setHex(next.emissive);
  material.emissiveIntensity = next.emissiveIntensity;
  material.opacity = next.opacity;
  material.transparent = next.opacity < 1;
  material.depthWrite = next.opacity >= 0.95;
  material.needsUpdate = true;
}

function makeRainbowBandShell({ radius = 1.012, renderOrder = 10, transparent = false, depthTest = true } = {}) {
  const axes = [
    new THREE.Vector3(0.5, -0.82, 0.24).normalize(),
    new THREE.Vector3(-0.68, -0.42, 0.6).normalize(),
    new THREE.Vector3(0.28, 0.72, 0.64).normalize(),
    new THREE.Vector3(0.82, 0.16, -0.54).normalize()
  ];
  const uniforms = {
    uHead: { value: -1.28 },
    uAxis: { value: axes[0].clone() },
    uColors: { value: RAINBOW_COLORS.map((color) => color.clone()) }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vObjectPosition;

      void main() {
        vObjectPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uHead;
      uniform vec3 uAxis;
      uniform vec3 uColors[7];
      varying vec3 vObjectPosition;

      void main() {
        float trainLength = 2.02;
        float stripeWidth = trainLength / 7.0;
        float coordinate = dot(normalize(vObjectPosition), normalize(uAxis));
        float fromHead = uHead - coordinate;

        if (fromHead < 0.0 || fromHead > trainLength) {
          discard;
        }

        int stripe = int(clamp(floor(fromHead / stripeWidth), 0.0, 6.0));
        gl_FragColor = vec4(uColors[stripe], 1.0);
      }
    `,
    transparent,
    depthWrite: false,
    depthTest,
    polygonOffset: true,
    polygonOffsetFactor: -6
  });
  const mesh = createShell(material, radius);
  mesh.renderOrder = renderOrder;

  return {
    axes,
    mesh,
    setSweep(axisIndex, head) {
      uniforms.uAxis.value.copy(axes[axisIndex % axes.length]);
      uniforms.uHead.value = head;
    },
    setColors(colors) {
      uniforms.uColors.value.forEach((color, index) => {
        color.copy(colors[index % colors.length]);
      });
    }
  };
}

function makeRainbowBandEffect() {
  const bands = makeRainbowBandShell();

  return {
    id: "rainbow-bands",
    label: "Rainbow bands",
    category: "Surface",
    description: "Wide opaque color bands sweep across the orb from changing point pairs.",
    object: bands.mesh,
    update(elapsed) {
      const cycle = Math.floor((elapsed * 1.9) / 4.42);
      bands.setSweep(cycle, ((elapsed * 1.9) % 4.42) - 1.2);
    }
  };
}

function makeNeutralEffect() {
  return {
    id: "neutral",
    label: "Neutral",
    category: "Core",
    description: "The default graphite Ultracode orb, calm and attentive.",
    baseStyle: { color: 0x50504e, roughness: 0.7, metalness: 0.18, emissive: 0x111111, emissiveIntensity: 0.08, opacity: 1 },
    object: new THREE.Group(),
    update() {}
  };
}

function makeImageSkinEffect({ id, label, description, textureUrl, roughness, metalness, emissive, baseStyle }) {
  const texture = makeImageTexture(textureUrl);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness,
    metalness,
    emissive: new THREE.Color(emissive || 0x000000),
    emissiveIntensity: emissive ? 0.08 : 0
  });
  const mesh = createShell(material, 1.006);
  return {
    id,
    label,
    category: "Images",
    description,
    baseStyle,
    object: mesh,
    update(elapsed) {
      texture.offset.x = (elapsed * 0.025) % 1;
    }
  };
}

function makeAtmosphereShell(colorA, colorB, intensity = 0.32) {
  const uniforms = {
    uTime: { value: 0 },
    uColorA: { value: new THREE.Color(colorA) },
    uColorB: { value: new THREE.Color(colorB) },
    uIntensity: { value: intensity }
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
        float rim = pow(1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 1.7);
        float wave = 0.5 + 0.5 * sin(vPosition.x * 11.0 + vPosition.y * 8.0 + uTime * 2.2);
        vec3 color = mix(uColorA, uColorB, wave);
        gl_FragColor = vec4(color * (0.85 + rim), (rim * 0.62 + wave * 0.12) * uIntensity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const shell = createShell(material, 1.03);
  shell.userData.atmosphere = true;
  return shell;
}

function makeImageDustWorldEffect({
  id,
  label,
  description,
  textureUrl,
  roughness,
  metalness,
  emissive,
  baseStyle,
  dustOptions,
  atmosphere
}) {
  const texture = makeImageTexture(textureUrl);
  const group = new THREE.Group();
  const skin = createShell(
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness,
      metalness,
      emissive: new THREE.Color(emissive || 0x000000),
      emissiveIntensity: emissive ? 0.1 : 0
    }),
    1.006
  );
  const dust = makeOrbDustPoints(dustOptions);
  dust.userData.worldDust = true;
  group.add(skin, dust);
  if (atmosphere) {
    group.add(makeAtmosphereShell(atmosphere.colorA, atmosphere.colorB, atmosphere.intensity));
  }
  return {
    id,
    label,
    category: "Images",
    description,
    baseStyle,
    object: group,
    update(elapsed) {
      texture.offset.x = (elapsed * 0.022) % 1;
      dust.rotation.y = elapsed * 0.12;
      dust.rotation.x = Math.sin(elapsed * 0.32) * 0.08;
      group.children.forEach((child) => {
        if (child.userData.atmosphere) child.material.uniforms.uTime.value = elapsed;
      });
    }
  };
}

function makeDysonRingMaterial(colorA, colorB, offset) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uOffset: { value: offset }
    },
    vertexShader: `
      varying vec3 vPosition;

      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      uniform float uOffset;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying vec3 vPosition;

      void main() {
        float sweep = 0.5 + 0.5 * sin(atan(vPosition.y, vPosition.x) * 8.0 - uTime * 4.6 + uOffset);
        float pulse = smoothstep(0.2, 1.0, sweep);
        vec3 color = mix(uColorA, uColorB, pulse);
        gl_FragColor = vec4(color * (0.85 + pulse * 1.35), 0.5 + pulse * 0.38);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
}

function makeDysonSparks(radius, offset, colorHex) {
  const count = 52;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color(colorHex);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + offset;
    const bump = i % 4 === 0 ? 0.035 : 0;
    positions[i * 3] = Math.cos(angle) * (radius + bump);
    positions[i * 3 + 1] = Math.sin(angle) * (radius + bump);
    positions[i * 3 + 2] = Math.sin(i * 2.1) * 0.012;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: 0.04, map: makePointSpriteTexture(), vertexColors: true, transparent: true, opacity: 0.88, depthWrite: false, blending: THREE.AdditiveBlending, alphaTest: 0.05 })
  );
}

function makeDysonHaloEffect() {
  const group = new THREE.Group();
  const texture = makeImageTexture(IMAGE_TEXTURES.dyson);
  const skin = createShell(
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.32,
      metalness: 0.18,
      emissive: new THREE.Color(0xff7a16),
      emissiveIntensity: 0.16
    }),
    1.006
  );
  group.add(skin);
  for (let i = 0; i < 3; i += 1) {
    const radius = 1.14 + i * 0.045;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.014 + i * 0.003, 12, 192),
      makeDysonRingMaterial(i === 1 ? 0xffffff : 0xff7a16, i === 1 ? 0x69f2ff : 0xffee80, i * 1.7)
    );
    const sparks = makeDysonSparks(radius, i * 0.6, i === 1 ? 0x9fffff : 0xffe071);
    ring.rotation.x = Math.PI / 2 + i * 0.22;
    ring.rotation.y = i * 0.5;
    sparks.rotation.copy(ring.rotation);
    ring.userData.dysonBand = true;
    ring.userData.speed = 0.12 + i * 0.04;
    sparks.userData.dysonSparks = true;
    sparks.userData.speed = 0.18 + i * 0.06;
    group.add(ring, sparks);
  }
  return {
    id: "dyson",
    label: "Dyson Sun",
    category: "Images",
    description: "A generated Sun-and-megastructure texture with animated collector bands and bright orbit sparks.",
    baseStyle: { color: 0x3b1905, roughness: 0.38, metalness: 0.12, emissive: 0x8f2d00, emissiveIntensity: 0.42, opacity: 0.24 },
    object: group,
    update(elapsed) {
      texture.offset.x = (elapsed * 0.018) % 1;
      group.children.forEach((child) => {
        if (child.userData.dysonBand) {
          child.rotation.z = elapsed * child.userData.speed;
          child.material.uniforms.uTime.value = elapsed;
        }
        if (child.userData.dysonSparks) {
          child.rotation.z = elapsed * child.userData.speed;
        }
      });
    }
  };
}

function makeGlassEffect() {
  const texture = makeImageTexture(IMAGE_TEXTURES.glass);
  const uniforms = {
    uTime: { value: 0 }
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vPosition;

      void main() {
        float fresnel = pow(1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 2.15);
        float shimmer = 0.5 + 0.5 * sin((vPosition.x + vPosition.y) * 14.0 + uTime * 2.4);
        vec3 color = mix(vec3(0.70, 0.93, 1.0), vec3(1.0), fresnel);
        gl_FragColor = vec4(color + shimmer * 0.08, 0.12 + fresnel * 0.18);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  });
  const group = new THREE.Group();
  const skin = createShell(
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      opacity: 0.24,
      roughness: 0.16,
      metalness: 0.02,
      emissive: new THREE.Color(0xb9ecff),
      emissiveIntensity: 0.08,
      depthWrite: false
    }),
    1.008
  );
  const shell = createShell(material, 1.022);
  group.add(skin, shell);
  return {
    id: "glass",
    label: "Glass",
    category: "Images",
    description: "A generated frosted-glass texture with moving highlights and a bright rim.",
    baseStyle: { color: 0xd8f4ff, roughness: 0.12, metalness: 0, emissive: 0x7bd7ff, emissiveIntensity: 0.08, opacity: 0.04 },
    faceStyle: { color: "#101820", outlineColor: "#101820", lineWidth: 18, shadowColor: "rgba(255, 255, 255, 0)", shadowBlur: 0 },
    object: group,
    update(elapsed) {
      texture.offset.x = (elapsed * 0.018) % 1;
      uniforms.uTime.value = elapsed;
    }
  };
}

function makeDotPointsEffect() {
  const count = 520;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = i * 2.399963;
    positions[i * 3] = Math.cos(theta) * radius * 1.035;
    positions[i * 3 + 1] = y * 1.035;
    positions[i * 3 + 2] = Math.sin(theta) * radius * 1.035;
    color.setHSL((i / count + 0.55) % 1, 0.78, 0.68);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: 0.032, map: makePointSpriteTexture(), vertexColors: true, transparent: true, opacity: 0.96, depthWrite: false, alphaTest: 0.05 })
  );
  return {
    id: "dot-points",
    label: "Dot points",
    category: "Particles",
    description: "Bright bead-like points float in a sphere with the base orb hidden.",
    baseStyle: { color: 0x000000, roughness: 0.7, metalness: 0, emissive: 0x000000, emissiveIntensity: 0, opacity: 0 },
    object: points,
    update(elapsed) {
      points.rotation.y = elapsed * 0.3;
      points.rotation.x = Math.sin(elapsed * 0.7) * 0.12;
    }
  };
}

function makeMeshEffect() {
  const wire = createShell(
    new THREE.MeshBasicMaterial({ color: 0x65e8ff, wireframe: true, transparent: true, opacity: 0.9, depthWrite: false }),
    1.018,
    32,
    18
  );
  return {
    id: "mesh",
    label: "Mesh",
    category: "Particles",
    description: "A clean luminous wire mesh wraps the sphere without extra orbit lines.",
    baseStyle: { color: 0x06121a, roughness: 0.5, metalness: 0.32, emissive: 0x06202c, emissiveIntensity: 0.18, opacity: 0 },
    object: wire,
    update(elapsed) {
      wire.rotation.y = elapsed * 0.18;
    }
  };
}

function makeErrorMeshEffect() {
  const wire = createShell(
    new THREE.MeshBasicMaterial({ color: 0xff5a50, wireframe: true, transparent: true, opacity: 0.94, depthWrite: false }),
    1.022,
    32,
    18
  );
  const pulse = createShell(
    new THREE.MeshBasicMaterial({ color: 0xff1d1d, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    1.034,
    64,
    40
  );
  const group = new THREE.Group();
  group.add(wire, pulse);
  return {
    id: "error-mesh",
    label: "Error mesh",
    category: "Event",
    description: "A red warning mesh for worker failures and sharp error moments.",
    baseStyle: { color: 0x190607, roughness: 0.5, metalness: 0.26, emissive: 0x4a0508, emissiveIntensity: 0.34, opacity: 0.03 },
    object: group,
    update(elapsed) {
      wire.rotation.y = elapsed * 0.42;
      wire.rotation.x = Math.sin(elapsed * 1.1) * 0.12;
      pulse.scale.setScalar(1 + Math.sin(elapsed * 6) * 0.04);
    }
  };
}

function makeFireEffect() {
  const uniforms = { uTime: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vPosition;

      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      varying vec3 vPosition;

      void main() {
        float height = clamp((vPosition.y + 1.0) * 0.5, 0.0, 1.0);
        float lick = sin(vPosition.x * 18.0 + uTime * 5.0) * sin(vPosition.z * 13.0 - uTime * 4.3);
        float flame = smoothstep(0.64 + lick * 0.11, 0.1, height);
        vec3 color = mix(vec3(0.92, 0.08, 0.02), vec3(1.0, 0.78, 0.18), height + lick * 0.12);
        gl_FragColor = vec4(color, flame * 0.86);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const shell = createShell(material, 1.016);
  return {
    id: "fire",
    label: "Fire",
    category: "Particles",
    description: "Only the procedural flame shell remains, with the base sphere hidden.",
    baseStyle: { color: 0x000000, roughness: 0.82, metalness: 0.04, emissive: 0x000000, emissiveIntensity: 0, opacity: 0 },
    object: shell,
    update(elapsed) {
      uniforms.uTime.value = elapsed;
    }
  };
}

export function createOrbEffects(root, pointer, orbMaterial, options = {}) {
  const context = { rootScale: 0.94, pointer };
  const transition = makeRainbowBandShell({ radius: 1.045, renderOrder: 35, transparent: true, depthTest: false });
  transition.mesh.visible = false;
  const baseEffects = [
    makeRainbowBandEffect(),
    makeImageSkinEffect({
      id: "earth",
      label: "Earth",
      description: "A generated tiny-world texture with continents, clouds, oceans, and storms.",
      textureUrl: IMAGE_TEXTURES.earth,
      roughness: 0.62,
      metalness: 0.04,
      emissive: 0x082846,
      baseStyle: { color: 0x17384b, roughness: 0.62, metalness: 0.04, emissive: 0x09203a, emissiveIntensity: 0.1, opacity: 0.18 }
    }),
    makeImageDustWorldEffect({
      id: "alien-civilization",
      label: "Alien world",
      description: "A generated alien civilization planet wrapped in cyan nebula dust and signal glow.",
      textureUrl: IMAGE_TEXTURES.alien,
      roughness: 0.48,
      metalness: 0.08,
      emissive: 0x1d6f82,
      baseStyle: { color: 0x152b36, roughness: 0.52, metalness: 0.08, emissive: 0x10394a, emissiveIntensity: 0.2, opacity: 0.18 },
      dustOptions: { count: 460, size: 0.018, opacity: 0.74, radiusMin: 1.02, radiusJitter: 0.36, yScale: 0.98, hue: 0.48, hueSpread: 0.22, saturation: 0.82, lightness: 0.66 },
      atmosphere: { colorA: 0x24ffd6, colorB: 0x7b4dff, intensity: 0.34 }
    }),
    makeDysonHaloEffect(),
    makeImageSkinEffect({
      id: "water",
      label: "Water",
      description: "A generated water-caustic texture with glowing blue ripples.",
      textureUrl: IMAGE_TEXTURES.water,
      roughness: 0.22,
      metalness: 0.2,
      emissive: 0x073e63,
      baseStyle: { color: 0x06395c, roughness: 0.28, metalness: 0.18, emissive: 0x062c4a, emissiveIntensity: 0.18, opacity: 0.28 }
    }),
    makeGlassEffect(),
    makeDotPointsEffect(),
    makeMeshEffect(),
    makeFireEffect()
  ];
  const effects = [
    ...(options.includeNeutral ? [makeNeutralEffect()] : []),
    ...baseEffects,
    ...(options.includeEventVariants ? [makeErrorMeshEffect()] : [])
  ];
  const group = new THREE.Group();
  effects.forEach((effect) => {
    effect.object.visible = false;
    effect.object.traverse((child) => {
      child.renderOrder = 10;
    });
    group.add(effect.object);
  });
  group.add(transition.mesh);
  root.add(group);

  let activeEffect = effects[0];
  let transitionState = null;
  let transitionCount = 0;
  let previousElapsed = 0;
  activeEffect.object.visible = true;
  applyOrbStyle(orbMaterial, activeEffect.baseStyle);

  function activateEffect(next) {
    if (activeEffect.deactivate) activeEffect.deactivate(context);
    activeEffect.object.visible = false;
    activeEffect = next;
    activeEffect.object.visible = true;
    applyOrbStyle(orbMaterial, activeEffect.baseStyle);
  }

  function updateTransition(elapsed, delta) {
    if (!transitionState) return;
    transitionState.elapsed += delta;
    const progress = Math.min(1, transitionState.elapsed / 0.82);
    transition.setSweep(transitionState.axisIndex, -1.24 + progress * 4.32);
    transition.mesh.visible = true;

    if (!transitionState.switched && progress >= 0.42) {
      activateEffect(transitionState.next);
      transitionState.switched = true;
    }

    if (progress >= 1) {
      if (!transitionState.switched) activateEffect(transitionState.next);
      transition.mesh.visible = false;
      transitionState = null;
    }
  }

  return {
    effects: effects.map(({ id, label, category, description, faceStyle }) => ({ id, label, category, description, faceStyle })),
    get activeId() {
      return activeEffect.id;
    },
    setActive(id, options = {}) {
      const next = effects.find((effect) => effect.id === id) || effects[0];
      if (options.immediate) {
        transition.mesh.visible = false;
        transitionState = null;
        if (next !== activeEffect) activateEffect(next);
        return next;
      }
      if (next === activeEffect) return next;
      if (transitionState && transitionState.next === next) return next;
      transition.setColors(RAINBOW_COLORS);
      transitionState = {
        next,
        elapsed: 0,
        switched: false,
        axisIndex: transitionCount
      };
      transitionCount += 1;
      transition.setSweep(transitionState.axisIndex, -1.24);
      transition.mesh.visible = true;
      return next;
    },
    update(elapsed) {
      const delta = Math.min(0.05, Math.max(0, elapsed - previousElapsed));
      previousElapsed = elapsed;
      updateTransition(elapsed, delta);
      if (activeEffect.update) activeEffect.update(elapsed, context);
    }
  };
}
