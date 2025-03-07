import Choices from "choices.js"

import {select, StyleSheetLike} from "core/dom"
import {isString} from "core/util/types"
import * as p from "core/properties"

import * as inputs from "styles/widgets/inputs.css"
import choices_css from "styles/widgets/choices.css"

import {InputWidget, InputWidgetView} from "./input_widget"

function retarget<T extends Event>(event: T): T {
  Object.defineProperty(event, "target", {
    get: () => event.composedPath()[0] ?? null,
    configurable: true,
  })
  return event
}

class OurChoices extends Choices {
  override _onFocus(event: FocusEvent): void {
    super._onFocus(retarget(event))
  }
  override _onBlur(event: FocusEvent): void {
    super._onBlur(retarget(event))
  }
  override _onKeyUp(event: KeyboardEvent): void {
    super._onKeyUp(retarget(event))
  }
  override _onKeyDown(event: KeyboardEvent): void {
    super._onKeyDown(retarget(event))
  }
  override _onClick(event: MouseEvent): void {
    super._onClick(retarget(event))
  }
  override _onTouchEnd(event: TouchEvent): void {
    super._onTouchEnd(retarget(event))
  }
  override _onMouseDown(event: MouseEvent): void {
    super._onMouseDown(retarget(event))
  }
  override _onMouseOver(event: MouseEvent): void {
    super._onMouseOver(retarget(event))
  }
}

export class MultiChoiceView extends InputWidgetView {
  declare model: MultiChoice

  declare input_el: HTMLSelectElement
  choice_el: Choices

  override connect_signals(): void {
    super.connect_signals()
    this.connect(this.model.properties.disabled.change, () => this.set_disabled())

    const {value, max_items, option_limit, search_option_limit, delete_button, placeholder, options, name, title} = this.model.properties
    this.on_change([value, max_items, option_limit, search_option_limit, delete_button, placeholder, options, name, title], () => this.render())
  }

  override styles(): StyleSheetLike[] {
    return [...super.styles(), choices_css]
  }

  override render(): void {
    super.render()

    this.input_el = select({
      multiple: true,
      class: inputs.input,
      name: this.model.name,
      disabled: this.model.disabled,
    })

    this.group_el.appendChild(this.input_el)

    const selected = new Set(this.model.value)
    const choices = this.model.options.map((opt) => {
      let value, label
      if (isString(opt))
        value = label  = opt
      else
        [value, label] = opt
      return {value, label, selected: selected.has(value)}
    })

    const fill = this.model.solid ? "solid" : "light"
    const item = `choices__item ${fill}`
    const button = `choices__button ${fill}`

    const options: Partial<Choices["config"]> = {
      choices,
      itemSelectText: "",
      duplicateItemsAllowed: false,
      shouldSort: false,
      removeItemButton: this.model.delete_button,
      classNames: {item, button} as any, // XXX: missing typings
      placeholderValue: this.model.placeholder ?? undefined,
      maxItemCount: this.model.max_items ?? undefined,
      renderChoiceLimit: this.model.option_limit ?? undefined,
      searchResultLimit: this.model.search_option_limit ?? undefined,
    }

    this.choice_el = new OurChoices(this.input_el, options)
    this.input_el.addEventListener("change", () => this.change_input())
  }

  set_disabled(): void {
    if (this.model.disabled)
      this.choice_el.disable()
    else
      this.choice_el.enable()
  }

  override change_input(): void {
    const is_focused = this.shadow_el.querySelector("select:focus") != null

    const values = []
    for (const el of this.shadow_el.querySelectorAll("option")) {
      if (el.selected)
        values.push(el.value)
    }

    this.model.value = values
    super.change_input()
    // Restore focus back to the <select> afterwards,
    // so that even if python on_change callback is invoked,
    // focus remains on <select> and one can seamlessly scroll
    // up/down.
    if (is_focused)
      this.input_el.focus()
  }
}

export namespace MultiChoice {
  export type Attrs = p.AttrsOf<Props>

  export type Props = InputWidget.Props & {
    value: p.Property<string[]>
    options: p.Property<(string | [string, string])[]>
    max_items: p.Property<number| null>
    delete_button: p.Property<boolean>
    placeholder: p.Property<string | null>
    option_limit: p.Property<number | null>
    search_option_limit: p.Property<number | null>
    solid: p.Property<boolean>
  }
}

export interface MultiChoice extends MultiChoice.Attrs {}

export class MultiChoice extends InputWidget {
  declare properties: MultiChoice.Props
  declare __view_type__: MultiChoiceView

  constructor(attrs?: Partial<MultiChoice.Attrs>) {
    super(attrs)
  }

  static {
    this.prototype.default_view = MultiChoiceView

    this.define<MultiChoice.Props>(({Boolean, Int, String, Array, Tuple, Or, Nullable}) => ({
      value:         [ Array(String), [] ],
      options:       [ Array(Or(String, Tuple(String, String))), [] ],
      max_items:     [ Nullable(Int),  null ],
      delete_button: [ Boolean, true ],
      placeholder:   [ Nullable(String),  null ],
      option_limit:  [ Nullable(Int),  null ],
      search_option_limit:  [ Nullable(Int),  null ],
      solid:         [ Boolean, true ],
    }))
  }
}
