import System from '../System';

import RenderTexture from '../renderTexture/RenderTexture';
import Quad from '../utils/Quad';
import QuadUv from '../utils/QuadUv';
import { Rectangle, Matrix } from '@pixi/math';
import { nextPow2 } from '@pixi/utils';
import UniformGroup from '../shader/UniformGroup';
import { DRAW_MODES } from '@pixi/constants';

/**
 * System plugin to the renderer to manage filter states.
 *
 * @class
 * @private
 */
class FilterState
{
    constructor()
    {
        this.renderTexture = null;

        /**
         * Target of the filters
         * We store for case when custom filter wants to know the element it was applied on
         * @member {PIXI.DisplayObject}
         * @private
         */
        this.target = null;

        /**
         * Compatibility with PixiJS v4 filters
         * @member {boolean}
         * @default false
         * @private
         */
        this.legacy = false;

        /**
         * Resolution of filters
         * @member {number}
         * @default 1
         * @private
         */
        this.resolution = 1;

        // next three fields are created only for root
        // re-assigned for everything else

        /**
         * Source frame
         * @member {PIXI.Rectangle}
         * @private
         */
        this.sourceFrame = new Rectangle();

        /**
         * Destination frame
         * @member {PIXI.Rectangle}
         * @private
         */
        this.destinationFrame = new Rectangle();

        /**
         * Collection of filters
         * @member {PIXI.Filter[]}
         * @private
         */
        this.filters = [];
    }

    /**
     * clears the state
     * @private
     */
    clear()
    {
        this.target = null;
        this.filters = null;
        this.renderTexture = null;
    }
}

const screenKey = 'screen';

/**
 * System plugin to the renderer to manage the filters.
 *
 * @class
 * @memberof PIXI.systems
 * @extends PIXI.System
 */
export default class FilterSystem extends System
{
    /**
     * @param {PIXI.Renderer} renderer - The renderer this System works for.
     */
    constructor(renderer)
    {
        super(renderer);

        /**
         * List of filters for the FilterSystem
         * @member {Object[]}
         * @readonly
         */
        this.defaultFilterStack = [{}];

        /**
         * stores a bunch of PO2 textures used for filtering
         * @member {Object}
         */
        this.texturePool = {};

        /**
         * a pool for storing filter states, save us creating new ones each tick
         * @member {Object[]}
         */
        this.statePool = [];

        /**
         * A very simple geometry used when drawing a filter effect to the screen
         * @member {PIXI.Quad}
         */
        this.quad = new Quad();

        /**
         * Quad UVs
         * @member {PIXI.QuadUv}
         */
        this.quadUv = new QuadUv();

        /**
         * Temporary rect for maths
         * @type {PIXI.Rectangle}
         */
        this.tempRect = new Rectangle();

        /**
         * Active state
         * @member {object}
         */
        this.activeState = {};

        /**
         * This uniform group is attached to filter uniforms when used
         * @member {PIXI.UniformGroup}
         * @property {PIXI.Rectangle} outputFrame
         * @property {Float32Array} inputSize
         * @property {Float32Array} inputPixel
         * @property {Float32Array} inputClamp
         * @property {Number} resolution
         * @property {Float32Array} filterArea
         * @property {Fload32Array} filterClamp
         */
        this.globalUniforms = new UniformGroup({
            outputFrame: this.tempRect,
            inputSize: new Float32Array(4),
            inputPixel: new Float32Array(4),
            inputClamp: new Float32Array(4),
            resolution: 1,

            // legacy variables
            filterArea: new Float32Array(4),
            filterClamp: new Float32Array(4),
        }, true);

        this._pixelsWidth = renderer.view.width;
        this._pixelsHeight = renderer.view.height;
    }

    /**
     * Adds a new filter to the System.
     *
     * @param {PIXI.DisplayObject} target - The target of the filter to render.
     * @param {PIXI.Filter[]} filters - The filters to apply.
     */
    push(target, filters)
    {
        const renderer = this.renderer;
        const filterStack = this.defaultFilterStack;
        const state = this.statePool.pop() || new FilterState();

        let resolution = filters[0].resolution;
        let padding = filters[0].padding;
        let autoFit = filters[0].autoFit;
        let legacy = filters[0].legacy;

        for (let i = 1; i < filters.length; i++)
        {
            const filter =  filters[i];

            // lets use the lowest resolution..
            resolution = Math.min(resolution, filter.resolution);
            // and the largest amount of padding!
            padding = Math.max(padding, filter.padding);
            // only auto fit if all filters are autofit
            autoFit = autoFit || filter.autoFit;

            legacy = legacy || filter.legacy;
        }

        if (filterStack.length === 1)
        {
            this.defaultFilterStack[0].renderTexture = renderer.renderTexture.current;
        }

        filterStack.push(state);

        state.resolution = resolution;

        state.legacy = legacy;

        state.target = target;

        state.sourceFrame.copyFrom(target.filterArea || target.getBounds(true));

        state.sourceFrame.pad(padding);
        if (autoFit)
        {
            state.sourceFrame.fit(this.renderer.renderTexture.sourceFrame);
        }

        // round to whole number based on resolution
        state.sourceFrame.ceil(resolution);

        state.renderTexture = this.getOptimalFilterTexture(state.sourceFrame.width, state.sourceFrame.height, resolution);
        state.filters = filters;

        state.destinationFrame.width = state.renderTexture.width;
        state.destinationFrame.height = state.renderTexture.height;

        state.renderTexture.filterFrame = state.sourceFrame;

        renderer.renderTexture.bind(state.renderTexture, state.sourceFrame);// /, state.destinationFrame);
        renderer.renderTexture.clear();
    }

    /**
     * Pops off the filter and applies it.
     *
     */
    pop()
    {
        const filterStack = this.defaultFilterStack;
        const state = filterStack.pop();
        const filters = state.filters;

        this.activeState = state;

        const globalUniforms = this.globalUniforms.uniforms;

        globalUniforms.outputFrame = state.sourceFrame;
        globalUniforms.resolution = state.resolution;

        const inputSize = globalUniforms.inputSize;
        const inputPixel = globalUniforms.inputPixel;
        const inputClamp = globalUniforms.inputClamp;

        inputSize[0] = state.destinationFrame.width;
        inputSize[1] = state.destinationFrame.height;
        inputSize[2] = 1.0 / inputSize[0];
        inputSize[3] = 1.0 / inputSize[1];

        inputPixel[0] = inputSize[0] * state.resolution;
        inputPixel[1] = inputSize[1] * state.resolution;
        inputPixel[2] = 1.0 / inputPixel[0];
        inputPixel[3] = 1.0 / inputPixel[1];

        inputClamp[0] = 0.5 * inputPixel[2];
        inputClamp[1] = 0.5 * inputPixel[3];
        inputClamp[2] = (state.sourceFrame.width * inputSize[2]) - (0.5 * inputPixel[2]);
        inputClamp[3] = (state.sourceFrame.height * inputSize[3]) - (0.5 * inputPixel[3]);

        // only update the rect if its legacy..
        if (state.legacy)
        {
            const filterArea = globalUniforms.filterArea;

            filterArea[0] = state.destinationFrame.width;
            filterArea[1] = state.destinationFrame.height;
            filterArea[2] = state.sourceFrame.x;
            filterArea[3] = state.sourceFrame.y;

            globalUniforms.filterClamp = globalUniforms.inputClamp;
        }

        this.globalUniforms.update();

        const lastState = filterStack[filterStack.length - 1];

        if (filters.length === 1)
        {
            filters[0].apply(this, state.renderTexture, lastState.renderTexture, false, state);

            this.returnFilterTexture(state.renderTexture);
        }
        else
        {
            let flip = state.renderTexture;
            let flop = this.getOptimalFilterTexture(
                flip.width,
                flip.height,
                state.resolution
            );

            flop.filterFrame = flip.filterFrame;

            let i = 0;

            for (i = 0; i < filters.length - 1; ++i)
            {
                filters[i].apply(this, flip, flop, true, state);

                const t = flip;

                flip = flop;
                flop = t;
            }

            filters[i].apply(this, flip, lastState.renderTexture, false, state);

            this.returnFilterTexture(flip);
            this.returnFilterTexture(flop);
        }

        state.clear();
        this.statePool.push(state);
    }

    /**
     * Draws a filter.
     *
     * @param {PIXI.Filter} filter - The filter to draw.
     * @param {PIXI.RenderTexture} input - The input render target.
     * @param {PIXI.RenderTexture} output - The target to output to.
     * @param {boolean} clear - Should the output be cleared before rendering to it
     */
    applyFilter(filter, input, output, clear)
    {
        const renderer = this.renderer;

        renderer.renderTexture.bind(output, output ? output.filterFrame : null);

        if (clear)
        {
            // gl.disable(gl.SCISSOR_TEST);
            renderer.renderTexture.clear();
            // gl.enable(gl.SCISSOR_TEST);
        }

        // set the uniforms..
        filter.uniforms.uSampler = input;
        filter.uniforms.filterGlobals = this.globalUniforms;

        // TODO make it so that the order of this does not matter..
        // because it does at the moment cos of global uniforms.
        // they need to get resynced

        renderer.state.setState(filter.state);
        renderer.shader.bind(filter);

        if (filter.legacy)
        {
            this.quadUv.map(input._frame, input.filterFrame);

            renderer.geometry.bind(this.quadUv);
            renderer.geometry.draw(DRAW_MODES.TRIANGLES);
        }
        else
        {
            renderer.geometry.bind(this.quad);
            renderer.geometry.draw(DRAW_MODES.TRIANGLE_STRIP);
        }
    }

    /**
     * Multiply _input normalized coordinates_ to this matrix to get _sprite texture normalized coordinates_.
     *
     * Use `outputMatrix * vTextureCoord` in the shader.
     *
     * @param {PIXI.Matrix} outputMatrix - The matrix to output to.
     * @param {PIXI.Sprite} sprite - The sprite to map to.
     * @return {PIXI.Matrix} The mapped matrix.
     */
    calculateSpriteMatrix(outputMatrix, sprite)
    {
        const { sourceFrame, destinationFrame } = this.activeState;
        const { orig } = sprite._texture;
        const mappedMatrix = outputMatrix.set(destinationFrame.width, 0, 0,
            destinationFrame.height, sourceFrame.x, sourceFrame.y);
        const worldTransform = sprite.worldTransform.copyTo(Matrix.TEMP_MATRIX);

        worldTransform.invert();
        mappedMatrix.prepend(worldTransform);
        mappedMatrix.scale(1.0 / orig.width, 1.0 / orig.height);
        mappedMatrix.translate(sprite.anchor.x, sprite.anchor.y);

        return mappedMatrix;
    }

    /**
     * Destroys this Filter System.
     *
     * @param {boolean} [contextLost=false] context was lost, do not free shaders
     *
     */
    destroy(contextLost = false)
    {
        if (!contextLost)
        {
            this.emptyPool();
        }
        else
        {
            this.texturePool = {};
        }
    }

    /**
     * Gets a Power-of-Two render texture or fullScreen texture
     *
     * TODO move to a separate class could be on renderer?
     *
     * @protected
     * @param {number} minWidth - The minimum width of the render texture in real pixels.
     * @param {number} minHeight - The minimum height of the render texture in real pixels.
     * @param {number} [resolution=1] - The resolution of the render texture.
     * @return {PIXI.RenderTexture} The new render texture.
     */
    getOptimalFilterTexture(minWidth, minHeight, resolution = 1)
    {
        let key = screenKey;

        minWidth *= resolution;
        minHeight *= resolution;

        if (minWidth !== this._pixelsWidth || minHeight !== this._pixelsHeight)
        {
            minWidth = nextPow2(minWidth);
            minHeight = nextPow2(minHeight);
            key = ((minWidth & 0xFFFF) << 16) | (minHeight & 0xFFFF);
        }

        if (!this.texturePool[key])
        {
            this.texturePool[key] = [];
        }

        let renderTexture = this.texturePool[key].pop();

        if (!renderTexture)
        {
            renderTexture = RenderTexture.create({
                width: minWidth,
                height: minHeight,
            });
        }

        renderTexture.filterPoolKey = key;
        renderTexture.setResolution(resolution);

        return renderTexture;
    }

    /**
     * Gets extra render texture to use inside current filter
     *
     * @param {number} resolution resolution of the renderTexture
     * @returns {PIXI.RenderTexture}
     */
    getFilterTexture(resolution)
    {
        const rt = this.activeState.renderTexture;

        const filterTexture = this.getOptimalFilterTexture(rt.width, rt.height, resolution || rt.baseTexture.resolution);

        filterTexture.filterFrame = rt.filterFrame;

        return filterTexture;
    }

    /**
     * Frees a render texture back into the pool.
     *
     * @param {PIXI.RenderTexture} renderTexture - The renderTarget to free
     */
    returnFilterTexture(renderTexture)
    {
        const key = renderTexture.filterPoolKey;

        renderTexture.filterFrame = null;
        this.texturePool[key].push(renderTexture);
    }

    /**
     * Empties the texture pool.
     *
     */
    emptyPool()
    {
        for (const i in this.texturePool)
        {
            const textures = this.texturePool[i];

            if (textures)
            {
                for (let j = 0; j < textures.length; j++)
                {
                    textures[j].destroy(true);
                }
            }
        }

        this.texturePool = {};
    }

    resize()
    {
        const textures = this.texturePool[screenKey];

        if (textures)
        {
            for (let j = 0; j < textures.length; j++)
            {
                textures[j].destroy(true);
            }
        }
        this.texturePool[screenKey] = [];

        this._pixelsWidth = this.renderer.view.width;
        this._pixelsHeight = this.renderer.view.height;
    }
}
