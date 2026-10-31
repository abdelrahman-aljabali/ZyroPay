/**
 * CSS matrix3d that maps the rectangle (0,0)-(w,h) onto an arbitrary quad (projective mapping).
 * Used to pin real DOM onto the face of a WebGL object: corners are projected each frame and
 * the element gets `transform-origin: 0 0; transform: matrix3d(...)`.
 */
type M3 = [number, number, number, number, number, number, number, number, number];

function adj(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
}

function mul(a: M3, b: M3): M3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (a[3 * i + k] ?? 0) * (b[3 * k + j] ?? 0);
      r.push(s);
    }
  }
  return r as M3;
}

function mulV(m: M3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export type Quad = readonly [number, number, number, number, number, number, number, number];

function basis(q: Quad): M3 {
  const m: M3 = [q[0], q[2], q[4], q[1], q[3], q[5], 1, 1, 1];
  const v = mulV(adj(m), [q[6], q[7], 1]);
  return mul(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}

/** `dst` corners in order: top-left, top-right, bottom-left, bottom-right (x, y pairs). */
export function rectToQuad(w: number, h: number, dst: Quad): string {
  const src: Quad = [0, 0, w, 0, 0, h, w, h];
  const t = mul(basis(dst), adj(basis(src)));
  const n = t[8] === 0 ? 1 : t[8];
  const k = t.map((x) => x / n);
  const v = [k[0], k[3], 0, k[6], k[1], k[4], 0, k[7], 0, 0, 1, 0, k[2], k[5], 0, k[8]];
  return `matrix3d(${v.map((x) => (x ?? 0).toFixed(8)).join(",")})`;
}
