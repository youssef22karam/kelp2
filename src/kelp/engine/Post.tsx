import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { dot, float, hash, mix, pass, screenSize, screenUV, uniform, vec4 } from "three/tsl";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { lookUniforms } from "./Stage";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The finished frame. The scene (layer 0) is drawn with its depth; then depth of field about the focus, bloom, and a
// vignette and grain. Things on OVERLAY_LAYER (light shafts, plankton bokeh) are drawn in a pass of their own after,
// reading the scene's depth to hide behind what stands in front of them, and added over the blurred frame so they
// never feed back into the buffers the passes before read.

export const OVERLAY_LAYER = 3;
export const focusDistance = uniform(4);
export const focusBlur = uniform(1.5);
const focalRange = uniform(5);

type DepthNode = { sample: (uv: any) => any };
type Listener = (depth: DepthNode) => void;
let depthNode: DepthNode | null = null;
const listeners = new Set<Listener>();

// Lets overlay materials build their nodes once the scene's depth texture exists.
export const overlayLink = {
  listen(listener: Listener) {
    listeners.add(listener);
    if (depthNode) listener(depthNode);
    return () => {
      listeners.delete(listener);
    };
  }
};

export function Post({ range = 5 }: { range?: number }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  focalRange.value = range;

  const built = useMemo(() => {
    const overlayCamera = new THREE.PerspectiveCamera();
    overlayCamera.layers.set(OVERLAY_LAYER);
    camera.layers.set(0);

    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output") as any;
    const viewZ = scenePass.getViewZNode() as any;
    const depth = scenePass.getTextureNode("depth") as any;

    const blurred = dof(color, viewZ, focusDistance, focalRange, focusBlur) as any;
    const glow = bloom(blurred, lookUniforms.bloom.value, 0.45, lookUniforms.bloomThreshold.value) as any;

    const overlayPass = pass(scene, overlayCamera);
    const overlay = overlayPass.getTextureNode("output") as any;

    const centred = screenUV.sub(0.5) as any;
    const vignette = float(1).sub(dot(centred, centred).mul(lookUniforms.vignette.mul(1.4))).clamp(0, 1) as any;
    // hash() takes one number: fold the pixel's x and y (and the frame) into it, so the grain varies both ways.
    const pixel = screenUV.mul(screenSize).floor() as any;
    const grainTime = uniform(0);
    const seed = pixel.x.add(pixel.y.mul(4099)).add(grainTime.mul(7919).floor()) as any;
    const grain = hash(seed).sub(0.5).mul(lookUniforms.grain) as any;

    const rgb = blurred.rgb.add(glow.rgb).add(overlay.rgb) as any;
    const finished = mix(rgb.mul(0.25), rgb, vignette).add(grain) as any;

    const pipeline = new THREE.RenderPipeline(gl);
    pipeline.outputNode = vec4(finished.max(0), 1) as any;
    return { pipeline, overlayCamera, depth, glow, grainTime, scenePass, overlayPass };
  }, [gl, scene, camera]);

  useEffect(() => {
    depthNode = built.depth;
    listeners.forEach((l) => l(built.depth));
    return () => {
      depthNode = null;
      built.pipeline.dispose();
      built.scenePass.dispose();
      built.overlayPass.dispose();
    };
  }, [built]);

  useFrame(({ clock }) => {
    const { overlayCamera, pipeline, glow, grainTime } = built;
    camera.updateMatrixWorld();
    overlayCamera.position.copy(camera.position);
    overlayCamera.quaternion.copy(camera.quaternion);
    overlayCamera.fov = camera.fov;
    overlayCamera.aspect = camera.aspect;
    overlayCamera.near = camera.near;
    overlayCamera.far = camera.far;
    overlayCamera.updateProjectionMatrix();
    overlayCamera.updateMatrixWorld();
    glow.strength.value = lookUniforms.bloom.value;
    glow.threshold.value = lookUniforms.bloomThreshold.value;
    grainTime.value = clock.elapsedTime % 100;
    gl.toneMappingExposure = lookUniforms.exposure.value;
    pipeline.render();
  }, 1);

  return null;
}
