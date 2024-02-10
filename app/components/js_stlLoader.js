import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

let camera, scene, renderer;
let geometry, material, mesh;

init();

function init () {

} 

export function loadCADModel(
  querySelector,
  modalPath,
  scale = 40,
  shouldShowAxis = false,
  meshColor = "#ffffff",
  edgeColor = "#008000"
) {
  let selector = undefined;

  if (typeof window !== "undefined") {
    selector = document.querySelector(querySelector);
  }

  if(!selector){
    return;
  }

  let width = selector.clientWidth;
  let height = selector.clientHeight;

  const scene = new THREE.Scene();

  if (shouldShowAxis == true) {
    scene.add(new THREE.AxesHelper(20));
  }

  const light = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
  scene.add(light);

  const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  camera.position.z = scale;

  const renderer = new THREE.WebGLRenderer();
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setSize(width, height);
  selector.appendChild(renderer.domElement);
  const canvas = document.querySelector(`${querySelector} canvas`);
  canvas.style.display = "none";

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.autoRotate = true;
  controls.enableDamping = true;
  controls.enableZoom = false;
  controls.enablePan = false;
  const material = new THREE.MeshStandardMaterial({
    color: meshColor,
    roughness: 0.5,
  });

  const loader = new STLLoader();
  const div = document.createElement("div");
  div.style.cssText = "";

  loader.load(
    modalPath, // './keyholder-v2.stl'
    function (geometry) {
      geometry.center();
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      const thresholdAngle = 15;
      const edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: edgeColor })
      );
      scene.add(line);
    },
    (xhr) => {
      const loadingAmount = Math.round((xhr.loaded / xhr.total) * 100);
      if (loadingAmount > 99) {
        console.log("Content Loaded");
        const loader = document.querySelector(`${querySelector} > div`);
        if (loader) {
          selector.removeChild(loader);
        }
        canvas.style.display = "block";
      }
    },
    (error) => {
      console.log(error);
    }
  );

  function animate() {
    requestAnimationFrame(animate);

    height = selector.clientHeight;
    width = selector.clientWidth;

    if (window.innerWidth < 900) {
      controls.enabled = false;
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);

    controls.update();

    render();
  }

  function render() {
    renderer.render(scene, camera);
  }

  animate();
}
