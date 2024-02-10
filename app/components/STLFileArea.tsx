'use client';
import { Suspense, useRef } from "react";
import { Edges, OrbitControls } from "@react-three/drei";
import { Canvas, useLoader,  useFrame  } from "@react-three/fiber";
//@ts-ignore
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";

interface ModelRenderProps {
    url: string;
  }

  function ModelRender({ url }: ModelRenderProps) {
    const geom = useLoader(STLLoader, url);
    const boxRef = useRef();

    useFrame(() => {
        //@ts-ignore
      boxRef.current.rotation.y += 0.001;
    });
  

    return (
      <group dispose={null}>
        <mesh geometry={geom} 
            rotation={[0, 10, 0]}
            // @ts-ignore
            ref={boxRef}
        >
          <meshStandardMaterial transparent />
          <Edges color={"#008000"} threshold={15}/>
        </mesh>
      </group>
    );
  }


export function STLFileArea({ value }: any) {
    const { scale, file } = value;
    const {url, title} = file;


    return (
      <div className="App">
        <h3>{title}</h3>
        <Canvas
          style={{ height: "400px" }}
          camera={{ position: [450, 300, 0], fov: 30, zoom: 4 }}
        >
          <Suspense fallback={"loading..."}>
            <ModelRender
              url={
                "https://storage.googleapis.com/images-for-cms/documents/miata_key.stl"
              }
            />
          </Suspense>
          <OrbitControls
            panSpeed={0.5}
            rotateSpeed={0.4}
            enableDamping={true}
            enablePan={false}
            enableZoom={false}
          />
          <ambientLight intensity={1.5} />
          {/* <axesHelper args={[20]} /> */}
        </Canvas>
      </div>
    );
}
