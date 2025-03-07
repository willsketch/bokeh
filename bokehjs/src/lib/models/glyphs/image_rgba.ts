import {ImageBase, ImageBaseView, ImageDataBase} from "./image_base"
import {Arrayable, TypedArray} from "core/types"
import {isArray} from "core/util/types"
import * as p from "core/properties"

export type ImageRGBAData = ImageDataBase

export interface ImageRGBAView extends ImageRGBAData {}

export class ImageRGBAView extends ImageBaseView {
  declare model: ImageRGBA
  declare visuals: ImageRGBA.Visuals

  protected _flat_img_to_buf8(img: Arrayable<number>, _length_divisor: number): Uint8ClampedArray {
    let array: TypedArray
    if (isArray(img)) {
      array = new Uint32Array(img)
    } else {
      array = img as TypedArray
    }
    return new Uint8ClampedArray(array.buffer)
  }
}

export namespace ImageRGBA {
  export type Attrs = p.AttrsOf<Props>

  export type Props = ImageBase.Props

  export type Visuals = ImageBase.Visuals
}

export interface ImageRGBA extends ImageRGBA.Attrs {}

export class ImageRGBA extends ImageBase {
  declare properties: ImageRGBA.Props
  declare __view_type__: ImageRGBAView

  constructor(attrs?: Partial<ImageRGBA.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = ImageRGBAView
  }
}
