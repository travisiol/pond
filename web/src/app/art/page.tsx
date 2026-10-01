"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { SKINS, makeFishGeometry, makeFishMaterial } from "@/game/fishMesh";

// A contact sheet of the ten fish, large, to judge the model and the skins.
export default function Art() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x0a4a66);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, w / h, 1, 5000);
    camera.position.set(0, 620, 380);
    camera.lookAt(0, 0, 0);
    const geo = makeFishGeometry();
    const fog = new THREE.Color(0x0a4a66);
    const fish = SKINS.map((skin, i) => {
      const mat = makeFishMaterial(skin, fog, 0.00001);
      const mesh = new THREE.Mesh(geo, mat);
      const col = i % 5;
      const row = Math.floor(i / 5);
      mesh.position.set((col - 2) * 210, 0, (row - 0.5) * 230);
      mesh.scale.setScalar(170);
      mesh.rotation.y = row ? 0.5 : -0.4;
      scene.add(mesh);
      return mat;
    });
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      for (const [i, m] of fish.entries()) {
        m.uniforms.uPhase.value = t / 160 + i;
        m.uniforms.uTime.value = t / 1000;
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
    };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, width: "100%", height: "100%" }} />;
}
