import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

let camera, scene, renderer;
let geometry, material, mesh, controls, light, loader;

const urlToTest =
  "https://nyc3.digitaloceanspaces.com/cjoshmartin-file-storage/root/documents/dickbutt_v2.stl?AWSAccessKeyId=DO00DHYY4MCL78G2Y67L&Signature=v6S9QezqIqvnnEIHp3Z%2Bv7FYS5g%3D&Expires=1707568317";

init();

function init () {

  scene = new THREE.Scene();

  // if (shouldShowAxis == true) {
  //   scene.add(new THREE.AxesHelper(20));
  // }

  light = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
  scene.add(light);

  camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  // camera.position.z = scale;
  camera.position.z = 40; // TODO

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setAnimationLoop( animation );

  controls = new OrbitControls(camera, renderer.domElement);
  controls.autoRotate = true;
  controls.enableDamping = true;
  controls.enableZoom = false;
  controls.enablePan = false;

  material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.5,
  });

  loader = new STLLoader();

  loader.load(
    // modalPath, // './keyholder-v2.stl'
    urlToTest,
    function (geometry) {
      geometry.center();
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      const thresholdAngle = 15;
      const edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: "#008000" })
      );
      scene.add(line);
    },
    // (xhr) => {
    //   const loadingAmount = Math.round((xhr.loaded / xhr.total) * 100);
    //   if (loadingAmount > 99) {
    //     console.log("Content Loaded");
    //     const loader = document.querySelector(`${querySelector} > div`);
    //     if (loader) {
    //       selector.removeChild(loader);
    //     }
    //     canvas.style.display = "block";
    //   }
    // },
    (error) => {
      console.log(error);
    }
  );

} 

function animation(time) {
  if( !renderer.domElement.parentNode ) return;

  // [TODO]: add the rest of this code
  mesh.rotation.x = time / 2000;
  mesh.rotation.y = time / 1000;

  renderer.render(scene, camera);
}

function resize(){
  const container = renderer.domElement.parentNode;

  if (container) {
    const width = container.offsetWidth;
    const height = container.offsetHeight;

    camera.aspect = width / height;
    renderer.setSize(width, height);
    camera.updateProjectionMatrix();
    controls.update();
  }
}

window.addEventListener( 'resize', resize );
resize();

export function mount(container) {
    if(container) {
      container.insertBefore( renderer.domElement, container.firstChild );
      resize();
    } else {
      renderer.domElement.remove();
    }
}

