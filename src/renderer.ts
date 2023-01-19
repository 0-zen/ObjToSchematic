import * as twgl from 'twgl.js';

import { ArcballCamera } from './camera';
import { RGBA, RGBAUtil } from './colour';
import { AppConfig } from './config';
import { DebugGeometryTemplates } from './geometry';
import { MaterialType, SolidMaterial, TexturedMaterial } from './mesh';
import { RenderBuffer } from './render_buffer';
import { ShaderManager } from './shaders';
import { Texture } from './texture';
import { ASSERT } from './util/error_util';
import { Vector3 } from './vector';
import { RenderMeshParams, RenderNextBlockMeshChunkParams, RenderNextVoxelMeshChunkParams } from './worker_types';

/* eslint-disable */
export enum MeshType {
    None,
    TriangleMesh,
    VoxelMesh,
    BlockMesh
}
/* eslint-enable */

/* eslint-disable */
enum EDebugBufferComponents {
    Wireframe,
    Normals,
    Bounds,
    Dev,
}
/* eslint-enable */

export type TextureMaterialRenderAddons = {
    texture: WebGLTexture, alpha?: WebGLTexture, useAlphaChannel?: boolean,
}

export class Renderer {
    public _gl: WebGLRenderingContext;

    private _backgroundColour: RGBA = { r: 0.125, g: 0.125, b: 0.125, a: 1.0 };
    private _atlasTexture?: WebGLTexture;

    private _atlasSize: number = 1.0;
    private _meshToUse: MeshType = MeshType.None;
    private _voxelSize: number = 1.0;
    private _gridOffset: Vector3 = new Vector3(0, 0, 0);

    private _modelsAvailable: number;

    private _materialBuffers: Map<string, {
        material: SolidMaterial | (TexturedMaterial & TextureMaterialRenderAddons)
        buffer: twgl.BufferInfo,
        numElements: number,
        materialName: string,
    }>;
    public _voxelBuffer?: twgl.BufferInfo[];
    private _blockBuffer?: twgl.BufferInfo[];
    private _debugBuffers: { [meshType: string]: { [bufferComponent: string]: RenderBuffer } };
    private _axisBuffer: RenderBuffer;

    private _isGridComponentEnabled: { [bufferComponent: string]: boolean };
    private _axesEnabled: boolean;
    private _nightVisionEnabled: boolean;

    private _gridBuffers: {
        x: { [meshType: string]: RenderBuffer };
        y: { [meshType: string]: RenderBuffer };
        z: { [meshType: string]: RenderBuffer };
    };
    private _gridEnabled: boolean;

    private static _instance: Renderer;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
        this._gl = (<HTMLCanvasElement>document.getElementById('canvas')).getContext('webgl', {
            alpha: false,
        })!;
        twgl.addExtensionsToContext(this._gl);

        this._backgroundColour = AppConfig.Get.VIEWPORT_BACKGROUND_COLOUR;

        this._modelsAvailable = 0;
        this._materialBuffers = new Map();

        this._gridBuffers = { x: {}, y: {}, z: {} };
        this._gridEnabled = false;

        this._debugBuffers = {};
        this._debugBuffers[MeshType.None] = {};
        this._debugBuffers[MeshType.TriangleMesh] = {};
        this._debugBuffers[MeshType.VoxelMesh] = {};
        this._debugBuffers[MeshType.BlockMesh] = {};

        this._isGridComponentEnabled = {};
        this._axesEnabled = false;
        this._nightVisionEnabled = true;

        this._axisBuffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(1, 0, 0), { r: 0.96, g: 0.21, b: 0.32, a: 1.0 }));
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(0, 1, 0), { r: 0.44, g: 0.64, b: 0.11, a: 1.0 }));
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(0, 0, 1), { r: 0.18, g: 0.52, b: 0.89, a: 1.0 }));
    }

    public update() {
        ArcballCamera.Get.updateCamera();
    }

    public draw() {
        this._setupScene();

        switch (this._meshToUse) {
            case MeshType.TriangleMesh:
                this._drawMesh();
                break;
            case MeshType.VoxelMesh:
                this._drawVoxelMesh();
                break;
            case MeshType.BlockMesh:
                this._drawBlockMesh();
                break;
        };

        this._drawDebug();
    }

    // /////////////////////////////////////////////////////////////////////////

    private _lightingAvailable: boolean = false;
    public setLightingAvailable(isAvailable: boolean) {
        this._lightingAvailable = isAvailable;
        if (!isAvailable) {
            this._nightVisionEnabled = true;
        }
    }

    public toggleIsGridEnabled() {
        this._gridEnabled = !this._gridEnabled;
    }

    public isGridEnabled() {
        return this._gridEnabled;
    }

    public isAxesEnabled() {
        return this._axesEnabled;
    }

    public toggleIsAxesEnabled() {
        this._axesEnabled = !this._axesEnabled;
    }

    public canToggleNightVision() {
        return this._lightingAvailable;
    }

    public toggleIsNightVisionEnabled() {
        this._nightVisionEnabled = !this._nightVisionEnabled;
        if (!this._lightingAvailable) {
            this._nightVisionEnabled = true;
        }
    }

    public isNightVisionEnabled() {
        return this._nightVisionEnabled;
    }

    public toggleIsWireframeEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Wireframe];
        this._isGridComponentEnabled[EDebugBufferComponents.Wireframe] = isEnabled;
    }

    public toggleIsNormalsEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Normals];
        this._isGridComponentEnabled[EDebugBufferComponents.Normals] = isEnabled;
    }

    public toggleIsDevDebugEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Dev];
        this._isGridComponentEnabled[EDebugBufferComponents.Dev] = isEnabled;
    }

    public clearMesh() {
        this._materialBuffers = new Map();

        this._modelsAvailable = 0;
        this.setModelToUse(MeshType.None);
    }

    public recreateMaterialBuffer(materialName: string, material: SolidMaterial | TexturedMaterial) {
        const oldBuffer = this._materialBuffers.get(materialName);
        ASSERT(oldBuffer !== undefined);
        if (material.type === MaterialType.solid) {
            this._materialBuffers.set(materialName, {
                buffer: oldBuffer.buffer,
                material: {
                    type: MaterialType.solid,
                    colour: RGBAUtil.copy(material.colour),
                    needsAttention: material.needsAttention,
                    canBeTextured: material.canBeTextured,
                },
                numElements: oldBuffer.numElements,
                materialName: materialName,
            });
        } else {
            this._materialBuffers.set(materialName, {
                buffer: oldBuffer.buffer,
                material: {
                    type: MaterialType.textured,
                    path: material.path,
                    canBeTextured: material.canBeTextured,
                    interpolation: material.interpolation,
                    extension: material.extension,
                    texture: twgl.createTexture(this._gl, {
                        src: material.path,
                        min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                    }),
                    alphaFactor: material.alphaFactor,
                    alpha: material.alphaPath ? twgl.createTexture(this._gl, {
                        src: material.alphaPath,
                        min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                    }) : undefined,
                    useAlphaChannel: material.alphaPath ? new Texture(material.path, material.alphaPath)._useAlphaChannel() : undefined,
                    needsAttention: material.needsAttention,
                },
                numElements: oldBuffer.numElements,
                materialName: materialName,
            });
        }
    }

    public updateMeshMaterialTexture(materialName: string, material: TexturedMaterial) {
        this._materialBuffers.forEach((buffer) => {
            if (buffer.materialName === materialName) {
                buffer.material = {
                    type: MaterialType.textured,
                    path: material.path,
                    interpolation: material.interpolation,
                    extension: material.extension,
                    canBeTextured: material.canBeTextured,
                    texture: twgl.createTexture(this._gl, {
                        src: material.path,
                        min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                    }),
                    alphaFactor: material.alphaFactor,
                    alpha: material.alphaPath ? twgl.createTexture(this._gl, {
                        src: material.alphaPath,
                        min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                    }) : undefined,
                    useAlphaChannel: material.alphaPath ? new Texture(material.path, material.alphaPath)._useAlphaChannel() : undefined,
                    needsAttention: material.needsAttention,
                };
                return;
            }
        });
    }


    public useMesh(params: RenderMeshParams.Output) {
        this._materialBuffers = new Map();

        for (const { material, buffer, numElements, materialName } of params.buffers) {
            if (material.type === MaterialType.solid) {
                this._materialBuffers.set(materialName, {
                    buffer: twgl.createBufferInfoFromArrays(this._gl, buffer),
                    material: material,
                    numElements: numElements,
                    materialName: materialName,
                });
            } else {
                this._materialBuffers.set(materialName, {
                    buffer: twgl.createBufferInfoFromArrays(this._gl, buffer),
                    material: {
                        canBeTextured: material.canBeTextured,
                        type: MaterialType.textured,
                        interpolation: material.interpolation,
                        extension: material.extension,
                        path: material.path,
                        texture: twgl.createTexture(this._gl, {
                            src: material.path,
                            min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                            mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                            wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                        }),
                        alphaFactor: material.alphaFactor,
                        alpha: material.alphaPath ? twgl.createTexture(this._gl, {
                            src: material.alphaPath,
                            min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                            mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                            wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                        }) : undefined,
                        useAlphaChannel: material.alphaPath ? new Texture(material.path, material.alphaPath)._useAlphaChannel() : undefined,
                        needsAttention: material.needsAttention,
                    },
                    numElements: numElements,
                    materialName: materialName,
                });
            }
        }

        this._gridBuffers.x[MeshType.TriangleMesh] = DebugGeometryTemplates.gridX(params.dimensions);
        this._gridBuffers.y[MeshType.TriangleMesh] = DebugGeometryTemplates.gridY(params.dimensions);
        this._gridBuffers.z[MeshType.TriangleMesh] = DebugGeometryTemplates.gridZ(params.dimensions);

        this._modelsAvailable = 1;
        this.setModelToUse(MeshType.TriangleMesh);
    }

    private _allVoxelChunks = false;
    public useVoxelMeshChunk(params: RenderNextVoxelMeshChunkParams.Output) {
        if (params.isFirstChunk) {
            this._voxelBuffer = [];
        }

        this._allVoxelChunks = !params.moreVoxelsToBuffer;

        this._voxelBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));
        this._voxelSize = params.voxelSize;

        if (params.isFirstChunk) {
            const voxelSize = this._voxelSize;
            const dimensions = new Vector3(0, 0, 0);
            dimensions.setFrom(params.dimensions);

            this._gridOffset = new Vector3(
                dimensions.x % 2 === 0 ? 0 : -0.5,
                dimensions.y % 2 === 0 ? 0 : -0.5,
                dimensions.z % 2 === 0 ? 0 : -0.5,
            );
            dimensions.add(1);

            this._gridBuffers.x[MeshType.VoxelMesh] = DebugGeometryTemplates.gridX(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
            this._gridBuffers.y[MeshType.VoxelMesh] = DebugGeometryTemplates.gridY(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
            this._gridBuffers.z[MeshType.VoxelMesh] = DebugGeometryTemplates.gridZ(Vector3.mulScalar(dimensions, voxelSize), voxelSize);

            this._modelsAvailable = 2;
            this.setModelToUse(MeshType.VoxelMesh);
        }
    }

    /*
    public useVoxelMesh(params: RenderNextVoxelMeshChunkParams.Output) {
        this._voxelBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));
        this._voxelSize = params.voxelSize;

        const voxelSize = this._voxelSize;
        const dimensions = new Vector3(0, 0, 0);
        dimensions.setFrom(params.dimensions);

        this._gridOffset = new Vector3(
            dimensions.x % 2 === 0 ? 0 : -0.5,
            dimensions.y % 2 === 0 ? 0 : -0.5,
            dimensions.z % 2 === 0 ? 0 : -0.5,
        );
        dimensions.add(1);

        this._gridBuffers.x[MeshType.VoxelMesh] = DebugGeometryTemplates.gridX(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
        this._gridBuffers.y[MeshType.VoxelMesh] = DebugGeometryTemplates.gridY(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
        this._gridBuffers.z[MeshType.VoxelMesh] = DebugGeometryTemplates.gridZ(Vector3.mulScalar(dimensions, voxelSize), voxelSize);

        this._modelsAvailable = 2;
        this.setModelToUse(MeshType.VoxelMesh);
    }
    */

    public useBlockMeshChunk(params: RenderNextBlockMeshChunkParams.Output) {
        if (params.isFirstChunk) {
            this._blockBuffer = [];
        }

        this._blockBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));

        if (params.isFirstChunk) {
            this._atlasTexture = twgl.createTexture(this._gl, {
                src: params.atlasTexturePath,
                mag: this._gl.NEAREST,
            });

            this._atlasSize = params.atlasSize;

            this._gridBuffers.y[MeshType.BlockMesh] = this._gridBuffers.y[MeshType.VoxelMesh];

            this._modelsAvailable = 3;
            this.setModelToUse(MeshType.BlockMesh);
        }
    }

    // /////////////////////////////////////////////////////////////////////////

    private _drawDebug() {
        /*
        const debugComponents = [EDebugBufferComponents.GridY];
        for (const debugComp of debugComponents) {
            if (this._isGridComponentEnabled[debugComp]) {
                ASSERT(this._debugBuffers[this._meshToUse]);
                const buffer = this._debugBuffers[this._meshToUse][debugComp];
                if (buffer) {
                    if (debugComp === EDebugBufferComponents.Dev) {
                        this._gl.disable(this._gl.DEPTH_TEST);
                    }
                    if (debugComp === EDebugBufferComponents.GridY && !ArcballCamera.Get.isAlignedWithAxis('y')) {
                        continue;
                    }
                    this._drawBuffer(this._gl.LINES, buffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                    this._gl.enable(this._gl.DEPTH_TEST);
                }
            }
        }
        */
        // Draw grid
        if (this._gridEnabled) {
            if (ArcballCamera.Get.isAlignedWithAxis('x') && !ArcballCamera.Get.isAlignedWithAxis('y') && !ArcballCamera.Get.isUserRotating) {
                const gridBuffer = this._gridBuffers.x[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            } else if (ArcballCamera.Get.isAlignedWithAxis('z') && !ArcballCamera.Get.isAlignedWithAxis('y') && !ArcballCamera.Get.isUserRotating) {
                const gridBuffer = this._gridBuffers.z[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            } else {
                const gridBuffer = this._gridBuffers.y[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            }
        }

        // Draw axis
        if (this._axesEnabled) {
            this._gl.disable(this._gl.DEPTH_TEST);
            this._drawBuffer(this._gl.LINES, this._axisBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            });
            this._gl.enable(this._gl.DEPTH_TEST);
        }
    }

    public parseRawMeshData(buffer: string, dimensions: Vector3) {
    }

    private _drawMesh() {
        this._materialBuffers.forEach((materialBuffer, materialName) => {
            if (materialBuffer.material.type === MaterialType.textured) {
                this._drawMeshBuffer(materialBuffer.buffer, materialBuffer.numElements, ShaderManager.Get.textureTriProgram, {
                    u_lightWorldPos: ArcballCamera.Get.getCameraPosition(-Math.PI/4, 0.0).toArray(),
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldInverseTranspose: ArcballCamera.Get.getWorldInverseTranspose(),
                    u_texture: materialBuffer.material.texture,
                    u_alpha: materialBuffer.material.alpha || materialBuffer.material.texture,
                    u_useAlphaMap: materialBuffer.material.alpha !== undefined,
                    u_useAlphaChannel: materialBuffer.material.useAlphaChannel,
                    u_alphaFactor: materialBuffer.material.alphaFactor,
                    u_cameraDir: ArcballCamera.Get.getCameraDirection().toArray(),
                    u_fresnelExponent: AppConfig.Get.FRESNEL_EXPONENT,
                    u_fresnelMix: AppConfig.Get.FRESNEL_MIX,
                });
            } else {
                this._drawMeshBuffer(materialBuffer.buffer, materialBuffer.numElements, ShaderManager.Get.solidTriProgram, {
                    u_lightWorldPos: ArcballCamera.Get.getCameraPosition(-Math.PI/4, 0.0).toArray(),
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldInverseTranspose: ArcballCamera.Get.getWorldInverseTranspose(),
                    u_fillColour: RGBAUtil.toArray(materialBuffer.material.colour),
                    u_cameraDir: ArcballCamera.Get.getCameraDirection().toArray(),
                    u_fresnelExponent: AppConfig.Get.FRESNEL_EXPONENT,
                    u_fresnelMix: AppConfig.Get.FRESNEL_MIX,
                });
            }
        });
    }

    private _drawVoxelMesh() {
        const shader = ShaderManager.Get.voxelProgram;
        const uniforms = {
            u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            u_voxelSize: this._voxelSize,
            u_gridOffset: this._gridOffset.toArray(),
            u_ambientOcclusion: this._allVoxelChunks,
        };
        this._voxelBuffer?.forEach((buffer) => {
            this._gl.useProgram(shader.program);
            twgl.setBuffersAndAttributes(this._gl, shader, buffer);
            twgl.setUniforms(shader, uniforms);
            this._gl.drawElements(this._gl.TRIANGLES, buffer.numElements, this._gl.UNSIGNED_INT, 0);
        });
    }

    private _drawBlockMesh() {
        this._gl.enable(this._gl.CULL_FACE);
        const shader = ShaderManager.Get.blockProgram;
        const uniforms = {
            u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            u_texture: this._atlasTexture,
            u_voxelSize: this._voxelSize,
            u_atlasSize: this._atlasSize,
            u_gridOffset: this._gridOffset.toArray(),
            u_nightVision: this.isNightVisionEnabled(),
        };
        this._blockBuffer?.forEach((buffer) => {
            this._gl.useProgram(shader.program);
            twgl.setBuffersAndAttributes(this._gl, shader, buffer);
            twgl.setUniforms(shader, uniforms);
            this._gl.drawElements(this._gl.TRIANGLES, buffer.numElements, this._gl.UNSIGNED_INT, 0);
        });
        this._gl.disable(this._gl.CULL_FACE);
    }

    // /////////////////////////////////////////////////////////////////////////

    private _drawMeshBuffer(register: twgl.BufferInfo, numElements: number, shaderProgram: twgl.ProgramInfo, uniforms: any) {
        this._drawBuffer(this._gl.TRIANGLES, { buffer: register, numElements: numElements }, shaderProgram, uniforms);
    }

    public setModelToUse(meshType: MeshType) {
        const isModelAvailable = this._modelsAvailable >= meshType;
        if (isModelAvailable) {
            this._meshToUse = meshType;
        }
    }

    private _setupScene() {
        twgl.resizeCanvasToDisplaySize(<HTMLCanvasElement>this._gl.canvas);
        this._gl.viewport(0, 0, this._gl.canvas.width, this._gl.canvas.height);
        ArcballCamera.Get.setAspect(this._gl.canvas.width / this._gl.canvas.height);
        this._gl.blendFuncSeparate(this._gl.SRC_ALPHA, this._gl.ONE_MINUS_SRC_ALPHA, this._gl.ONE, this._gl.ONE_MINUS_SRC_ALPHA);

        this._gl.enable(this._gl.DEPTH_TEST);
        this._gl.enable(this._gl.BLEND);
        this._gl.clearColor(this._backgroundColour.r, this._backgroundColour.g, this._backgroundColour.b, 1.0);
        this._gl.clear(this._gl.COLOR_BUFFER_BIT | this._gl.DEPTH_BUFFER_BIT);
    }

    private _drawBuffer(drawMode: number, buffer: { numElements: number, buffer: twgl.BufferInfo }, shader: twgl.ProgramInfo, uniforms: any) {
        this._gl.useProgram(shader.program);
        twgl.setBuffersAndAttributes(this._gl, shader, buffer.buffer);
        twgl.setUniforms(shader, uniforms);
        this._gl.drawElements(drawMode, buffer.numElements, this._gl.UNSIGNED_INT, 0);
    }

    public getModelsAvailable() {
        return this._modelsAvailable;
    }

    public getActiveMeshType() {
        return this._meshToUse;
    }
}
