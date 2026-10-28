import * as THREE from "../vendor/three.module.js";

/* ------------------------------------------------------------------------- *
 * Pig Got Rhythm — web port of the "swinka" skin from Clock Simulator.
 *
 * Geometry, skeleton, animation clips and sounds are extracted from the game
 * (see ../_port_tools/extract_assets.py). Gameplay constants come from the
 * decompiled scripts:
 *   MainClock.cs         -> beat error = 1 - secondsSinceLastClick
 *   Clock4.cs            -> hand rotates 1 rev/s, tap = jump, 0.2s jump gate
 *   PlayerCollision.cs   -> the hand hitting the pig ends the run
 *   Skin4GameManager.cs  -> score is seconds survived, errorMultiplier 10/50
 * ------------------------------------------------------------------------- */

const TWO_PI = Math.PI * 2;
const REV_PER_SEC = 1;          // rotateIndicator.anim: 6 deg / frame @ 60fps
// Unity is left-handed, WebGL right-handed: the scene is mirrored on Z. That
// reverses the apparent sweep, so the hand turns the other way on screen.
const SPIN_SIGN = -1;
const JUMP_PAUSE = 0.5;         // no jump again for 500 ms after one starts:
                                // the 0.303 s playerJump clip plus the fade back
                                // to idle (Clock4 waits for isGrounded +
                                // jumpTimeOffset 0.2 s, ~= the same half second)
const JUMP_TIMESCALE = 1.1;     // playerJump state speed
const RETRY_COOLDOWN = 1000;    // ms the end window ignores restarts
const HAND_ANGLE0 = 0;          // Indicator starts at identity rotation

const GRADIENTS = [
  ["#00caff", "#003b58"],
  ["#20b4c3", "#003b58"],
];
const OVER_FADE_MS = 220;       // .screen opacity transition, see style.css
const MENU_GRADIENT = ["#1c1c53", "#20b4c3"];
const GRADIENT_HOLD = 4;
const GRADIENT_FADE = 1;

const el = (id) => document.getElementById(id);

// CustomGameManager.CurrentScore style: mm:ss
const clockFormat = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const ui = {
  hud: el("hud"),
  score: el("score"),
  menu: el("menu"),
  menuBest: el("menuBest"),
  over: el("over"),
  finalScore: el("finalScore"),
  overBest: el("overBest"),
  trophy: el("trophy"),
  hint: el("tapHint"),
  bg: el("bg"),
  mute: el("mute"),
};

/* --------------------------------------------------------------- utilities */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function mixRgb(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}
const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/* ------------------------------------------------------------------- audio */
const Sound = (() => {
  let ctx = null;
  let master = null;
  let muted = false;
  const buffers = {};
  let ambientSource = null;
  let oinkIndex = 0;
  let pitch = 1;
  let pitchOffset = 0.2;

  const FILES = {
    oinkA: "assets/audio/swinia2.mp3",
    oinkB: "assets/audio/swinia3.mp3",
    ambient: "assets/audio/Kitchen clock ticking.mp3",
    over: "assets/audio/gameEnded.mp3",
    best: "assets/audio/highScore.mp3",
    click: "assets/audio/buttonClick.wav",
  };

  async function init() {
    if (ctx) {
      if (ctx.state === "suspended") await ctx.resume();
      return;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") await ctx.resume();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    await Promise.all(
      Object.entries(FILES).map(async ([k, url]) => {
        try {
          const res = await fetch(url);
          const buf = await res.arrayBuffer();
          buffers[k] = await ctx.decodeAudioData(buf);
        } catch (e) {
          console.warn("audio failed", url, e);
        }
      })
    );
  }

  function play(name, { volume = 1, rate = 1, loop = false } = {}) {
    if (!ctx || !buffers[name]) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate;
    src.loop = loop;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(master);
    src.start();
    return src;
  }

  return {
    get muted() { return muted; },
    init,
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.9;
      return muted;
    },
    tick() {
      // SoundEventManager.Tick(): alternating variation + pitch wobble
      const name = oinkIndex++ % 2 ? "oinkA" : "oinkB";
      play(name, { volume: 0.55, rate: pitch });
      pitchOffset *= -1;
      pitch += pitchOffset;
    },
    ambient(on) {
      if (!ctx) return;
      if (on && !ambientSource) {
        ambientSource = play("ambient", { volume: 0.16, loop: true });
      } else if (!on && ambientSource) {
        try { ambientSource.stop(); } catch (e) {}
        ambientSource = null;
      }
    },
    resetPitch() { pitch = 1; pitchOffset = 0.2; },
    over() { play("over", { volume: 0.85 }); },
    best() { play("best", { volume: 0.8 }); },
    click() { play("click", { volume: 0.5 }); },
  };
})();

/* ------------------------------------------------------------- background */
const Background = (() => {
  const top = hexToRgb(MENU_GRADIENT[0]);
  const bottom = hexToRgb(MENU_GRADIENT[1]);
  let from = [top.slice(), bottom.slice()];
  let to = [top.slice(), bottom.slice()];
  let t0 = 0;
  let duration = 0;
  let active = false;
  let timer = null;
  let index = 0;

  function apply(a, b) {
    ui.bg.style.background = `linear-gradient(to bottom, ${rgb(a)} 0%, ${rgb(b)} 100%)`;
  }

  function tween(nextTop, nextBottom, dur) {
    from = [top.slice(), bottom.slice()];
    to = [nextTop, nextBottom];
    t0 = performance.now();
    duration = dur;
  }

  return {
    setMenu() {
      active = false;
      clearInterval(timer);
      timer = null;
      tween(hexToRgb(MENU_GRADIENT[0]), hexToRgb(MENU_GRADIENT[1]), 600);
    },
    start() {
      active = true;
      index = 0;
      const g = GRADIENTS[0];
      tween(hexToRgb(g[0]), hexToRgb(g[1]), 700);
      clearInterval(timer);
      timer = setInterval(() => {
        if (!active) return;
        index = (index + 1) % GRADIENTS.length;
        const n = GRADIENTS[index];
        tween(hexToRgb(n[0]), hexToRgb(n[1]), GRADIENT_FADE * 1000);
      }, GRADIENT_HOLD * 1000);
    },
    stop() {
      active = false;
      clearInterval(timer);
      timer = null;
    },
    update(now) {
      if (!duration) return;
      const k = clamp((now - t0) / duration, 0, 1);
      const e = easeOut(k);
      top[0] = lerp(from[0][0], to[0][0], e);
      top[1] = lerp(from[0][1], to[0][1], e);
      top[2] = lerp(from[0][2], to[0][2], e);
      bottom[0] = lerp(from[1][0], to[1][0], e);
      bottom[1] = lerp(from[1][1], to[1][1], e);
      bottom[2] = lerp(from[1][2], to[1][2], e);
      apply(top, bottom);
      if (k >= 1) duration = 0;
    },
  };
})();

/* ------------------------------------------------------- oriented box test */
function setObbFromMatrix(obb, m, halfExtents) {
  m.decompose(obb.center, obb.quat, obb.scale);
  obb.axes[0].set(1, 0, 0).applyQuaternion(obb.quat);
  obb.axes[1].set(0, 1, 0).applyQuaternion(obb.quat);
  obb.axes[2].set(0, 0, 1).applyQuaternion(obb.quat);
  obb.half.set(
    halfExtents.x * Math.abs(obb.scale.x),
    halfExtents.y * Math.abs(obb.scale.y),
    halfExtents.z * Math.abs(obb.scale.z)
  );
}

function makeObb() {
  return {
    center: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1),
    axes: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    half: new THREE.Vector3(),
  };
}

const _absR = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const _tv = new THREE.Vector3();

function obbOverlap(a, b) {
  // separating axis test (Ericson, Real-Time Collision Detection 4.4.1)
  const R = _absR;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = Math.abs(a.axes[i].dot(b.axes[j])) + 1e-6;
    }
  }
  _tv.subVectors(b.center, a.center);

  const t = [_tv.dot(a.axes[0]), _tv.dot(a.axes[1]), _tv.dot(a.axes[2])];
  const A = [a.half.x, a.half.y, a.half.z];
  const B = [b.half.x, b.half.y, b.half.z];

  for (let i = 0; i < 3; i++) {
    const rb = B[0] * R[i][0] + B[1] * R[i][1] + B[2] * R[i][2];
    if (Math.abs(t[i]) > A[i] + rb) return false;
  }
  for (let j = 0; j < 3; j++) {
    const ra = A[0] * R[0][j] + A[1] * R[1][j] + A[2] * R[2][j];
    if (Math.abs(t[0] * R[0][j] + t[1] * R[1][j] + t[2] * R[2][j]) > ra + B[j]) return false;
  }
  // cross axes
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = A[i1] * R[i2][j] + A[i2] * R[i1][j];
      const rb = B[j1] * R[i][j2] + B[j2] * R[i][j1];
      const val = Math.abs(t[i2] * R[i1][j] - t[i1] * R[i2][j]);
      if (val > ra + rb) return false;
    }
  }
  return true;
}

/* ---------------------------------------------------------------- the game */
class Game {
  constructor(data) {
    this.model = data.model;
    this.sceneJson = data.scene;
    this.anims = data.anims;

    this.nodes = {};
    this.phase = "menu";
    this.best = Number(localStorage.getItem("pigRhythmBest") || 0);

    this.timeAfterLastClick = 0;
    this.firstClickDone = false;
    this.score = 0;
    this.secondAccum = 0;
    this.jumpLock = 0;
    this.inputLockedUntil = 0;
    this.jumping = false;
    this.handAngle = HAND_ANGLE0;
    this.spin = 0;
    this.currentError = 0;
    this.cumulativeError = 0;

    this.lastTime = performance.now();
    this.handObb = makeObb();
    this.pigObb = makeObb();
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._rotY = new THREE.Matrix4();

    this.initRenderer();
    this.buildScene();
    this.initAnimations();
    this.bindInput();
    this.resize();
    this.setPhase("menu");
    this.menuBestUpdate();
    this.loop();
  }

  /* ------------------------------------------------------------- renderer */
  initRenderer() {
    this.canvas = el("view");
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    // Unity project is in Gamma space with no tonemapping; keep three neutral so
    // the albedo values land where the originals do.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearAlpha(0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------------------------------------------------------------- scene */
  buildScene() {
    const loader = new THREE.TextureLoader();
    const pigTex = loader.load("assets/texturaPig2.png");
    pigTex.colorSpace = THREE.SRGBColorSpace;
    pigTex.flipY = false;
    pigTex.magFilter = THREE.NearestFilter;
    pigTex.minFilter = THREE.LinearMipmapLinearFilter;
    pigTex.anisotropy = 4;

    // Unity Standard shader parameters straight from the .mat assets:
    // glossiness -> roughness = 1 - _Glossiness, plus _Color / _EmissionColor.
    const std = (params) => new THREE.MeshStandardMaterial(params);
    this.materials = {
      pig: std({ map: pigTex, color: 0xffffff, metalness: 0, roughness: 1 - 0.5 }),
      eyes: std({ color: 0x000000, metalness: 0, roughness: 1 - 0.5 }),
      // The face renders flat white in the game: the Standard material's metal
      // reflection of the bright default sky saturates it out. Unlit keeps the
      // same pixels without dragging a grey sky reflection across the face.
      disc: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      hand: std({
        // _Color from indicator.mat is authored in gamma space like the rest of
        // the Unity project, so hand it over as sRGB rather than linear.
        color: new THREE.Color().setRGB(0, 0.8308824, 0.7965009, THREE.SRGBColorSpace),
        metalness: 0,
        roughness: 1 - 0.301,
      }),
    };

    // Stand-in for Unity's default skybox environment: lets the metal disc and
    // the standard lighting evaluate the way they do in the game.
    const sky = document.createElement("canvas");
    sky.width = 8;
    sky.height = 128;
    const sg = sky.getContext("2d");
    const grad = sg.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "#7d9dc4");
    grad.addColorStop(0.48, "#dcecf2");
    grad.addColorStop(0.5, "#f4faf9");
    grad.addColorStop(1, "#cbd9d6");
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 8, 128);
    const envTex = new THREE.CanvasTexture(sky);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromEquirectangular(envTex).texture;
    pmrem.dispose();
    envTex.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 2.36;

    const build = (json) => {
      const node = new THREE.Object3D();
      node.name = json.name;
      node.position.fromArray(json.position);
      node.quaternion.fromArray(json.quaternion);
      node.scale.fromArray(json.scale);
      node.userData.json = json;
      this.nodes[json.name] = node;
      for (const c of json.children) node.add(build(c));
      return node;
    };

    this.root = build(this.sceneJson.root);
    this.scene.add(this.root);

    // meshes
    const discNode = this.nodes.walec;
    discNode.add(
      new THREE.Mesh(this.geometry(this.model.disc), this.materials.disc)
    );
    discNode.children[0].receiveShadow = true;

    const cubeNode = this.nodes.Cube;
    cubeNode.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials.hand)
    );
    cubeNode.children[0].castShadow = true;
    cubeNode.children[0].receiveShadow = true;

    // skinned pig
    const pigNode = this.nodes.pig;
    const bones = this.sceneJson.skin.bones.map((n) => {
      const b = this.nodes[n];
      if (!b) throw new Error("missing bone " + n);
      b.userData.isBone = true;
      return b;
    });
    const ibm = this.sceneJson.skin.ibm.map((m) => new THREE.Matrix4().fromArray(m));
    const skeleton = new THREE.Skeleton(bones, ibm);

    const mesh = new THREE.SkinnedMesh(this.geometry(this.model.pig), [
      this.materials.pig,
      this.materials.eyes,
    ]);
    mesh.name = "pigMesh";
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    // the mesh hangs off the "pig" node with an identity local transform, so its
    // world matrix is the bind matrix Unity used
    pigNode.add(mesh);
    this.root.updateMatrixWorld(true);
    mesh.bind(skeleton, pigNode.matrixWorld);
    this.pigMesh = mesh;

    // camera + key light transforms straight from the scene
    this.camNode = this.nodes.Camera;
    this.camNode.updateWorldMatrix(true, false);
    this.camera.position.setFromMatrixPosition(this.camNode.matrixWorld);
    this.camera.quaternion.setFromRotationMatrix(this.camNode.matrixWorld);

    this.lightNode = this.nodes["Directional light"];
    this.lightNode.updateWorldMatrix(true, false);
    const lq = new THREE.Quaternion();
    const lp = new THREE.Vector3();
    const ls = new THREE.Vector3();
    this.lightNode.matrixWorld.decompose(lp, lq, ls);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(lq).normalize();
    // Unity intensity 1.49 in its own units; three's physical lights need a
    // little more to land the albedo on screen where the game puts it.
    this.sun = new THREE.DirectionalLight(0xffffff, 6.2);
    this.sun.position.copy(dir).multiplyScalar(-18);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -14; c.right = 14; c.top = 14; c.bottom = -14; c.near = 1; c.far = 60;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun, this.sun.target);



    // The author's rig sits ~8 deg off axis; square the pig up to the camera.
    this.pigAnim = this.nodes.pigAnimacja;
    this.squareUpPig();

    // collision proxies: the pig's BoxCollider and the hand's trigger BoxCollider
    this.pigAnim = this.nodes.pigAnimacja;
    this.indicator = this.nodes.Indicator;
    this.indicatorObj = this.nodes.IndicatorObject;
    this.pigHalf = new THREE.Vector3(1, 0.5, 0.5); // collider size (2,1,1)
    this.pigCenter = new THREE.Vector3(0, 0.5, 0.5); // center (0,0.5,-0.5), z mirrored
    this.handHalf = new THREE.Vector3(0.5, 0.5, 0.5); // collider size (1,1,1)
    this.indicatorBase = new THREE.Matrix4().compose(
      this.indicator.position.clone(),
      new THREE.Quaternion().fromArray(this.indicator.userData.json.quaternion),
      this.indicator.scale.clone()
    );
    this.indicatorObj.updateWorldMatrix(true, false);
    // Indicator base transform * Cube local transform == the hand's local chain
    this.handChain = new THREE.Matrix4().multiplyMatrices(
      this.indicatorBase,
      this.nodes.Cube.matrix
    );
  }

  squareUpPig() {
    const pigNode = this.nodes.pig;
    this.root.updateMatrixWorld(true);
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    pigNode.matrixWorld.decompose(p, q, s);
    // the mesh faces the camera when its world yaw is exactly PI. Rotating the
    // character root adds straight onto that world yaw.
    const yaw = new THREE.Euler().setFromQuaternion(q, "YXZ").y;
    this.nodes.playerObject.rotation.y += Math.PI - yaw;
    this.root.updateMatrixWorld(true);
  }

  geometry(d) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(d.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(d.normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(d.uvs, 2));
    if (d.skinIndex) {
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(d.skinIndex, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(d.skinWeight, 4));
    }
    g.setIndex(d.indices);
    for (const [start, count, mi] of d.groups) g.addGroup(start, count, mi);
    g.computeBoundingSphere();
    return g;
  }

  /* ----------------------------------------------------------- animations */
  initAnimations() {
    const mixerRoot = this.nodes.playerObject;
    this.mixer = new THREE.AnimationMixer(mixerRoot);

    const toClip = (data, name) => {
      const tracks = data.tracks.map((t) => {
        const node = t.path === "" ? "pigAnimacja" : "pigAnimacja/" + t.path;
        const prop =
          t.kind === "rotation" ? "quaternion" : t.kind === "position" ? "position" : "scale";
        const size = t.kind === "rotation" ? 4 : 3;
        return new THREE.KeyframeTrack(`${node}.${prop}`, t.times, t.values, undefined, size);
      });
      const clip = new THREE.AnimationClip(name, data.duration, tracks);
      return clip;
    };

    this.idle = this.mixer.clipAction(toClip(this.anims.Armature_stoi, "idle"));
    this.idle.setLoop(THREE.LoopRepeat, Infinity);
    this.idle.play();

    this.jump = this.mixer.clipAction(toClip(this.anims.playerJump, "jump"));
    this.jump.setLoop(THREE.LoopOnce, 1);
    this.jump.clampWhenFinished = true;
    this.jump.timeScale = JUMP_TIMESCALE;

    this.wiggle = this.mixer.clipAction(toClip(this.anims.Armature_skacze, "wiggle"));
    this.wiggle.setLoop(THREE.LoopOnce, 1);
    this.wiggle.clampWhenFinished = true;

    this.mixer.addEventListener("finished", (e) => {
      if (e.action === this.wiggle) {
        this.wiggle.fadeOut(0.16);
        this.idle.reset().fadeIn(0.16).play();
      }
      if (e.action === this.jump) this.jumping = false;
    });
  }

  /* ----------------------------------------------------------------- input */
  bindInput() {
    const tap = (ev) => {
      if (ev && ev.target && ev.target.closest && ev.target.closest(".screen.show")) return;
      if (ev && ev.target && ev.target.closest && ev.target.closest("button")) return;
      this.onTap();
    };
    // the ready window is one big button, like Button2 in the scene
    ui.menu.addEventListener("click", () => this.startRun());

    // overlay screens own their own clicks; the canvas + keyboard play the game
    window.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      tap(e);
    });
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.code === "Enter" || e.code === "ArrowUp") {
        e.preventDefault();
        // ReadyWindow's button is focused when it opens, and any tap on it
        // starts a run -- so space restarts straight from the menu and the
        // end window, the way the app does.
        if (this.phase === "menu" || this.phase === "over") this.startRun();
        else this.onTap();
      }
      if (e.code === "KeyM") {
        Sound.init().then(() => this.updateMuteUi(Sound.toggleMute()));
      }
    });

    el("againBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.startRun();
    });
    el("homeBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.goHome();
    });
    ui.mute.addEventListener("click", async (e) => {
      e.stopPropagation();
      await Sound.init();
      this.updateMuteUi(Sound.toggleMute());
    });
  }

  updateMuteUi(muted) {
    ui.mute.classList.toggle("off", muted);
  }

  /* ----------------------------------------------------------- game flow */
  startRun() {
    // a run only ever begins from the menu or the end window -- nothing (a
    // stale button, a stray click) may restart a run that's already going
    if (this.phase !== "menu" && this.phase !== "over") return;
    // dead-man's cooldown: a panicked tap/space right after dying would skip
    // the whole end window (EndWindow arms its restart button a beat late too)
    if (this.phase === "over" && performance.now() < this.retryAt) return;
    // the end window is still fading out -- it swallows input until it's gone
    if (this.phase === "over") this.inputLockedUntil = performance.now() + OVER_FADE_MS;
    Sound.init();
    Sound.click();
    this.resetRun();
    this.setPhase("armed");
    Background.start();
  }

  goHome() {
    Sound.click();
    Sound.ambient(false);
    this.resetRun();
    this.setPhase("menu");
    Background.stop();
    Background.setMenu();
  }

  resetRun() {
    Sound.resetPitch();
    Sound.ambient(false);
    this.timeAfterLastClick = 0;
    this.firstClickDone = false;
    this.score = 0;
    this.secondAccum = 0;
    this.jumpLock = 0;
    this.jumping = false;
    this.handAngle = HAND_ANGLE0;
    this.currentError = 0;
    this.cumulativeError = 0;
    this.spin = 0;
    this.indicator.rotation.set(0, 0, 0);
    this.pigAnim.position.y = 0;
    this.jump.stop();
    this.wiggle.stop();
    this.idle.reset().setEffectiveWeight(1).play();
    this.updateScore();
  }

  setPhase(phase) {
    this.phase = phase;
    if (phase !== "over") {
      clearTimeout(this._retryTimer);
      document.body.classList.remove("cooling");
    }
    // the scene is unloaded with the run, leaving the gradient behind the window
    document.body.classList.toggle("end", phase === "over");
    ui.menu.classList.toggle("show", phase === "menu");
    ui.over.classList.toggle("show", phase === "over");
    ui.hud.classList.toggle("on", phase === "playing");
    ui.hint.classList.toggle("on", phase === "armed");
    this.menuBestUpdate();
  }

  menuBestUpdate() {
    ui.menuBest.textContent = clockFormat(this.best);
    ui.overBest.textContent = clockFormat(this.best);
  }

  onTap() {
    if (this.phase === "menu" || this.phase === "over") return;
    // the retry overlay is still fading out over the scene
    if (performance.now() < this.inputLockedUntil) return;

    if (this.phase === "armed") {
      // MainClock.StartMainThread + Clock4.StartRotating
      this.setPhase("playing");
      Sound.init().then(() => Sound.ambient(true));
      this.onTap(); // this same tap is the first beat
      return;
    }

    // the pig's jump pause: while it is still coming down and fading back to
    // idle, a click does nothing at all -- it neither re-triggers the jump nor
    // counts as a beat, so mashing can't cut the animation short
    if (this.jumpLock > 0) return;

    // MainClock.OnUserClicked
    const error = this.firstClickDone ? 1 - this.timeAfterLastClick : 0;
    this.timeAfterLastClick = 0;

    if (!this.firstClickDone) {
      this.firstClickDone = true;
    }

    // Skin4GameManager.OnUserClicked
    this.cumulativeError += Math.abs(error);
    const rounded = Math.round(Math.abs(error) * 100) / 100;
    this.currentError += rounded * 10;

    // Clock4.Jump
    if (this.jumpLock <= 0) {
      this.jump.reset();
      this.jump.setEffectiveWeight(1);
      this.jump.play();
      this.wiggle.reset();
      this.wiggle.setEffectiveWeight(1);
      this.wiggle.play();
      this.idle.fadeOut(0.05);
      this.jumping = true;
      this.jumpLock = JUMP_PAUSE;
      try { Sound.tick(); } catch (e) {}
      this.pulseScore();
    }
  }

  pulseScore() {
    ui.hud.classList.remove("pop");
    void ui.hud.offsetWidth;
    ui.hud.classList.add("pop");
  }

  updateScore() {
    const s = this.score;
    ui.score.textContent = s >= 60
      ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
      : String(s);
  }

  endRun() {
    if (this.phase !== "playing") return;
    this.phase = "over";
    this.jumping = false;
    Sound.ambient(false);
    Sound.over();
    ui.hud.classList.remove("on");

    const score = this.score;
    const isBest = score > this.best;
    if (isBest) {
      this.best = score;
      localStorage.setItem("pigRhythmBest", String(score));
      setTimeout(() => Sound.best(), 420);
    }
    ui.finalScore.textContent = clockFormat(score);
    ui.trophy.classList.toggle("show", isBest);
    this.menuBestUpdate();
    Background.stop();
    Background.setMenu();
    clearTimeout(this._retryTimer);
    this.retryAt = performance.now() + RETRY_COOLDOWN;
    document.body.classList.add("cooling");
    this._retryTimer = setTimeout(() => {
      document.body.classList.remove("cooling");
    }, RETRY_COOLDOWN);
    setTimeout(() => {
      if (this.phase === "over") this.setPhase("over");
    }, 260);
  }

  /* ------------------------------------------------------------- collision */
  updateCollision(dt) {
    // pig collider (BoxCollider on pigAnimacja)
    this.pigAnim.updateWorldMatrix(true, false);
    this._m.makeTranslation(this.pigCenter.x, this.pigCenter.y, this.pigCenter.z);
    this._m2.multiplyMatrices(this.pigAnim.matrixWorld, this._m);
    setObbFromMatrix(this.pigObb, this._m2, this.pigHalf);

    // hand sweeps this frame: test in small angular substeps
    const delta = this.spin;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.004));
    const base = this.indicatorObj.matrixWorld;
    for (let i = 1; i <= steps; i++) {
      const a = this.handAngle - delta + (delta * i) / steps;
      this._rotY.makeRotationY(a);
      this._m2.multiplyMatrices(base, this._rotY).multiply(this.handChain);
      setObbFromMatrix(this.handObb, this._m2, this.handHalf);
      if (obbOverlap(this.pigObb, this.handObb)) {
        this.endRun();
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ loop */
  loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.05);
      this.lastTime = now;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  update(dt) {
    const now = performance.now();
    Background.update(now);

    if (this.phase === "playing") {
      if (this.firstClickDone) {
        this.timeAfterLastClick += dt;
        this.secondAccum += dt;
        while (this.secondAccum >= 1) {
          this.secondAccum -= 1;
          this.score += 1;
          this.updateScore();
          this.pulseScore();
        }
        // rotateIndicator.anim
        this.spin = SPIN_SIGN * TWO_PI * REV_PER_SEC * dt;
        this.handAngle += this.spin;
        this.indicator.rotation.y = this.handAngle;
      }
      if (this.jumpLock > 0) {
        this.jumpLock = Math.max(0, this.jumpLock - dt);
      }
    } else {
      this.spin = 0;
    }

    this.mixer.update(dt);
    this.scene.updateMatrixWorld(true);

    if (this.phase === "playing" && this.firstClickDone && this.spin !== 0) {
      this.updateCollision(dt);
    }
  }
}

/* -------------------------------------------------------------------- boot */
async function boot() {
  const get = (p) => fetch(p).then((r) => {
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.json();
  });
  const [model, scene, anims] = await Promise.all([
    get("data/model.json"),
    get("data/scene.json"),
    get("data/anims.json"),
  ]);
  window.game = new Game({ model, scene, anims });
}

boot().catch((e) => {
  console.error(e);
  const p = document.createElement("pre");
  p.style.cssText = "position:fixed;inset:auto 16px 16px 16px;color:#fff;font:12px monospace;white-space:pre-wrap;z-index:9";
  p.textContent = "Failed to start: " + (e && e.message ? e.message : e);
  document.body.appendChild(p);
});
