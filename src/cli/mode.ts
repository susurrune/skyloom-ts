/**
 * Interactive mode controller — single source of truth for plan/auto/default.
 */

export enum InteractiveMode {
  DEFAULT = 'default',
  PLAN = 'plan',
  AUTO = 'auto',
}

const CYCLE: InteractiveMode[] = [
  InteractiveMode.DEFAULT,
  InteractiveMode.PLAN,
  InteractiveMode.AUTO,
];

const LABEL_STYLE: Record<InteractiveMode, [string, string]> = {
  [InteractiveMode.DEFAULT]: ['DEFAULT', 'bold cyan'],
  [InteractiveMode.PLAN]: ['PLAN', 'bold magenta'],
  [InteractiveMode.AUTO]: ['AUTO', 'bold yellow'],
};

const DESCRIPTIONS: Record<InteractiveMode, string> = {
  [InteractiveMode.DEFAULT]: 'smart — router picks the right depth per message',
  [InteractiveMode.PLAN]: 'plan first, confirm before execute',
  [InteractiveMode.AUTO]: 'autonomous reasoning & execution',
};

export class ModeController {
  private _mode: InteractiveMode | null = null;

  get current(): InteractiveMode {
    if (this._mode === null) {
      this._mode = InteractiveMode.DEFAULT;
    }
    return this._mode;
  }

  set(mode: InteractiveMode): InteractiveMode {
    this._mode = mode;
    return mode;
  }

  cycle(): InteractiveMode {
    const cur = this.current;
    const idx = CYCLE.indexOf(cur);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    return this.set(next);
  }

  label(): [string, string] {
    return LABEL_STYLE[this.current];
  }

  describe(): string {
    return DESCRIPTIONS[this.current];
  }
}
