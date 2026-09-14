/* =========================================================================
   MIDNIGHT CIRCUIT — 3D Street Racer
   Studio-grade Three.js implementation:
   - Procedural closed-loop race track with vertex-colored candy-stripe curbs
   - Instanced street lighting (poles / arms / heads) with dynamic light pooling
   - Arcade vehicle physics (grip, drift, off-track penalty, lap timing)
   - Seamless First-Person <-> Third-Person camera switching
   - Procedural WebAudio engine note
   ========================================================================= */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // GLOBAL STATE
  // ---------------------------------------------------------------------
  const state = {
    started: false,
    cameraMode: 'third', // 'third' | 'first'
    keys: {},
    touch: { left: false, right: false, gas: false, brake: false },
    clock: new THREE.Clock(),
    trackLength: 0,
    lapCount: 1,
    totalLaps: 3,
    raceStartTime: 0,
    raceFinished: false,
    lastProgressIndex: 0,
    progressCrossed: false,
  };

  const car = {
    position: new THREE.Vector3(0, 0, 0),
    heading: 0,          // radians, 0 = +Z
    speed: 0,            // signed, units/sec
    steer: 0,            // current steering angle (radians)
    wheelSpin: 0,
    onTrack: true,
    wrongWay: false,
  };

  // Tunable physics constants
  const PHYS = {
    maxSpeed: 52,          // forward top speed (units/sec)
    maxReverse: -14,
    accel: 26,
    brakeForce: 42,
    reverseAccel: 14,
    dragCoef: 0.985,       // passive drag multiplier per frame @60fps baseline
    rollingResist: 4.2,
    maxSteer: 0.62,        // radians
    steerSpeed: 3.2,       // how fast steering responds
    steerReturn: 4.5,
    grip: 6.6,             // how fast heading follows steering at speed
    offTrackDrag: 0.9,     // extra drag multiplier when off track
    offTrackMaxSpeedFactor: 0.45,
  };

  // ---------------------------------------------------------------------
  // DOM REFS
  // ---------------------------------------------------------------------
  const dom = {
    container: document.getElementById('game-container'),
    startScreen: document.getElementById('start-screen'),
    startBtn: document.getElementById('start-btn'),
    hud: document.getElementById('hud'),
    loading: document.getElementById('loading-screen'),
    lapCount: document.getElementById('lap-count'),
    timer: document.getElementById('timer'),
    speedValue: document.getElementById('speed-value'),
    gaugeFill: document.getElementById('gauge-fill'),
    camBtn: document.getElementById('cam-toggle-btn'),
    camLabel: document.getElementById('cam-label'),
    minimap: document.getElementById('minimap'),
    offtrackWarn: document.getElementById('offtrack-warning'),
    wrongwayWarn: document.getElementById('wrongway-warning'),
    touchControls: document.getElementById('touch-controls'),
    btnLeft: document.getElementById('btn-left'),
    btnRight: document.getElementById('btn-right'),
    btnGas: document.getElementById('btn-gas'),
    btnBrake: document.getElementById('btn-brake'),
  };
  const mmCtx = dom.minimap.getContext('2d');

  // ---------------------------------------------------------------------
  // RENDERER / SCENE / CAMERA
  // ---------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  dom.container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const nightColor = new THREE.Color(0x05070f);
  scene.background = new THREE.Color(0x111a2e);
  scene.fog = new THREE.FogExp2(0x10182b, 0.0065);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);
  camera.position.set(0, 8, -14);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------------
  // LIGHTING (base night ambiance)
  // ---------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0x6f8fc4, 0x202633, 1.05);
  scene.add(hemi);

  const moon = new THREE.DirectionalLight(0xb7c9ff, 0.65);
  moon.position.set(-120, 160, -80);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left = -180;
  moon.shadow.camera.right = 180;
  moon.shadow.camera.top = 180;
  moon.shadow.camera.bottom = -180;
  moon.shadow.camera.far = 400;
  moon.shadow.bias = -0.0015;
  scene.add(moon);
  scene.add(moon.target);

  // Broad fill light keeps the road, buildings and car readable while
  // preserving the neon/night-racing atmosphere on mobile screens.
  const cityFill = new THREE.DirectionalLight(0x5577aa, 0.38);
  cityFill.position.set(80, 55, 40);
  cityFill.target.position.set(0, 0, 0);
  scene.add(cityFill, cityFill.target);

  // Starfield
  (function buildStars() {
    const count = 1200;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 400 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.85); // keep mostly above horizon
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 40;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xbfd8ff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.85 });
    scene.add(new THREE.Points(geo, mat));
  })();

  // ---------------------------------------------------------------------
  // GROUND
  // ---------------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x16241d, roughness: 0.92, metalness: 0.02 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // subtle grid of scattered "trees" (cones) for scenery / depth cues
  (function scatterProps() {
    const geo = new THREE.ConeGeometry(2.2, 7, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e2116, roughness: 1 });
    const count = 140;
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = true;
    const dummy = new THREE.Object3D();
    let placed = 0, attempts = 0;
    while (placed < count && attempts < count * 20) {
      attempts++;
      const x = (Math.random() - 0.5) * 700;
      const z = (Math.random() - 0.5) * 700;
      if (Math.hypot(x, z) < 210) continue; // keep clear of track area
      dummy.position.set(x, 3.5, z);
      dummy.rotation.y = Math.random() * Math.PI;
      const s = 0.8 + Math.random() * 1.4;
      dummy.scale.set(s, s * (0.8 + Math.random() * 0.6), s);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  })();

  // ---------------------------------------------------------------------
  // TRACK GENERATION
  // ---------------------------------------------------------------------
  const TRACK = {
    width: 15,
    curbWidth: 1.4,
    controlPoints: [
      new THREE.Vector3(0, 0, -110),
      new THREE.Vector3(95, 0, -128),
      new THREE.Vector3(150, 0, -55),
      new THREE.Vector3(145, 0, 35),
      new THREE.Vector3(75, 0, 70),
      new THREE.Vector3(55, 0, 20),
      new THREE.Vector3(0, 0, 40),
      new THREE.Vector3(-55, 0, 20),
      new THREE.Vector3(-75, 0, 78),
      new THREE.Vector3(-150, 0, 40),
      new THREE.Vector3(-155, 0, -55),
      new THREE.Vector3(-90, 0, -128),
    ],
  };

  const curve = new THREE.CatmullRomCurve3(TRACK.controlPoints, true, 'catmullrom', 0.5);
  const SAMPLES = 500;
  const trackPoints = curve.getPoints(SAMPLES);
  const trackTangents = [];
  const trackNormals = [];

  for (let i = 0; i < trackPoints.length; i++) {
    const p0 = trackPoints[(i - 1 + trackPoints.length) % trackPoints.length];
    const p1 = trackPoints[(i + 1) % trackPoints.length];
    const tangent = new THREE.Vector3().subVectors(p1, p0).normalize();
    trackTangents.push(tangent);
    // normal = tangent rotated 90deg around Y (world up)
    const normal = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
    trackNormals.push(normal);
  }

  // cumulative arc length for progress / lap tracking
  const trackCumLen = [0];
  for (let i = 1; i <= trackPoints.length; i++) {
    const a = trackPoints[i - 1];
    const b = trackPoints[i % trackPoints.length];
    trackCumLen.push(trackCumLen[i - 1] + a.distanceTo(b));
  }
  state.trackLength = trackCumLen[trackPoints.length];

  function buildRibbon(halfWidthFn, colorFn, yOffset, receiveShadow) {
    const positions = [];
    const colors = [];
    const normalsArr = [];
    const n = trackPoints.length;
    for (let i = 0; i < n; i++) {
      const p = trackPoints[i];
      const normal = trackNormals[i];
      const hw = halfWidthFn(i);
      const left = new THREE.Vector3().copy(p).addScaledVector(normal, hw.left).setY(yOffset);
      const right = new THREE.Vector3().copy(p).addScaledVector(normal, -hw.right).setY(yOffset);
      const pNext = trackPoints[(i + 1) % n];
      const normalNext = trackNormals[(i + 1) % n];
      const hwNext = halfWidthFn((i + 1) % n);
      const leftNext = new THREE.Vector3().copy(pNext).addScaledVector(normalNext, hwNext.left).setY(yOffset);
      const rightNext = new THREE.Vector3().copy(pNext).addScaledVector(normalNext, -hwNext.right).setY(yOffset);

      const c1 = colorFn(i);
      const c2 = colorFn((i + 1) % n);

      // two triangles: left, right, rightNext  &  left, rightNext, leftNext
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z, rightNext.x, rightNext.y, rightNext.z);
      positions.push(left.x, left.y, left.z, rightNext.x, rightNext.y, rightNext.z, leftNext.x, leftNext.y, leftNext.z);
      for (let k = 0; k < 6; k++) normalsArr.push(0, 1, 0);
      colors.push(c1.r, c1.g, c1.b, c1.r, c1.g, c1.b, c2.r, c2.g, c2.b);
      colors.push(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b, c2.r, c2.g, c2.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normalsArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !!receiveShadow;
    return mesh;
  }

  const asphaltColor = new THREE.Color(0x2a2d33);
  const asphaltColor2 = new THREE.Color(0x24262b);
  const roadMesh = buildRibbon(
    () => ({ left: TRACK.width / 2, right: TRACK.width / 2 }),
    (i) => (i % 2 === 0 ? asphaltColor : asphaltColor2),
    0.01,
    true
  );
  scene.add(roadMesh);

  // Candy-stripe curbs (outer edge on both sides)
  const stripeRed = new THREE.Color(0xcc2222);
  const stripeWhite = new THREE.Color(0xe9e9e9);
  const STRIPE_LEN = 6; // samples per color band
  const curbOuter = buildRibbon(
    () => ({ left: TRACK.width / 2 + TRACK.curbWidth, right: -(TRACK.width / 2) }),
    (i) => (Math.floor(i / STRIPE_LEN) % 2 === 0 ? stripeRed : stripeWhite),
    0.015
  );
  const curbInner = buildRibbon(
    () => ({ left: -(TRACK.width / 2), right: TRACK.width / 2 + TRACK.curbWidth }),
    (i) => (Math.floor(i / STRIPE_LEN) % 2 === 0 ? stripeWhite : stripeRed),
    0.015
  );
  scene.add(curbOuter, curbInner);

  // Center dashed line via InstancedMesh
  (function buildDashes() {
    const dashGeo = new THREE.BoxGeometry(0.35, 0.02, 2.2);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xf4d35e, emissive: 0x3a2c00, roughness: 0.5 });
    const step = 5;
    const count = Math.floor(trackPoints.length / step);
    const inst = new THREE.InstancedMesh(dashGeo, dashMat, count);
    const dummy = new THREE.Object3D();
    for (let idx = 0; idx < count; idx++) {
      const i = idx * step;
      const p = trackPoints[i];
      const t = trackTangents[i];
      dummy.position.set(p.x, 0.03, p.z);
      dummy.rotation.y = Math.atan2(t.x, t.z);
      dummy.updateMatrix();
      inst.setMatrixAt(idx, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  })();

  // ---------------------------------------------------------------------
  // STREET LIGHTING SYSTEM
  // Instanced geometry for poles / arms / heads (cheap to render),
  // combined with a small POOL of real THREE.PointLights that get
  // repositioned each frame to the nearest lamp posts (cheap to light).
  // ---------------------------------------------------------------------
  const lampPositions = []; // { base, headPos, side }
  const LAMP_STEP = 9;
  const LAMP_SPACING_OFFSET = TRACK.width / 2 + TRACK.curbWidth + 2.4;
  const ARM_LEN = 3.2;
  const POLE_HEIGHT = 8.5;

  for (let i = 0; i < trackPoints.length; i += LAMP_STEP) {
    const side = (Math.floor(i / LAMP_STEP) % 2 === 0) ? 1 : -1;
    const p = trackPoints[i];
    const normal = trackNormals[i];
    const base = new THREE.Vector3().copy(p).addScaledVector(normal, side * LAMP_SPACING_OFFSET);
    const armDir = normal.clone().multiplyScalar(-side); // points back toward road
    const headPos = base.clone().addScaledVector(armDir, ARM_LEN).setY(POLE_HEIGHT);
    const yaw = Math.atan2(armDir.x, armDir.z);
    lampPositions.push({ base, headPos, yaw, side });
  }

  const poleGeo = new THREE.CylinderGeometry(0.14, 0.18, POLE_HEIGHT, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 0.6, metalness: 0.4 });
  const poleInst = new THREE.InstancedMesh(poleGeo, poleMat, lampPositions.length);
  poleInst.castShadow = true;

  const armGeo = new THREE.CylinderGeometry(0.08, 0.08, ARM_LEN, 6);
  const armInst = new THREE.InstancedMesh(armGeo, poleMat, lampPositions.length);

  const headGeo = new THREE.SphereGeometry(0.45, 12, 10);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff2c9,
    emissive: 0xffce6b,
    emissiveIntensity: 2.2,
    roughness: 0.3,
  });
  const headInst = new THREE.InstancedMesh(headGeo, headMat, lampPositions.length);

  // A soft glow sprite under/around each lamp head to sell the light pool on the road
  const glowTex = (function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,214,140,0.55)');
    g.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

  const dummy = new THREE.Object3D();
  const upQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));

  lampPositions.forEach((lamp, idx) => {
    // pole
    dummy.position.set(lamp.base.x, POLE_HEIGHT / 2, lamp.base.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poleInst.setMatrixAt(idx, dummy.matrix);

    // arm: horizontal cylinder from pole top toward road
    const armMid = new THREE.Vector3(lamp.base.x, POLE_HEIGHT, lamp.base.z).lerp(
      new THREE.Vector3(lamp.headPos.x, POLE_HEIGHT, lamp.headPos.z), 0.5
    );
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, lamp.yaw, 0)).multiply(upQuat);
    dummy.position.copy(armMid);
    dummy.quaternion.copy(q);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    armInst.setMatrixAt(idx, dummy.matrix);

    // head
    dummy.position.copy(lamp.headPos);
    dummy.quaternion.identity();
    dummy.updateMatrix();
    headInst.setMatrixAt(idx, dummy.matrix);

    const glow = new THREE.Sprite(glowMat);
    glow.position.set(lamp.headPos.x, 0.05, lamp.headPos.z);
    glow.scale.set(11, 11, 1);
    glow.rotation.x = -Math.PI / 2;
    scene.add(glow);
  });
  poleInst.instanceMatrix.needsUpdate = true;
  armInst.instanceMatrix.needsUpdate = true;
  headInst.instanceMatrix.needsUpdate = true;
  scene.add(poleInst, armInst, headInst);

  // Dynamic light pool: only a handful of real lights exist; they get
  // teleported to whichever lamp posts are nearest the car each frame.
  const LIGHT_POOL_SIZE = 10;
  const lightPool = [];
  for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
    const pl = new THREE.PointLight(0xffc66d, 9.5, 34, 1.8);
    pl.position.set(0, POLE_HEIGHT, 0);
    scene.add(pl);
    lightPool.push(pl);
  }

  function updateLightPool(carPos) {
    // find nearest lamp indices cheaply using a coarse spatial pass
    const dists = [];
    for (let i = 0; i < lampPositions.length; i++) {
      const d = lampPositions[i].headPos.distanceToSquared(carPos);
      if (d < 3600) dists.push({ i, d }); // only consider within 60 units
    }
    dists.sort((a, b) => a.d - b.d);
    for (let k = 0; k < LIGHT_POOL_SIZE; k++) {
      if (k < dists.length) {
        const lamp = lampPositions[dists[k].i];
        lightPool[k].position.copy(lamp.headPos);
        lightPool[k].intensity = 9.5;
      } else {
        lightPool[k].intensity = 0;
      }
    }
  }

  // ---------------------------------------------------------------------
  // CITY / TRAFFIC / NEON SCENERY
  // ---------------------------------------------------------------------
  const trafficCars = [];
  const trafficColors = [0x18a8ff, 0xff3b30, 0xffc928, 0x8d5cff, 0x24e06f, 0xffffff];
  function makeTrafficCar(color) {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({color, roughness:0.24, metalness:0.72});
    const dark = new THREE.MeshStandardMaterial({color:0x101318, roughness:0.32, metalness:0.45});
    const glass = new THREE.MeshStandardMaterial({color:0x162a3d, roughness:0.08, metalness:0.65, transparent:true, opacity:0.88});
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.85,0.48,3.85), paint);
    body.position.y=.52; body.castShadow=true; g.add(body);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.72,.18,.85), paint);
    hood.position.set(0,.72,1.52); g.add(hood);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.48,.55,1.72), glass);
    roof.position.set(0,.94,-.15); roof.castShadow=true; g.add(roof);
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.75,.25,.28), dark);
    bumper.position.set(0,.43,-1.98); g.add(bumper);
    const wg = new THREE.CylinderGeometry(.39,.39,.28,14);
    [-.94,.94].forEach(x=>[-1.22,1.22].forEach(z=>{
      const w=new THREE.Mesh(wg,dark); w.rotation.z=Math.PI/2; w.position.set(x,.4,z); w.castShadow=true; g.add(w);
    }));
    const lampMat=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xffffff,emissiveIntensity:5});
    [-.62,.62].forEach(x=>{const l=new THREE.Mesh(new THREE.BoxGeometry(.24,.12,.08),lampMat);l.position.set(x,.61,1.96);g.add(l);});
    return g;
  }
  function buildTraffic() {
    // Cars use the same closed spline, so they stay on the road and cost very little.
    for (let i=0;i<9;i++) {
      const mesh=makeTrafficCar(trafficColors[i%trafficColors.length]);
      scene.add(mesh);
      trafficCars.push({mesh, progress:(0.07+i*0.095)%1, speed:12+Math.random()*9, lane:(i%3-1)*2.4, wobble:Math.random()*Math.PI*2});
    }
  }
  function updateTraffic(dt) {
    for (const v of trafficCars) {
      v.progress=(v.progress + (v.speed*dt/state.trackLength))%1;
      const u=v.progress;
      const idx=Math.floor(u*(trackPoints.length-1));
      const p=curve.getPointAt(u);
      const t=curve.getTangentAt(u).normalize();
      const n=new THREE.Vector3(t.z,0,-t.x);
      p.addScaledVector(n, v.lane);
      v.mesh.position.copy(p); v.mesh.position.y=.02;
      v.mesh.rotation.y=Math.atan2(t.x,t.z);
      v.mesh.position.y += Math.sin(performance.now()*.003+v.wobble)*.012;
    }
  }
  buildTraffic();

  // Neon city blocks and glowing roadside signs add depth without expensive models.
  const buildingMats=[0x17233b,0x20283d,0x111a2d,0x2a1b3b];
  const windowMat=new THREE.MeshStandardMaterial({color:0xffd36a,emissive:0xff9d32,emissiveIntensity:1.4});
  for(let i=0;i<65;i++){
    const side=i%2?1:-1, idx=(i*7)%trackPoints.length, p=trackPoints[idx], n=trackNormals[idx];
    const b=new THREE.Mesh(new THREE.BoxGeometry(7+Math.random()*9,9+Math.random()*24,7+Math.random()*9),
      new THREE.MeshStandardMaterial({color:buildingMats[i%buildingMats.length],roughness:.9,metalness:.05}));
    const offset=25+Math.random()*45;
    b.position.copy(p).addScaledVector(n,side*offset); b.position.y=b.geometry.parameters.height/2;
    b.rotation.y=Math.random()*.4; b.castShadow=true; scene.add(b);
    if(i<42){
      const win=new THREE.Mesh(new THREE.PlaneGeometry(2.2,1.1),windowMat);
      win.position.set(b.position.x, b.position.y+2+Math.random()*5, b.position.z);
      win.rotation.y=b.rotation.y+(side>0?Math.PI:0); scene.add(win);
    }
  }

  // ---------------------------------------------------------------------
  // CAR MODEL
  // ---------------------------------------------------------------------
  const carGroup = new THREE.Group();
  scene.add(carGroup);

  const carFill = new THREE.PointLight(0x4e8dff, 2.2, 14, 2);
  carFill.position.set(0, 2.2, -0.5);
  carGroup.add(carFill);

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf12d48, roughness: 0.28, metalness: 0.52 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x252832, roughness: 0.34, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x203a58, roughness: 0.08, metalness: 0.55, transparent: true, opacity: 0.78 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 4.2), bodyMat);
  chassis.position.y = 0.55;
  chassis.castShadow = true;
  carGroup.add(chassis);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.1), glassMat);
  cabin.position.set(0, 1.02, -0.15);
  cabin.castShadow = true;
  carGroup.add(cabin);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.4, 0.9), darkMat);
  nose.position.set(0, 0.42, 2.35);
  carGroup.add(nose);

  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.35), darkMat);
  spoiler.position.set(0, 1.05, -2.05);
  carGroup.add(spoiler);

  // More realistic body shaping: fenders, side skirts, mirrors and diffuser.
  const fenderGeo = new THREE.BoxGeometry(0.28,0.25,1.65);
  [-0.98,0.98].forEach(x=>{
    const f=new THREE.Mesh(fenderGeo,bodyMat); f.position.set(x,.55,.15); f.castShadow=true; carGroup.add(f);
    const mirror=new THREE.Mesh(new THREE.BoxGeometry(.18,.13,.32),darkMat);
    mirror.position.set(x*1.02,1.02,.55); mirror.castShadow=true; carGroup.add(mirror);
  });
  const diffuser=new THREE.Mesh(new THREE.BoxGeometry(1.65,.22,.35),darkMat);
  diffuser.position.set(0,.38,-2.12); carGroup.add(diffuser);
  // subtle underglow
  const underGlowMat=new THREE.MeshBasicMaterial({color:0x00d9ff,transparent:true,opacity:.72,side:THREE.DoubleSide});
  const underGlow=new THREE.Mesh(new THREE.PlaneGeometry(2.0,3.5),underGlowMat);
  underGlow.rotation.x=-Math.PI/2; underGlow.position.y=.12; carGroup.add(underGlow);

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 16);
  const wheelPositions = [
    { x: -1.02, z: 1.35, steer: true },
    { x: 1.02, z: 1.35, steer: true },
    { x: -1.02, z: -1.35, steer: false },
    { x: 1.02, z: -1.35, steer: false },
  ];
  const wheels = wheelPositions.map((wp) => {
    const pivot = new THREE.Group();
    pivot.position.set(wp.x, 0.42, wp.z);
    const mesh = new THREE.Mesh(wheelGeo, wheelMat);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    pivot.add(mesh);
    carGroup.add(pivot);
    return { pivot, mesh, steer: wp.steer };
  });

  // headlights (visual + real SpotLights)
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 });
  [-0.7, 0.7].forEach((x) => {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), headlightMat);
    hl.position.set(x, 0.55, 2.1);
    carGroup.add(hl);

    const spot = new THREE.SpotLight(0xffffff, 9, 42, Math.PI / 7, 0.5, 1.2);
    spot.position.set(x, 0.6, 2.2);
    const target = new THREE.Object3D();
    target.position.set(x * 0.5, 0.1, 20);
    carGroup.add(target);
    spot.target = target;
    carGroup.add(spot);
  });

  // taillights (brighten under braking)
  const taillightMat = new THREE.MeshStandardMaterial({ color: 0x5c0000, emissive: 0xff0000, emissiveIntensity: 0.4 });
  const taillights = [-0.75, 0.75].map((x) => {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.08), taillightMat.clone());
    tl.position.set(x, 0.58, -2.12);
    carGroup.add(tl);
    return tl;
  });

  // First-person camera anchor (driver eye point)
  const fpAnchor = new THREE.Object3D();
  fpAnchor.position.set(0.32, 1.05, 0.55);
  carGroup.add(fpAnchor);

  // Reset car to start line
  function resetCar() {
    const p = trackPoints[0];
    const t = trackTangents[0];
    car.position.set(p.x, 0, p.z);
    car.heading = Math.atan2(t.x, t.z);
    car.speed = 0;
    car.steer = 0;
    state.lastProgressIndex = 0;
    state.progressCrossed = false;
    state.raceFinished = false;
    state.lapCount = 1;
    camera.userData.lookTarget = null;
  }
  resetCar();

  // ---------------------------------------------------------------------
  // AUDIO (procedural engine note, no external files)
  // ---------------------------------------------------------------------
  let audioCtx, engineOsc, engineGain, engineFilter;
  function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0.0;
    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 800;
    engineOsc.connect(engineFilter).connect(engineGain).connect(audioCtx.destination);
    engineOsc.frequency.value = 60;
    engineOsc.start();
  }
  function updateEngineAudio(speedAbs, throttle) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const targetFreq = 55 + speedAbs * 5.2 + throttle * 30;
    engineOsc.frequency.setTargetAtTime(targetFreq, t, 0.05);
    engineFilter.frequency.setTargetAtTime(400 + speedAbs * 40, t, 0.08);
    const targetGain = 0.05 + Math.min(speedAbs / PHYS.maxSpeed, 1) * 0.09 + throttle * 0.03;
    engineGain.gain.setTargetAtTime(state.started ? targetGain : 0, t, 0.1);
  }

  // ---------------------------------------------------------------------
  // INPUT
  // ---------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const blocked = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'];
    if (blocked.includes(e.code)) e.preventDefault();
    state.keys[e.code] = true;
    if (e.code === 'KeyC') toggleCamera();
    if (e.code === 'KeyR') resetCar();
  }, { passive: false });
  window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });

  function bindTouch(el, onDown, onUp) {
    const down = (e) => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); onDown(); };
    const up = (e) => { e.preventDefault(); onUp(); };
    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointerup', up, { passive: false });
    el.addEventListener('pointercancel', up, { passive: false });
    el.addEventListener('pointerleave', up, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  bindTouch(dom.btnLeft, () => state.touch.left = true, () => state.touch.left = false);
  bindTouch(dom.btnRight, () => state.touch.right = true, () => state.touch.right = false);
  bindTouch(dom.btnGas, () => state.touch.gas = true, () => state.touch.gas = false);
  bindTouch(dom.btnBrake, () => state.touch.brake = true, () => state.touch.brake = false);

  if ('ontouchstart' in window) dom.touchControls.classList.remove('hidden');

  function toggleCamera() {
    state.cameraMode = state.cameraMode === 'third' ? 'first' : 'third';
    dom.camLabel.textContent = state.cameraMode === 'third' ? '3RD PERSON' : '1ST PERSON';
  }
  dom.camBtn.addEventListener('click', toggleCamera);

  // ---------------------------------------------------------------------
  // PHYSICS / TRACK FOLLOWING
  // ---------------------------------------------------------------------
  function nearestTrackIndex(pos, hintIndex) {
    // search a window around the hint for performance (car can't teleport)
    const n = trackPoints.length;
    const windowSize = 40;
    let best = hintIndex;
    let bestDist = Infinity;
    for (let off = -windowSize; off <= windowSize; off++) {
      const idx = ((hintIndex + off) % n + n) % n;
      const d = trackPoints[idx].distanceToSquared(pos);
      if (d < bestDist) { bestDist = d; best = idx; }
    }
    return { index: best, distSq: bestDist };
  }

  function updatePhysics(dt) {
    const throttleKey = state.keys['KeyW'] || state.keys['ArrowUp'] || state.touch.gas;
    const brakeKey = state.keys['KeyS'] || state.keys['ArrowDown'] || state.touch.brake;
    const leftKey = state.keys['KeyA'] || state.keys['ArrowLeft'] || state.touch.left;
    const rightKey = state.keys['KeyD'] || state.keys['ArrowRight'] || state.touch.right;
    const handbrake = state.keys['Space'];

    // steering
    let steerInput = 0;
    if (leftKey) steerInput -= 1;
    if (rightKey) steerInput += 1;
    const targetSteer = steerInput * PHYS.maxSteer;
    if (targetSteer !== car.steer) {
      const rate = (steerInput !== 0) ? PHYS.steerSpeed : PHYS.steerReturn;
      car.steer += Math.sign(targetSteer - car.steer) * rate * dt;
      if (Math.abs(car.steer - targetSteer) < rate * dt) car.steer = targetSteer;
    }

    // throttle / brake
    const speedFactor = 1 - Math.min(Math.abs(car.speed) / PHYS.maxSpeed, 1) * 0.35;
    const maxSpeedNow = car.onTrack ? PHYS.maxSpeed : PHYS.maxSpeed * PHYS.offTrackMaxSpeedFactor;

    if (throttleKey && !handbrake) {
      car.speed += PHYS.accel * speedFactor * dt;
    } else if (brakeKey && !handbrake) {
      if (car.speed > 0.5) car.speed -= PHYS.brakeForce * dt;
      else car.speed -= PHYS.reverseAccel * dt;
    } else {
      // passive rolling resistance toward 0
      const resist = PHYS.rollingResist * dt * (car.onTrack ? 1 : PHYS.offTrackDrag * 2);
      if (car.speed > 0) car.speed = Math.max(0, car.speed - resist);
      else if (car.speed < 0) car.speed = Math.min(0, car.speed + resist);
    }

    if (handbrake) {
      const hb = 30 * dt;
      if (car.speed > 0) car.speed = Math.max(0, car.speed - hb);
      else car.speed = Math.min(0, car.speed + hb);
    }

    car.speed = THREE.MathUtils.clamp(car.speed, PHYS.maxReverse, maxSpeedNow);

    // heading changes proportional to speed & steer (bicycle-ish model)
    const speedForTurn = THREE.MathUtils.clamp(car.speed / PHYS.maxSpeed, -1, 1);
    car.heading += car.steer * speedForTurn * PHYS.grip * dt;

    // integrate position
    const dir = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    car.position.addScaledVector(dir, car.speed * dt);

    // track following: find nearest sample & lateral distance
    const previousProgressIndex = state.lastProgressIndex;
    const { index, distSq } = nearestTrackIndex(car.position, state.lastProgressIndex);
    state.lastProgressIndex = index;
    const dist = Math.sqrt(distSq);
    const halfW = TRACK.width / 2 + TRACK.curbWidth + 1.5;
    car.onTrack = dist < halfW;

    // gentle guardrail: hard stop drifting infinitely far away
    if (dist > halfW + 12) {
      const normal = trackNormals[index];
      const toCenter = new THREE.Vector3().subVectors(trackPoints[index], car.position).normalize();
      car.position.addScaledVector(toCenter, (dist - (halfW + 12)) * 0.5);
      car.speed *= 0.9;
    }

    // wrong-way detection: compare heading to track tangent direction
    const tangent = trackTangents[index];
    const tangentYaw = Math.atan2(tangent.x, tangent.z);
    let diff = car.heading - tangentYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    car.wrongWay = Math.abs(diff) > Math.PI * 0.6 && Math.abs(car.speed) > 3;

    // wheel spin visual
    car.wheelSpin += car.speed * dt * 1.6;

    // lap detection: crossing sample index 0 while moving forward-ish
    const n = trackPoints.length;
    const prevIdx = previousProgressIndex;
    if (!state.raceFinished) {
      if (prevIdx > n * 0.85 && index < n * 0.65) state.progressCrossed = true;
      if (state.progressCrossed && index < n * 0.08 && !car.wrongWay) {
        state.progressCrossed = false;
        state.lapCount++;
        if (state.lapCount > state.totalLaps) {
          state.raceFinished = true;
        }
      }
    }

    updateCarVisual(dt, throttleKey, brakeKey);
  }

  function updateCarVisual(dt, throttleKey, brakeKey) {
    carGroup.position.copy(car.position);
    carGroup.rotation.y = car.heading;

    wheels.forEach((w) => {
      w.mesh.rotation.x = car.wheelSpin;
      if (w.steer) w.pivot.rotation.y = car.steer;
    });

    taillights.forEach((tl) => {
      tl.material.emissiveIntensity = brakeKey ? 2.4 : 0.4;
    });

    updateEngineAudio(Math.abs(car.speed), throttleKey ? 1 : 0);
  }

  // ---------------------------------------------------------------------
  // CAMERA RIG
  // ---------------------------------------------------------------------
  const camTargetPos = new THREE.Vector3();
  const camTargetLook = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();

  function updateCamera(dt) {
    const dir = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));

    if (state.cameraMode === 'third') {
      const back = dir.clone().multiplyScalar(-9.5);
      const height = 4.4 + Math.min(Math.abs(car.speed) * 0.02, 1.2);
      camTargetPos.copy(car.position).add(back).setY(height);
      camTargetLook.copy(car.position).addScaledVector(dir, 6).setY(1.1);
      const lerpFactor = 1 - Math.pow(0.0035, dt);
      camera.position.lerp(camTargetPos, lerpFactor);
      tmpLook.copy(camera.userData.lookTarget || camTargetLook).lerp(camTargetLook, lerpFactor);
      camera.userData.lookTarget = tmpLook.clone();
      camera.lookAt(tmpLook);
      camera.fov = THREE.MathUtils.lerp(camera.fov, 62 + Math.min(Math.abs(car.speed) * 0.25, 10), 0.05);
      camera.updateProjectionMatrix();
    } else {
      // first person: snap to driver eye anchor, smooth only the look direction slightly
      const worldPos = new THREE.Vector3();
      fpAnchor.getWorldPosition(worldPos);
      camera.position.lerp(worldPos, 1 - Math.pow(0.0001, dt));
      camTargetLook.copy(car.position).addScaledVector(dir, 20).setY(worldPos.y - 0.15);
      tmpLook.copy(camera.userData.lookTarget || camTargetLook).lerp(camTargetLook, 1 - Math.pow(0.002, dt));
      camera.userData.lookTarget = tmpLook.clone();
      camera.lookAt(tmpLook);
      camera.fov = THREE.MathUtils.lerp(camera.fov, 72 + Math.min(Math.abs(car.speed) * 0.2, 12), 0.06);
      camera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------
  const GAUGE_MAX_KMH = 200;
  const GAUGE_CIRCUMFERENCE = 157;

  function updateHUD() {
    const kmh = Math.round(Math.abs(car.speed) * 3.6);
    dom.speedValue.textContent = kmh;
    const pct = Math.min(kmh / GAUGE_MAX_KMH, 1);
    dom.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - pct));
    dom.gaugeFill.style.stroke = pct > 0.85 ? '#ff2fd0' : (pct > 0.55 ? '#ffb03b' : '#00f0ff');

    dom.lapCount.innerHTML = `${Math.min(state.lapCount, state.totalLaps)}<span class="lap-total">/${state.totalLaps}</span>`;

    if (state.started && !state.raceFinished) {
      const elapsed = (performance.now() - state.raceStartTime) / 1000;
      const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toFixed(2).padStart(5, '0');
      dom.timer.textContent = `${m}:${s}`;
    }
    if (state.raceFinished) {
      dom.timer.textContent = 'FINISHED!';
    }

    dom.offtrackWarn.classList.toggle('hidden', car.onTrack);
    dom.wrongwayWarn.classList.toggle('hidden', !car.wrongWay || !car.onTrack);

    drawMinimap();
  }

  function drawMinimap() {
    const w = dom.minimap.width, h = dom.minimap.height;
    mmCtx.clearRect(0, 0, w, h);
    mmCtx.save();
    mmCtx.translate(w / 2, h / 2);
    const scale = 0.34;

    mmCtx.beginPath();
    trackPoints.forEach((p, i) => {
      const x = p.x * scale, y = p.z * scale;
      if (i === 0) mmCtx.moveTo(x, y); else mmCtx.lineTo(x, y);
    });
    mmCtx.closePath();
    mmCtx.strokeStyle = 'rgba(0,240,255,0.7)';
    mmCtx.lineWidth = 3;
    mmCtx.stroke();

    // car marker (rotated triangle), map is car-centered would be nicer,
    // but a fixed track view with moving dot keeps it simple & readable
    const cx = car.position.x * scale, cy = car.position.z * scale;
    mmCtx.translate(cx, cy);
    mmCtx.rotate(car.heading);
    mmCtx.fillStyle = '#ff2fd0';
    mmCtx.beginPath();
    mmCtx.moveTo(0, -6);
    mmCtx.lineTo(4, 5);
    mmCtx.lineTo(-4, 5);
    mmCtx.closePath();
    mmCtx.fill();
    mmCtx.restore();
  }

  // ---------------------------------------------------------------------
  // MAIN LOOP
  // ---------------------------------------------------------------------
  const MAX_DT = 1 / 20;
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(state.clock.getDelta(), MAX_DT);

    if (state.started) {
      updatePhysics(dt);
      updateTraffic(dt);
      updateLightPool(car.position);
      updateCamera(dt);
      updateHUD();
    }

    renderer.render(scene, camera);
  }

  // ---------------------------------------------------------------------
  // BOOTSTRAP
  // ---------------------------------------------------------------------
  window.addEventListener('load', () => {
    dom.loading.classList.add('hidden');
  });

  dom.startBtn.addEventListener('click', () => {
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    gsap.to(dom.startScreen, {
      opacity: 0, duration: 0.5, onComplete: () => {
        dom.startScreen.classList.add('hidden');
      }
    });
    dom.hud.classList.remove('hidden');
    state.started = true;
    state.raceStartTime = performance.now();
    resetCar();
  });

  // Kick off render loop immediately so the start screen has a live
  // background (camera slowly orbiting the parked car).
  let introAngle = 0;
  const originalAnimate = animate;
  (function introLoop() {
    if (state.started) return;
    introAngle += 0.0025;
    camera.position.set(Math.sin(introAngle) * 18, 7, Math.cos(introAngle) * 18);
    camera.lookAt(0, 1, 0);
    renderer.render(scene, camera);
    requestAnimationFrame(introLoop);
  })();

  requestAnimationFrame(animate);
})();

