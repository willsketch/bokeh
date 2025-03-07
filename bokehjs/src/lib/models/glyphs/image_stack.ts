import {ImageBase, ImageBaseView, ImageDataBase} from "./image_base"
import {StackColorMapper} from "../mappers/stack_color_mapper"
import {Arrayable} from "core/types"
import * as p from "core/properties"

export type ImageStackData = ImageDataBase

export interface ImageStackView extends ImageData {}

export class ImageStackView extends ImageBaseView {
  declare model: ImageStack
  declare visuals: ImageStack.Visuals

  override connect_signals(): void {
    super.connect_signals()
    this.connect(this.model.color_mapper.change, () => this._update_image())
  }

  override get image_dimension(): number {
    return 3
  }

  protected _update_image(): void {
    // Only reset image_data if already initialized
    if (this.image_data != null) {
      this._set_data(null)
      this.renderer.request_render()
    }
  }

  protected _flat_img_to_buf8(img: Arrayable<number>, length_divisor: number): Uint8ClampedArray {
    const cmap = this.model.color_mapper.rgba_mapper
    return cmap.v_compute(img, length_divisor)
  }
}

export namespace ImageStack {
  export type Attrs = p.AttrsOf<Props>

  export type Props = ImageBase.Props & {
    color_mapper: p.Property<StackColorMapper>
  }

  export type Visuals = ImageBase.Visuals
}

export interface ImageStack extends ImageStack.Attrs {}

export class ImageStack extends ImageBase {
  declare properties: ImageStack.Props
  declare __view_type__: ImageStackView

  constructor(attrs?: Partial<ImageStack.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = ImageStackView

    this.define<ImageStack.Props>(({Ref}) => ({
      color_mapper: [ Ref(StackColorMapper) ],
    }))
  }
}
