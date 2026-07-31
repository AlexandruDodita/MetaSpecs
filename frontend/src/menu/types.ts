export interface MenuContext {
  layer: Layer
  x: number
  y: number
  nodeId?: string
  edgeId?: string
}

export type Layer = 'backend' | 'db' | 'frontend'

export abstract class MenuItemBase {
  label: string
  icon?: string

  constructor(label: string, icon?: string) {
    this.label = label
    this.icon = icon
  }
}

export class MenuAction extends MenuItemBase {
  run: () => void
  danger: boolean

  constructor(
    label: string,
    run: () => void,
    icon?: string,
    danger = false,
  ) {
    super(label, icon)
    this.run = run
    this.danger = danger
  }
}

export class MenuSubmenu extends MenuItemBase {
  children: MenuItem[]

  constructor(
    label: string,
    children: MenuItem[],
    icon?: string,
  ) {
    super(label, icon)
    this.children = children
  }
}

export class MenuSeparator extends MenuItemBase {
  constructor() {
    super('---')
  }
}

export type MenuItem = MenuAction | MenuSubmenu | MenuSeparator
