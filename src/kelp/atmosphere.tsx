
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraFar, cameraNear, cameraPosition, cross, float, fract, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, pow, screenUV, sin, smoothstep, step, uv, vec3, vec4 } from "three/tsl";
import { useDispose } from "./engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "./engine/Post";
import { lehmer } from "./engine/random";
import { SURFACE, sea, threads, through } from "./water";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Plankton drifting close round the lens, over what the scene already has (the haze, the shafts and the specks): out of
// focus, each blurs into an even, soft-edged disc, the way a lens draws a point of light, so the water in
// front of everything is full of slow, glowing bokeh. Lit by the water's light everywhere and far brighter where the eye
// looks through it toward the sun, as small things in water scatter light onward.
//
// Drawn in the overlay pass, added over the finished frame past its lens blur, and hidden by the scene's depth, so it
// never touches the buffers the passes before read. Each disc is held to a small size on screen: a few hundred big
// additive quads over the whole frame would cost more than the scene.

// rising: marine snow instead, tiny flecks through a larger box round the eye, rising slowly as the finest plankton and
// specks do on the water's slow upwelling, glinting where the eye looks through them toward the sun and brighter in
// the slowly moving patches where the light comes down through the waves, so they read as drifting up through the
// shafts.
// far: marine snow through a much larger box, finer and fading into the water with distance, so it fills the whole
// view, not only the water round the eye.
export function Atmosphere({ motes, rising = false, far = false }: { motes: number; rising?: boolean; far?: boolean }) {
  const NEAR = far ? 18 : rising ? 7 : 4;
  const parts = useMemo(() => {
    const random = lehmer(far ? 7027 : rising ? 6113 : 4471);
    const seeds = new Float32Array(motes * 4);
    for (let i = 0; i < motes; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, material, motes);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < motes; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    return { quad, material, specks };
  }, [motes, rising, far]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = sea.clock as any;
        const s = attribute("aSeed", "vec4") as any;
        // In a box round the eye that wraps, wandering, sinking slowly and carried by the current.
        const carried = sea.carried as any;
        const climb = rising ? t.mul(0.035).mul(s.w.add(0.5)) : t.mul(-0.02).mul(s.w.add(0.5));
        const drift = vec3(sin(t.mul(0.11).add(s.w.mul(40))).mul(0.25).add(carried.x), climb, sin(t.mul(0.09).add(s.x.mul(31))).mul(0.25).add(carried.y)) as any;
        const centre = cameraPosition.add(fract(s.xyz.add(drift.sub(cameraPosition).div(NEAR))).sub(0.5).mul(NEAR)) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const away = cameraPosition.sub(centre).length() as any;
        // Its size: a speck of a millimetre or two, grown by how far it lies from the focus, but never more than about
        // two degrees across, so near the lens the discs stay a handsome size rather than filling the screen.
        // Marine snow is finer and blurs less: most of it lies past the lens's near blur.
        const sharp = max(float(rising ? 0.0006 : 0.0012), away.mul(rising ? 0.0007 : 0.0011)).mul(s.w.mul(1.4).add(0.6)) as any;
        const blur = min(away.sub(focusDistance).abs().div(away).mul(rising ? 0.012 : 0.03), away.mul(s.y.mul(s.y).mul(rising ? 0.006 : 0.016).add(rising ? 0.002 : 0.005))) as any;
        const radius = sharp.add(blur) as any;
        const spread = sharp.div(radius).pow(1.2).max(0.22) as any;
        const soft = smoothstep(0.002, 0.012, blur) as any;
        parts.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        // A point in focus; out of it, an even disc, soft at its edge with only a trace of a brighter rim.
        const r = uv().sub(0.5).length() as any;
        const point = float(1).sub(smoothstep(0.1, 0.5, r)) as any;
        const disc = float(1).sub(smoothstep(0.36, 0.5, r)).mul(0.8).add(smoothstep(0.3, 0.44, r).mul(float(1).sub(smoothstep(0.44, 0.5, r))).mul(0.1)) as any;
        // Each its own brightness, most faint and a few bright, as the light catches them.
        const dot = mix(point, disc, soft).mul(spread).mul(s.z.mul(s.z).mul(0.65).add(0.35)) as any;
        // Gone right at the lens and toward the edge of the box, so none pops in or out.
        const fade = smoothstep(far ? 2.5 : 0.15, far ? 4 : 0.4, away).mul(float(1).sub(smoothstep(NEAR * 0.36, NEAR * 0.5, away))) as any;
        const twinkle = sin(t.mul(s.y.mul(1.2).add(0.3)).add(s.z.mul(50))).mul(0.25).add(0.75) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const onward = pow(max(toEye.negate().dot(sea.toSun), 0), 3) as any;
        const lit = through(max(float(SURFACE).sub(centre.y), 0).mul(0.55)) as any;
        const glow = (sea.sun as any).mul(sea.power).mul(onward.mul(0.8).add(0.08)).add((sea.shallow as any).mul(0.8)) as any;
        // For marine snow: lit in the patches where the waves gather the light (the same net of threads as the caustics),
        // traced up from each fleck toward the sun, so they brighten as they rise into a shaft and dim leaving it.
        const toSurface = max(float(SURFACE).sub(centre.y), 0).div(max((sea.toSun as any).y, 0.3)) as any;
        const top = centre.xz.add((sea.toSun as any).xz.mul(toSurface)) as any;
        const shaft = smoothstep(0.02, 0.35, threads(top.div(sea.cell.mul(4)), t.mul(0.42).mul(sea.flicker).add(23))).mul(1.6).add(0.15) as any;
        // Seen through the water between it and the eye: far flecks fade into the blue rather than end.
        const snowGlow = (sea.sun as any).mul(sea.power).mul(onward.mul(1.2).add(0.1)).mul(shaft).add((sea.shallow as any).mul(0.7)).mul(through(away.mul(1.6))) as any;
        parts.material.colorNode = vec4((rising ? snowGlow : glow).mul(lit).mul(dot).mul(fade).mul(twinkle).mul(shown).mul(1.5), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts]
  );

  return <primitive object={parts.specks} />;
}
