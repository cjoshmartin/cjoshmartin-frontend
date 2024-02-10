'use client';
import { Suspense } from "react";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useLoader } from "@react-three/fiber";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";

interface ModelRenderProps {
    url: string;
  }

  function ModelRender({ url }: ModelRenderProps) {
    const geom = useLoader(STLLoader, url);
    console.log(geom);
    return (
      <mesh geometry={geom}>
        <meshPhongMaterial color="white" />
      </mesh>
    );
  }


export function STLFileArea({ value }: any) {
    const { scale, file } = value;
    const {url, title} = file;


    return (
      <div className="App" style={{ backgroundColor: "white" }}>
        <h3>{title}</h3>
        <Canvas
          style={{ height: "400px" }}
          camera={{ position: [450, 650, 20], fov: 30 }}
        >
          <Suspense fallback={"loading..."}>
            <ModelRender
              url={
                "https://cdn.thingiverse.com/assets/99/39/31/f9/33/90_Degree_-_4_Segments.stl"
              }
            />
          </Suspense>
          <OrbitControls panSpeed={0.5} rotateSpeed={0.4} />
          <spotLight
            intensity={1.5}
            angle={0.1}
            penumbra={1}
            position={[450, 350, 20]}
          />
          <spotLight
            intensity={1.5}
            angle={2.5}
            penumbra={1}
            position={[250, 150, 40]}
          />
        </Canvas>
      </div>
    );
}
