import { Environment, Lightformer, MeshTransmissionMaterial, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { rectToQuad } from "../../lib/homography";

/*
 * The hero's 3D stage: a phone built from primitives (no downloaded model), lit by a
 * procedural environment (Lightformers, no HDR fetch) and one volumetric key light.
 * The phone's screen is real DOM laid over the canvas: every frame the four corners of the
 * glass are projected and the DOM gets the exact projective transform (lib/homography), so
 * the approval card stays interactive and accessible. Lazy-loaded; never shipped to small or
 * low-end devices.
 */

const BODY = { w: 0.768, h: 1.62, d: 0.086, r: 0.112 } as const;
const BEVEL = 0.012;
/** A 0.02 border on every side (2.6 % of the width, like the real device). */
const SCREEN_W = 0.728;
const SCREEN_H = (SCREEN_W * 852) / 393;
const SCREEN_Z = BODY.d / 2 + 0.002;
/** Screen corners in phone space: top-left, top-right, bottom-left, bottom-right. */
const CORNERS = [
  new THREE.Vector3(-SCREEN_W / 2, SCREEN_H / 2, SCREEN_Z),
  new THREE.Vector3(SCREEN_W / 2, SCREEN_H / 2, SCREEN_Z),
  new THREE.Vector3(-SCREEN_W / 2, -SCREEN_H / 2, SCREEN_Z),
  new THREE.Vector3(SCREEN_W / 2, -SCREEN_H / 2, SCREEN_Z),
];

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Soft radial light painted once into a canvas: the backdrop the glass refracts. */
function useBackdropTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 512;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#060709";
      g.fillRect(0, 0, 512, 512);
      const a = g.createRadialGradient(330, 150, 10, 330, 150, 330);
      a.addColorStop(0, "rgba(255,244,228,0.22)");
      a.addColorStop(0.35, "rgba(190,196,214,0.06)");
      a.addColorStop(1, "rgba(6,7,9,0)");
      g.fillStyle = a;
      g.fillRect(0, 0, 512, 512);
      const b = g.createRadialGradient(120, 420, 0, 120, 420, 220);
      b.addColorStop(0, "rgba(120,140,180,0.08)");
      b.addColorStop(1, "rgba(6,7,9,0)");
      g.fillStyle = b;
      g.fillRect(0, 0, 512, 512);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

function Backdrop() {
  const map = useBackdropTexture();
  return (
    <mesh position={[0, 0.2, -2.4]} scale={[9, 9, 1]}>
      <planeGeometry />
      <meshBasicMaterial map={map} toneMapped={false} />
    </mesh>
  );
}

/** A static pane of glass behind the phone. */
function GlassPane({
  position,
  rotation,
  size,
}: {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number];
  readonly size: [number, number];
}) {
  return (
    <RoundedBox
      args={[size[0], size[1], 0.035]}
      radius={0.016}
      smoothness={4}
      position={position}
      rotation={rotation}
    >
      <MeshTransmissionMaterial
        samples={6}
        resolution={512}
        transmission={1}
        thickness={0.5}
        roughness={0.06}
        ior={1.45}
        chromaticAberration={0.08}
        anisotropicBlur={0.1}
        distortion={0.1}
        distortionScale={0.3}
        temporalDistortion={0}
        envMapIntensity={0.35}
        specularIntensity={0.5}
        color="#ffffff"
        backside={false}
      />
    </RoundedBox>
  );
}

/** A soft vertical band of light (gaussian across its width), painted once. */
function useGlowTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 8;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createLinearGradient(0, 0, 128, 0);
      for (let i = 0; i <= 16; i++) {
        const x = i / 16;
        const a = Math.exp(-Math.pow((x - 0.5) / 0.16, 2));
        grad.addColorStop(x, `rgba(255,255,255,${a.toFixed(3)})`);
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 8);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

/** Soft light bands behind the glass: the light the panes bend. */
function LightStrips({ lit }: { readonly lit: boolean }) {
  const map = useGlowTexture();
  const warm = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((_, delta) => {
    const m = warm.current;
    if (!m) return;
    const target = lit ? 1 : 0.62;
    m.opacity += (target - m.opacity) * (1 - Math.exp(-delta * 2));
  });
  const band = (
    key: string,
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    opacity: number,
    ref?: React.Ref<THREE.MeshBasicMaterial>,
  ) => (
    <mesh key={key} position={[x, y, 0]} rotation={[0, 0, -0.38]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial
        ref={ref}
        map={map}
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
  return (
    <group position={[0, 0, -1.9]}>
      {band("warm", 0.95, 0.45, 0.9, 4.2, "#ffe9cf", 0.62, warm)}
      {band("cool", -0.75, -0.1, 0.6, 3.6, "#b9c8ff", 0.28)}
      {band("thin", 0.2, 0.9, 0.22, 3, "#ffffff", 0.35)}
    </group>
  );
}

interface PhoneProps {
  readonly lit: boolean;
}

interface PinProps {
  /** The DOM screen to pin onto the glass. */
  readonly overlay: RefObject<HTMLDivElement | null>;
  readonly onFirstFrame: () => void;
}

/** The phone stands still at a fixed three-quarter angle: no parallax, no sway, no shake. */
function Phone({ overlay, onFirstFrame }: PinProps) {
  const group = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const placed = useRef(false);
  // A flat-fronted slab: extruded rounded rectangle with a small bevel, so the front face is
  // exactly BODY.w x BODY.h with corner radius BODY.r and the screen insets evenly.
  const body = useMemo(() => {
    const b = BEVEL;
    const g = new THREE.ExtrudeGeometry(roundedRect(BODY.w - 2 * b, BODY.h - 2 * b, BODY.r - b), {
      depth: BODY.d - 2 * b,
      bevelEnabled: true,
      bevelThickness: b,
      bevelSize: b,
      bevelSegments: 6,
      curveSegments: 28,
    });
    g.translate(0, 0, -(BODY.d - 2 * b) / 2);
    g.computeVertexNormals();
    return g;
  }, []);
  const glass = useMemo(
    () => new THREE.ShapeGeometry(roundedRect(BODY.w - 0.016, BODY.h - 0.016, BODY.r - 0.008), 28),
    [],
  );

  // Pin the DOM screen onto the glass. Runs on every rendered frame; with frameloop "demand"
  // that is only the first frame, resizes and light transitions.
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const el = overlay.current;
    if (!el) return;
    g.updateMatrixWorld();
    const q: number[] = [];
    for (const c of CORNERS) {
      tmp.copy(c).applyMatrix4(g.matrixWorld).project(camera);
      q.push(((tmp.x + 1) / 2) * size.width, ((1 - tmp.y) / 2) * size.height);
    }
    el.style.transform = rectToQuad(393, 852, q as unknown as Parameters<typeof rectToQuad>[2]);
    if (!placed.current) {
      placed.current = true;
      el.style.visibility = "visible";
      onFirstFrame();
    }
  });

  return (
    <group ref={group} rotation={[0.03, -0.18, 0]}>
      {/* Titanium band */}
      <mesh geometry={body}>
        <meshPhysicalMaterial
          color="#5a5c63"
          metalness={1}
          roughness={0.22}
          clearcoat={0.4}
          clearcoatRoughness={0.25}
        />
      </mesh>
      {/* Side buttons */}
      {[
        [-1, 0.42, 0.07],
        [-1, 0.27, 0.13],
        [-1, 0.1, 0.13],
        [1, 0.2, 0.2],
      ].map(([side = 1, y = 0, h = 0.1], i) => (
        <RoundedBox
          key={i}
          args={[0.014, h, 0.03]}
          radius={0.006}
          position={[side * (BODY.w / 2 + 0.003), y, 0]}
        >
          <meshStandardMaterial color="#5a5c63" metalness={1} roughness={0.25} />
        </RoundedBox>
      ))}
      {/* Cover glass */}
      <mesh geometry={glass} position={[0, 0, BODY.d / 2 + 0.0015]}>
        <meshPhysicalMaterial
          color="#030304"
          roughness={0.06}
          metalness={0}
          clearcoat={1}
          clearcoatRoughness={0.02}
          reflectivity={0.6}
        />
      </mesh>
    </group>
  );
}

const Scene = memo(function Scene(props: PhoneProps & PinProps) {
  const spot = useRef<THREE.SpotLight>(null);
  const invalidate = useThree((st) => st.invalidate);
  useFrame((_, delta) => {
    const s = spot.current;
    if (!s) return;
    const target = props.lit ? 22 : 14;
    s.intensity += (target - s.intensity) * (1 - Math.exp(-delta * 2));
  });
  // The only change in the scene is the light warming on approval: render ~1.6 s of frames
  // for that transition, then go idle again.
  useEffect(() => {
    let raf = 0;
    const until = performance.now() + 1600;
    const tick = () => {
      invalidate();
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [props.lit, invalidate]);

  return (
    <>
      <color attach="background" args={["#060709"]} />
      <Backdrop />
      <LightStrips lit={props.lit} />
      <GlassPane position={[0.7, 0.1, -1.2]} rotation={[0, -0.35, 0.06]} size={[1.1, 1.6]} />
      <GlassPane position={[-0.75, -0.25, -1.5]} rotation={[0, 0.4, -0.05]} size={[1.0, 1.4]} />
      <Phone overlay={props.overlay} onFirstFrame={props.onFirstFrame} />
      <spotLight
        ref={spot}
        position={[1.8, 3.4, 2.2]}
        angle={0.5}
        penumbra={1}
        distance={9}
        decay={1.2}
        intensity={14}
        color="#fff3e2"
      />
      <ambientLight intensity={0.15} />
      <Environment frames={1} resolution={256} environmentIntensity={1.15}>
        <Lightformer
          form="rect"
          intensity={4}
          color="#fff4e6"
          position={[2.5, 3, 2]}
          scale={[3, 1.2, 1]}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="rect"
          intensity={2.5}
          color="#ffffff"
          position={[-2, 2, -2]}
          scale={[0.4, 4, 1]}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="rect"
          intensity={1.4}
          color="#cfd8ff"
          position={[-3, 0.5, 1]}
          scale={[1, 4, 1]}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="ring"
          intensity={0.8}
          color="#ffffff"
          position={[0, -2, 3]}
          scale={1.5}
          target={[0, 0, 0]}
        />
      </Environment>
    </>
  );
});

interface PhoneSceneProps extends PhoneProps {
  readonly onReady: () => void;
  /** The DOM screen: the simulated app. */
  readonly screen: ReactNode;
}

export default function PhoneScene({ onReady, screen, ...props }: PhoneSceneProps) {
  const overlay = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const host = useRef<HTMLDivElement>(null);

  // Stop rendering entirely when the hero is off screen.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? true);
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);

  return (
    <div ref={host} className="s-canvas">
      <div className="s-gl">
        <Canvas
          dpr={[1, 2]}
          frameloop={visible ? "demand" : "never"}
          camera={{ position: [0, 0, 3.95], fov: 30 }}
          gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.05;
          }}
        >
          <Scene {...props} overlay={overlay} onFirstFrame={onReady} />
        </Canvas>
      </div>
      <div ref={overlay} className="s-overlay">
        {screen}
      </div>
    </div>
  );
}
