import { RGBAUtil } from '../../colour';
import { MaterialType, SolidMaterial } from '../../mesh';
import { getRandomID } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigUIElement } from './config_element';
import { MaterialTypeElement } from './material_type_element';

export class SolidMaterialElement extends ConfigUIElement<SolidMaterial, HTMLDivElement> {
    private _materialName: string;
    private _colourId: string;
    private _typeElement: MaterialTypeElement;

    public constructor(materialName: string, material: SolidMaterial) {
        super(material);
        this._materialName = materialName;
        this._colourId = getRandomID();

        this._typeElement = new MaterialTypeElement(MaterialType.solid);
    }

    public override registerEvents(): void {
        this._typeElement.registerEvents();

        this._typeElement.onClickChangeTypeDelegate(() => {
            this._onChangeTypeDelegate?.();
        });

        const swatchElement = UIUtil.getElementById(this._colourId) as HTMLInputElement;
        swatchElement.addEventListener('change', () => {
            const material = this.getValue();
            material.colour = RGBAUtil.fromHexString(swatchElement.value);
        });
    }

    protected override _generateInnerHTML(): string {
        const material = this.getValue();

        const subproperties: string[] = [];
        const addSubproperty = (key: string, value: string) => {
            subproperties.push(`
                <div class="subproperty">
                    <div class="subprop-key-container">
                        ${key}
                    </div>
                    <div class="subprop-value-container">
                        ${value}
                    </div>
                </div>
            `);
        };

        addSubproperty('Type', this._typeElement._generateInnerHTML());
        addSubproperty('Colour', `<input class="colour-swatch" type="color" id="${this._colourId}" value="${RGBAUtil.toHexString(material.colour)}">`);
        addSubproperty('Alpha', `${material.colour.a.toFixed(4)}`);

        return `
            <div class="subproperty-container">
                ${subproperties.join('')}
            </div>
        `;
    }

    protected override _onValueChanged(): void {
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
    }

    private _onChangeTypeDelegate?: () => void;
    public onChangeTypeDelegate(delegate: () => void) {
        this._onChangeTypeDelegate = delegate;
        return this;
    }
}
