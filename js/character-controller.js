class DexHeroController {
    constructor(containerId, modelUrl) {
        this.container = document.getElementById(containerId);
        if (!this.container) throw new Error(`Container #${containerId} not found`);
        this.modelUrl = modelUrl;

        // Core Three.js components
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        
        // Character & Animation
        this.character = null;
        this.mixer = null;
        this.animations = {}; // { idle: Action, run: Action, ... }
        this.currentAction = null;
        
        // Input & State
        this.keys = { W: false, A: false, S: false, D: false, SHIFT: false, SPACE: false };
        this.isActive = false;
        
        // Physics / Movement variables
        this.velocity = new THREE.Vector3();
        this.direction = new THREE.Vector3();
        this.walkSpeed = 3.0;
        this.runSpeed = 6.0;
        
        // Camera handling
        this.cameraOffset = new THREE.Vector3(0, 2, -5);
        this.cameraTarget = new THREE.Vector3(0, 1, 0);

        this.init();
    }

    init() {
        // 1. Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);
        this.scene.fog = new THREE.Fog(0x1a1a1a, 10, 50);

        // 2. Camera setup
        const aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
        this.camera.position.set(0, 2, -5);

        // 3. Renderer setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // 4. Lighting
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        hemiLight.position.set(0, 20, 0);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(-3, 10, -10);
        dirLight.castShadow = true;
        dirLight.shadow.camera.top = 4;
        dirLight.shadow.camera.bottom = -4;
        dirLight.shadow.camera.left = -4;
        dirLight.shadow.camera.right = 4;
        dirLight.shadow.camera.near = 0.1;
        dirLight.shadow.camera.far = 40;
        this.scene.add(dirLight);

        // 5. Ground Plane
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(100, 100),
            new THREE.MeshPhongMaterial({ color: 0x999999, depthWrite: false })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        const grid = new THREE.GridHelper(100, 40, 0x000000, 0x000000);
        grid.material.opacity = 0.2;
        grid.material.transparent = true;
        this.scene.add(grid);

        // 6. Handle Window Resize
        window.addEventListener('resize', this.onWindowResize.bind(this));

        // 7. Load Character
        this.loadCharacter();
        
        // 8. Start Loop
        this.clock = new THREE.Clock();
        this.animate();
    }

    onWindowResize() {
        if (!this.container || !this.camera || !this.renderer) return;
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    loadCharacter() {
        const loader = new THREE.GLTFLoader();
        
        // 1. First load the DexHero character model
        loader.load(this.modelUrl, (gltf) => {
            this.character = gltf.scene;
            this.character.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
            
            this.character.position.set(0, 0, 0);
            this.scene.add(this.character);
            this.mixer = new THREE.AnimationMixer(this.character);
            
            // 2. Load the external animation suite (Soldier.glb contains Idle/Run/Walk)
            this.loadAnimations(loader);
            
            console.log(' DexHero Character Loaded into WebGL');
        }, undefined, (error) => {
            console.error('Error loading DexHero character:', error);
        });
    }

    loadAnimations(loader) {
        const animUrl = '/assets/animations/Soldier.glb';
        
        loader.load(animUrl, (gltf) => {
            if (!gltf.animations || gltf.animations.length === 0) return;
            
            // Bone mapping for animation tracks (Generic Humanoid to Epic Standard or vice versa)
            const boneMap = {
                // To support original Tripo Generic Rig
                'hips': 'pelvis', 'spine': 'spine_01', 'spine1': 'spine_02', 'spine2': 'spine_03',
                'neck': 'neck_01', 'leftshoulder': 'clavicle_l', 'rightshoulder': 'clavicle_r',
                'leftarm': 'upperarm_l', 'rightarm': 'upperarm_r', 'leftforearm': 'lowerarm_l',
                'rightforearm': 'lowerarm_r', 'lefthand': 'hand_l', 'righthand': 'hand_r',
                'leftupleg': 'thigh_l', 'rightupleg': 'thigh_r', 'leftleg': 'calf_l',
                'rightleg': 'calf_r', 'leftfoot': 'foot_l', 'rightfoot': 'foot_r'
            };

            // Detect what bones the character actually has
            const characterBones = new Set();
            this.character.traverse(n => { if(n.isBone) characterBones.add(n.name.toLowerCase()); });

            gltf.animations.forEach(clip => {
                // Clone the clip so we don't modify the source asset
                const newClip = clip.clone();
                newClip.tracks.forEach(track => {
                    const parts = track.name.split('.');
                    const boneName = parts[0];
                    const property = parts[1];
                    const cleanBone = boneName.toLowerCase();

                    // If character doesn't have the animation's bone, try mapping it
                    if (!characterBones.has(cleanBone)) {
                        for (const [generic, epic] of Object.entries(boneMap)) {
                            // Map Epic track to Generic bone (anim is likely Epic, model is Generic)
                            if (cleanBone === epic && characterBones.has(generic)) {
                                track.name = `${generic}.${property}`;
                                break;
                            }
                            // Map Generic track to Epic bone (anim is Generic, model is Epic)
                            if (cleanBone === generic && characterBones.has(epic)) {
                                track.name = `${epic}.${property}`;
                                break;
                            }
                        }
                    }
                });

                const action = this.mixer.clipAction(newClip);
                if (clip.name === 'Idle') this.animations['Idle'] = action;
                if (clip.name === 'Run')  this.animations['Run']  = action;
                if (clip.name === 'Walk') this.animations['Walk'] = action;
            });
            
            this.fadeToAction('Idle', 0.5);
        });
    }

    fadeToAction(name, duration) {
        const nextAction = this.animations[name];
        if (!nextAction || this.currentAction === nextAction) return;

        if (this.currentAction) {
            this.currentAction.fadeOut(duration);
        }

        nextAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play();
        this.currentAction = nextAction;
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));
        
        const delta = this.clock.getDelta();
        if (this.mixer) this.mixer.update(delta);
        
        if (this.isActive && this.character) {
            this.updateMovement(delta);
            this.updateCamera();
        }

        this.renderer.render(this.scene, this.camera);
    }

    updateMovement(delta) {
        if (!this.isActive || !this.character) return;

        // Reset movement vector
        this.direction.set(0, 0, 0);

        if (this.keys.W) this.direction.z += 1; // Forward relative to camera
        if (this.keys.S) this.direction.z -= 1; // Backward
        if (this.keys.A) this.direction.x += 1; // Left
        if (this.keys.D) this.direction.x -= 1; // Right

        if (this.direction.lengthSq() > 0) {
            this.direction.normalize();

            // Calculate movement direction relative to camera angle
            const angleYCameraDirection = Math.atan2(
                (this.camera.position.x - this.character.position.x), 
                (this.camera.position.z - this.character.position.z)
            );
            
            // Offset character rotation angle based on input (W = 0, S = PI, A = PI/2, D = -PI/2)
            const directionOffset = this.directionOffset(this.keys);

            // Rotate character mesh smoothly towards movement trajectory
            const targetRotation = angleYCameraDirection + directionOffset;
            const currentRotation = this.character.rotation.y;
            
            // Lerp rotation for smooth turning
            const rotateSpeed = 10 * delta;
            // Handle angle wrap-around for smooth 360 rotation
            let diff = targetRotation - currentRotation;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.character.rotation.y += diff * rotateSpeed;

            // Apply movement velocity
            const speed = this.keys.SHIFT ? this.runSpeed : this.walkSpeed;
            
            // Calculate actual velocity vector based on character's new forward facing dir
            this.velocity.x = Math.sin(this.character.rotation.y) * speed * delta;
            this.velocity.z = Math.cos(this.character.rotation.y) * speed * delta;
            
            this.character.position.add(this.velocity);
        }
    }

    directionOffset(keys) {
        let directionOffset = 0; // w
        if (keys.W) {
            if (keys.A) directionOffset = Math.PI / 4; // w+a
            else if (keys.D) directionOffset = -Math.PI / 4; // w+d
        } else if (keys.S) {
            if (keys.A) directionOffset = Math.PI / 4 + Math.PI / 2; // s+a
            else if (keys.D) directionOffset = -Math.PI / 4 - Math.PI / 2; // s+d
            else directionOffset = Math.PI; // s
        } else if (keys.A) {
            directionOffset = Math.PI / 2; // a
        } else if (keys.D) {
            directionOffset = -Math.PI / 2; // d
        }
        return directionOffset;
    }

    updateCamera() {
        if (!this.isActive || !this.character) return;
        
        // Target where the camera should look (chest height)
        this.cameraTarget.copy(this.character.position);
        this.cameraTarget.y += 1.5;
        
        // Calculate where the camera should trail behind the character
        // For 3rd person, we want the camera offset to be behind (-Z) and up (+Y)
        // relative to the active camera angle (NOT character rotation, to allow free look)
        // For simplicity right now, strict trailing camera behind the character model:
        const idealOffset = new THREE.Vector3(0, 2, -4);
        idealOffset.applyQuaternion(this.character.quaternion);
        idealOffset.add(this.character.position);
        
        // Smoothly interpolate camera position
        this.camera.position.lerp(idealOffset, 0.1);
        this.camera.lookAt(this.cameraTarget);
    }

    activate() {
        this.isActive = true;
        document.addEventListener('keydown', this.handleKeyDown);
        document.addEventListener('keyup', this.handleKeyUp);
    }

    deactivate() {
        this.isActive = false;
        document.removeEventListener('keydown', this.handleKeyDown);
        document.removeEventListener('keyup', this.handleKeyUp);
        this.keys = { W: false, A: false, S: false, D: false, SHIFT: false, SPACE: false };
        this.updateAnimationState();
    }

    dispose() {
        this.deactivate();
        if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
        if (this.mixer) this.mixer.stopAllAction();
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
        if (this.scene) {
            this.scene.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                    else obj.material.dispose();
                }
            });
        }
    }

    // Bound handlers to preserve 'this' context while allowing removal
    handleKeyDown = (e) => this.onKeyDown(e);
    handleKeyUp = (e) => this.onKeyUp(e);

    onKeyDown(e) {
        let changed = false;
        switch(e.code) {
            case 'KeyW': if(!this.keys.W) { this.keys.W = true; changed = true; } break;
            case 'KeyA': if(!this.keys.A) { this.keys.A = true; changed = true; } break;
            case 'KeyS': if(!this.keys.S) { this.keys.S = true; changed = true; } break;
            case 'KeyD': if(!this.keys.D) { this.keys.D = true; changed = true; } break;
            case 'ShiftLeft': if(!this.keys.SHIFT) { this.keys.SHIFT = true; changed = true; } break;
            case 'Space': if(!this.keys.SPACE) { this.keys.SPACE = true; changed = true; } break;
        }
        if (changed) this.updateAnimationState();
    }

    onKeyUp(e) {
        let changed = false;
        switch(e.code) {
            case 'KeyW': if(this.keys.W) { this.keys.W = false; changed = true; } break;
            case 'KeyA': if(this.keys.A) { this.keys.A = false; changed = true; } break;
            case 'KeyS': if(this.keys.S) { this.keys.S = false; changed = true; } break;
            case 'KeyD': if(this.keys.D) { this.keys.D = false; changed = true; } break;
            case 'ShiftLeft': if(this.keys.SHIFT) { this.keys.SHIFT = false; changed = true; } break;
            case 'Space': if(this.keys.SPACE) { this.keys.SPACE = false; changed = true; } break;
        }
        if (changed) this.updateAnimationState();
    }

    updateAnimationState() {
        const isMoving = this.keys.W || this.keys.A || this.keys.S || this.keys.D;
        
        if (isMoving) {
            if (this.keys.SHIFT && this.animations['Run']) {
                this.fadeToAction('Run', 0.2);
            } else if (this.animations['Walk']) {
                this.fadeToAction('Walk', 0.2);
            } else if (this.animations['Run']) {
                 // Fallback to run if no walk
                this.fadeToAction('Run', 0.2);
            }
        } else {
            if (this.animations['Idle']) {
                this.fadeToAction('Idle', 0.2);
            }
        }
    }
}

window.DexHeroController = DexHeroController;
