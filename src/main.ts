import * as THREE from "three";

import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { ThreeJSOverlayView } from "@googlemaps/three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils";


let map: google.maps.Map;

let elevationService = null;

const mapOptions = {
    tilt: 60,
    heading: 0,
    zoom: 18,
    center: { lat: 37.42365071290318, lng: -122.09213813335974 },
    mapId: "15431d2b469f209e",
    //// disable interactions due to animation loop and moveCamera
    disableDefaultUI: false,
    gestureHandling: "greedy"
    //keyboardShortcuts: false,
};




function get_gltf(url: string) {
    // Load the model.
    const loader = new GLTFLoader();

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath( '/examples/jsm/libs/draco/' );
    loader.setDRACOLoader(dracoLoader);

    return new Promise(resolve => 
        loader.load(url, (gltf) => {
            gltf.scene.scale.set(10, 10, 10);
            resolve(gltf);
        }
        )
    );
}


async function exportPositionedGLTF(model, overlay, animationClipList) {
    const gltfExporter = new GLTFExporter();
    const export_options = {
        trs: false,
        onlyVisible: true,
        binary: false,
        maxTextureSize: 4096
    };

    if(animationClipList != null){
        export_options.animations = animationClipList;
    }


    const origin = overlay.anchor;
    const local = model.position;
    const ecef_with_normal = await localToECEFWithNormal(origin, local, true);
    const global_quaternion = computeQuaternion(ecef_with_normal);
    // Rotate around the x axis, like what we did for visualization.
    global_quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI/2));


    let positioned_model = SkeletonUtils.clone(model);
    positioned_model.setRotationFromQuaternion(global_quaternion);
    positioned_model.position.x = ecef_with_normal.position.x;
    positioned_model.position.y = ecef_with_normal.position.y;
    positioned_model.position.z = ecef_with_normal.position.z;


    gltfExporter.parse(
        positioned_model,
        function ( result ) {
            const output = JSON.stringify(result, null, 2);
            const blob = new Blob([output], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = url;
            link.download = 'model_positioned.gltf';
            link.click();
        },
        function ( error ) {
            console.log( 'An error happened during parsing', error );
        },
        export_options
    );
}



function getElevationFromElevationAPI(lat, lng){

    // Lazy setup the Elevation service
    if(elevationService == null){
        elevationService = new google.maps.ElevationService();	
    }

    console.log('Querying Maps JS API Elevation Service: ');
    const location = new google.maps.LatLng(lat, lng);

    return new Promise((resolve, reject) => {
        elevationService.getElevationForLocations({ locations: [location] }, (results, status) => {
            if (status === 'OK' && results[0]) {
                let elevation = results[0].elevation;
                resolve(elevation);
            } else {
                reject(new Error(`Failed to get elevation for (${lat}, ${lng}): ${status}`));
            }
        });
    });
}



async function getGeoidUndulation(lat,lng) {
    const url = 'https://jmbh.herbertnet.co.uk/geoid_server?lat='+lat.toFixed(6) +'&lng=' + lng.toFixed(6);

    try{
        let response = await fetch(url);

        console.log(response.status);
        console.log(response.statusText);

        if(response.status === 200) {
            let data = await response.json();
            if (data.geoidHeight != undefined) {
                return data.geoidHeight;
            } else {
                alert('No Geoid found at this location: ()' + lat + ', ' + lng + ') - maybe outside US?  Returning zero which may affect model altitude');
                return 0;
            }
        }
    } catch (error) {
        console.log(error)
        return 0;
    }
}



function setLocalPositionInfo(model){
    const local_translation_div = document.getElementById('local_translation');
    const local_rotation_div = document.getElementById('local_rotation');
    const local_scale_div = document.getElementById('local_scale');

    const position = model.position.toArray().map((p) => p.toFixed(2)).join(', ');
    const rotation = model.rotation.toArray().map((r) => (typeof r === 'number') ? THREE.MathUtils.radToDeg(r).toFixed(2) : r).join(', ');
    const scale = model.scale.toArray().map((s) => s.toFixed(2)).join(', ');

    local_translation_div.innerHTML = position;
    local_rotation_div.innerHTML = rotation;
    local_scale_div.innerHTML = scale;

}


function getPositionFromLocalPosition(localPosition) {
    const earthRadius = 6378137; // Earth's radi=us in meters
    const lat = THREE.MathUtils.radToDeg(Math.atan2(localPosition.z, Math.sqrt(localPosition.x ** 2 + localPosition.y ** 2)));
    const lng = THREE.MathUtils.radToDeg(Math.atan2(localPosition.y, localPosition.x));
    const altitude = localPosition.length() - earthRadius;
    return { lat, lng, altitude };
}


function setLatLngAltInfo(model) {

    const lla_lat_div = document.getElementById('lla_lat');
    const lla_lng_div = document.getElementById('lla_lng');
    const lla_alt_div = document.getElementById('lla_alt');

    const { lat, lng, altitude } = getPositionFromLocalPosition(model.position);

    lla_lat_div.innerHMTL = lat;
    lla_lng_div.innerHTML = lng;
    lla_alt_div.innerHTML = altitude;
}


function computeQuaternion(ecef_with_normal){
    const north_pole = new THREE.Vector3(0, 0, 1);

    const up = ecef_with_normal.normal;
    const east = north_pole.cross(up).normalize();
    const north = up.clone().cross(east).normalize();

    // Note that if we are at the north or south pole (e.g. `up.dot(north_pole)` is 1 or -1), we should special case.
    // However, we are operating on a Mercator map, so the north/south pole is inaccessible anyway.

    const m = new THREE.Matrix4();
    m.set(east.x, north.x, up.x, 0,
        east.y, north.y, up.y, 0,
        east.z, north.z, up.z, 0,
        0, 0, 0, 1);

    const quat = new THREE.Quaternion();
    quat.setFromRotationMatrix(m);
    return quat;
}


async function getPreciseAltitude(lat,lng){
    let elevation_promise = getElevationFromElevationAPI(lat, lng); 
    const elevation = await elevation_promise;
    let geoid_undulation_promise = getGeoidUndulation(lat, lng);
    const geoid_undulation = await geoid_undulation_promise;

    console.log('Elevation: ' + elevation);
    console.log('Geoid Undulation: ' + geoid_undulation);

    let altitude = elevation + geoid_undulation;
    console.log('Altitude: ' + altitude);
    return altitude;
}



async function localToECEF(origin, local, set_precise_altitude=false) {
    // Define constants
    const a = 6378137.0; // Earth's equatorial radius in meters
    const f = 1.0 / 298.257223563; // Earth's flattening
    const b = a * (1.0 - f); // Earth's polar radius in meters
    const eSq = (a*a - b*b) / (a*a); // Eccentricity squared

    // Convert origin to geodetic coordinates
    const phi = origin.lat * Math.PI / 180; // Latitude in radians
    const lambda = origin.lng * Math.PI / 180; // Longitude in radians

    let h = 0;
    if (set_precise_altitude){
        h = await getPreciseAltitude(origin.lat, origin.lng);
    }else{
        h = origin.altitude; // Altitude in meters
    }
    console.log('Adjusted Altitude: ' + h);

    const N = a / Math.sqrt(1 - eSq * Math.sin(phi)**2); // Radius of curvature in the prime vertical
    const x0 = (N + h) * Math.cos(phi) * Math.cos(lambda); // ECEF x-coordinate
    const y0 = (N + h) * Math.cos(phi) * Math.sin(lambda); // ECEF y-coordinate
    const z0 = ((1 - eSq) * N + h) * Math.sin(phi); // ECEF z-coordinate

    // Convert local coordinates to ECEF coordinates
    const dx = local.x;
    const dy = local.y;
    const dz = local.z;
    const x = x0 + dx;
    const y = y0 + dy;
    const z = z0 + dz;

    return {'x': x, 'y': y, 'z': z};
}

async function localToECEFWithNormal(origin, local, set_precise_altitude=false) {
    const translation_raw = await localToECEF(origin, local, set_precise_altitude);
    const translation = new THREE.Vector3(translation_raw.x, translation_raw.y, translation_raw.z);

    const translation_down_raw = await localToECEF(origin, new THREE.Vector3(0, 0, 0), false);
    const origin_up = new google.maps.LatLngAltitude({lat: origin.lat, lng: origin.lng, altitude: origin.altitude + 100.0});
    const translation_up_raw = await localToECEF(origin_up, new THREE.Vector3(0, 0, 0), false);

    const translation_down = new THREE.Vector3(translation_down_raw.x, translation_down_raw.y, translation_down_raw.z);
    const translation_up = new THREE.Vector3(translation_up_raw.x, translation_up_raw.y, translation_up_raw.z);
    const normal = translation_up.sub(translation_down).normalize();

    return {'position': translation, 'normal': normal};
}


async function setECEFPositionInfo(model, overlay){
    const origin = overlay.anchor;
    const local = model.position;

    const ecef_with_normal = await localToECEFWithNormal(origin, local);
    const ecef_translation_div = document.getElementById('ecef_translation');
    ecef_translation_div.innerHTML = '[' + ecef_with_normal.position.x + ',<br />' + ecef_with_normal.position.y + ',<br />' + ecef_with_normal.position.z + ']';

    // Get global quaternion
    const ecef_vector = ecef_with_normal.position;
    console.log('ecef_vector ' + ecef_vector.toArray());

    const quaternion = computeQuaternion(ecef_with_normal);
    console.log('quaternion ' + quaternion.toArray());

    const ecef_rotation_div = document.getElementById('ecef_rotation');
    ecef_rotation_div.innerHTML = '[x: ' + quaternion.x + ',<br />y:' + quaternion.y + ',<br />z:' + quaternion.z + ',<br />w:' + quaternion.w + ']';
}


function updateModelInfoOverlay(model, overlay) {
    setLocalPositionInfo(model);
    setECEFPositionInfo(model, overlay);
    //setLatLngAltInfo(model);
}



function addControls(overlay, model) {
    const TRANSLATION_AMOUNT = 1;
    const ROTATION_AMOUNT = Math.PI / 24;
    const SCALE_AMOUNT = 1;

    const onKeyDown = function (event) {
        switch (event.keyCode) {
            case 87: // W
                model.position.y += TRANSLATION_AMOUNT;
                break;
            case 83: // S
                model.position.y -= TRANSLATION_AMOUNT;
                break;
            case 65: // A
                model.position.x -= TRANSLATION_AMOUNT;
                break;
            case 68: // D
                model.position.x += TRANSLATION_AMOUNT;
                break;
            case 90: // Z
                model.position.z += TRANSLATION_AMOUNT;
                break;
            case 88: // X
                model.position.z -= TRANSLATION_AMOUNT;
                break;
            case 74: // J
                model.rotation.y = (model.rotation.y + ROTATION_AMOUNT) % (2 * Math.PI);
                break;
            case 76: // L
                model.rotation.y = (model.rotation.y - ROTATION_AMOUNT) % (-2 * Math.PI);
                break;
            case 73: // I
                model.rotation.x = (model.rotation.x + ROTATION_AMOUNT) % (2 * Math.PI);
                break;
            case 75: // K
                model.rotation.x = (model.rotation.x - ROTATION_AMOUNT) % (-2 * Math.PI);
                break;
            case 85: // U
                model.rotation.z = (model.rotation.z + ROTATION_AMOUNT) % (2 * Math.PI);
                break;
            case 79: // O
                model.rotation.z = (model.rotation.z - ROTATION_AMOUNT) % (-2 * Math.PI);
                break;
            case 188: // Comma
                model.scale.addScalar(-SCALE_AMOUNT);
                break;
            case 190: // Period
                model.scale.addScalar(SCALE_AMOUNT);
                break;
        }
        updateModelInfoOverlay(model, overlay);
        overlay.requestRedraw();
    };


    document.addEventListener("keydown", onKeyDown, false);
}


/**
 * Adds an event listener to the export GLTF model button
 * that will export the model
 */
function addExportButtonListener(model, overlay, animationClipList) {
    const exportBtn = document.getElementById('export_btn');
    exportBtn.addEventListener('click', function() {
        exportPositionedGLTF(model, overlay, animationClipList);
    });
}


/**
 * Adds a drag and drop listener to the map, which can open GTLF files
 */
function addDragAndDropListener(overlay, scene) {
    const loader = new GLTFLoader();

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/v1/decoders/' );
    loader.setDRACOLoader(dracoLoader);



    const onDrop = function (event) {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = function (event) {
            const data = event.target.result;
            loader.parse(data, '', function (gltf) {
                const model = gltf.scene;
                // Rotate the model a quarter-turn around the z-axis to make it so y-axis models stand up in the UI
                console.log('Rotating model');
                model.rotateX(Math.PI / 2);

                let animationClipList = null;

                // Setting up any animations
                if(gltf.animations.length > 0) {
                    console.log('GLTF has animations - adding');
                    let mixer = new THREE.AnimationMixer( gltf.scene );
                    const clock = new THREE.Clock();
                    var action = mixer.clipAction( gltf.animations[ 0 ] );
                    // Cache the animations for export
                    animationClipList = gltf.animations;
                    action.play();

                    const animate = () => {
                        mixer.update(clock.getDelta());
                        overlay.requestRedraw();
                        requestAnimationFrame(animate);
                    }
                    requestAnimationFrame(animate);
                }

                scene.add(model);


                addControls(overlay, model);

                addExportButtonListener(model, overlay, animationClipList);

                updateModelInfoOverlay(model, overlay);
                overlay.requestRedraw();
            });
        };
        reader.readAsArrayBuffer(file);
    };

    const onDragOver = function (event) {
        event.preventDefault();
    };

    window.addEventListener("drop", onDrop, false);
    window.addEventListener("dragover", onDragOver, false);
}



/**
 * Adds a listener to the update location button
 */
function addLocationUpdateListener(map, overlay) {
    // Get the input element and update button element from the DOM
    const locationInput = document.getElementById('location-input');
    const updateButton = document.getElementById('update-location-button');

    // Add a click event listener to the update button
    updateButton.addEventListener('click', function() {
        // Parse the lat and lng values from the input
        const locationString = locationInput.value;
        const [lat, lng] = locationString.split(',');

        // Create a LatLng object from the input values
        const newCenter = new google.maps.LatLng(lat.trim(), lng.trim());

        // Set the map's center to the new LatLng object
        map.setCenter(newCenter);
        overlay.setAnchor(newCenter);
    });
}


function initMap(): void {
    // Setup the key elements of the map
    const mapDiv = document.getElementById("map") as HTMLElement;
    map = new google.maps.Map(mapDiv, mapOptions);

    // Create the scene
    const scene = new THREE.Scene();


    // Add some lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambientLight);


    // Setup the overlay view
    const myOverlayView = new ThreeJSOverlayView({
        map,
        scene,
        anchor: { ...mapOptions.center, altitude: 0 },
        THREE,
    });

    addLocationUpdateListener(map, myOverlayView);
    addDragAndDropListener(myOverlayView, scene);

}

declare global {
    interface Window {
        initMap: () => void;
    }
}
window.initMap = initMap;
export { initMap };
