export type OmniboxOperator =
  | 'tag'
  | 'type'
  | 'time'
  | 'link'
  | 'similar'
  | 'not'
  | 'degree'
  | 'describe';

export type OmniboxTokenKind = 'text' | 'operator';

export interface OmniboxToken {
  id: string;
  kind: OmniboxTokenKind;
  raw: string;
  value: string;
  operator?: OmniboxOperator;
}

export interface OmniboxOptions {
  placeholder?: string;
  onChange?: (tokens: OmniboxToken[]) => void;
}

const OPERATORS: OmniboxOperator[] = [
  'tag',
  'type',
  'time',
  'link',
  'similar',
  'not',
  'degree',
  'describe',
];

export class Omnibox {
  private host: HTMLElement;
  private rootEl: HTMLElement;
  private trackEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private tokens: OmniboxToken[] = [];
  private pillById: Map<string, HTMLElement> = new Map();
  private onChange?: (tokens: OmniboxToken[]) => void;
  private readonly operatorSet = new Set<OmniboxOperator>(OPERATORS);
  private handleRootClick = () => {
    this.inputEl.focus();
  };

  constructor(host: HTMLElement, options: OmniboxOptions = {}) {
    this.host = host;
    this.onChange = options.onChange;

    this.rootEl = document.createElement('div');
    this.rootEl.classList.add('smart-omnibox');
    this.host.appendChild(this.rootEl);

    this.trackEl = document.createElement('div');
    this.trackEl.classList.add('smart-omnibox-track');
    this.rootEl.appendChild(this.trackEl);

    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.placeholder = options.placeholder ?? 'Filter by keyword or operator...';
    this.inputEl.classList.add('smart-omnibox-input');
    this.trackEl.appendChild(this.inputEl);

    this.bindEvents();
  }

  getTokens(): OmniboxToken[] {
    return [...this.tokens];
  }

  focus() {
    this.inputEl.focus();
  }

  destroy() {
    this.inputEl.removeEventListener('keydown', this.handleKeyDown);
    this.inputEl.removeEventListener('blur', this.handleBlur);
    this.inputEl.removeEventListener('paste', this.handlePaste);
    this.rootEl.removeEventListener('click', this.handleRootClick);
    if (this.rootEl.parentElement === this.host) {
      this.host.removeChild(this.rootEl);
    } else {
      this.rootEl.remove();
    }
    this.pillById.clear();
    this.tokens = [];
  }

  private bindEvents() {
    this.inputEl.addEventListener('keydown', this.handleKeyDown);
    this.inputEl.addEventListener('blur', this.handleBlur);
    this.inputEl.addEventListener('paste', this.handlePaste);
    this.rootEl.addEventListener('click', this.handleRootClick);
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',') {
      if (this.commitInputValue()) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === 'Backspace' && this.inputEl.value === '') {
      const lastToken = this.tokens[this.tokens.length - 1];
      if (lastToken) {
        event.preventDefault();
        const removed = this.removeToken(lastToken.id);
        if (removed) {
          this.inputEl.value = this.formatTokenForEditing(removed);
          this.inputEl.focus();
        }
      }
    }
  };

  private handleBlur = () => {
    this.commitInputValue();
  };

  private handlePaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text');
    if (!text) {
      return;
    }
    this.commitRawValue(text);
  };

  private commitInputValue(): boolean {
    const value = this.inputEl.value.trim();
    if (!value) {
      this.inputEl.value = '';
      return false;
    }

    this.commitRawValue(value);
    this.inputEl.value = '';
    return true;
  }

  private commitRawValue(value: string) {
    const parts = value
      .split(/[\n,]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    parts.forEach((part) => {
      const token = this.createToken(part);
      if (token) {
        this.tokens.push(token);
        this.renderToken(token);
      }
    });

    if (parts.length > 0) {
      this.emitChange();
    }
  }

  private createToken(rawValue: string): OmniboxToken | null {
    if (!rawValue) {
      return null;
    }

    const cleaned = this.stripQuotes(rawValue.trim());
    let operator: OmniboxOperator | undefined;
    let value = cleaned;

    const colonIndex = cleaned.indexOf(':');
    if (colonIndex !== -1) {
      const potentialOperator = cleaned.slice(0, colonIndex).toLowerCase() as OmniboxOperator;
      if (this.operatorSet.has(potentialOperator)) {
        operator = potentialOperator;
        value = cleaned.slice(colonIndex + 1).trim();
        value = this.stripQuotes(value);
      }
    } else if (this.operatorSet.has(cleaned.toLowerCase() as OmniboxOperator)) {
      operator = cleaned.toLowerCase() as OmniboxOperator;
      value = '';
    }

    return {
      id: this.generateId(),
      kind: operator ? 'operator' : 'text',
      raw: cleaned,
      value: operator ? value : cleaned,
      operator,
    };
  }

  private renderToken(token: OmniboxToken) {
    const pill = document.createElement('span');
    pill.classList.add('smart-omnibox-pill');
    if (token.kind === 'operator') {
      pill.classList.add('is-operator');
      if (token.operator) {
        pill.dataset.operator = token.operator;
      }
    }

    const label = document.createElement('span');
    label.classList.add('smart-omnibox-pill-label');
    label.textContent = this.formatTokenLabel(token);
    pill.appendChild(label);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.classList.add('smart-omnibox-pill-remove');
    removeButton.ariaLabel = 'Remove filter';
    removeButton.textContent = 'x';
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.removeToken(token.id);
    });
    pill.appendChild(removeButton);

    pill.addEventListener('click', () => {
      const removed = this.removeToken(token.id);
      if (removed) {
        this.inputEl.value = this.formatTokenForEditing(removed);
        this.inputEl.focus();
      }
    });

    this.trackEl.insertBefore(pill, this.inputEl);
    this.pillById.set(token.id, pill);
  }

  private removeToken(id: string): OmniboxToken | null {
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index === -1) {
      return null;
    }

    const [removed] = this.tokens.splice(index, 1);
    const pill = this.pillById.get(id);
    if (pill) {
      pill.remove();
      this.pillById.delete(id);
    }

    this.emitChange();
    return removed;
  }

  private emitChange() {
    if (this.onChange) {
      this.onChange(this.getTokens());
    }
  }

  private stripQuotes(value: string): string {
    if (value.length < 2) {
      return value;
    }
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1);
    }
    return value;
  }

  private formatTokenLabel(token: OmniboxToken): string {
    if (token.kind === 'operator' && token.operator) {
      return token.value ? `${token.operator}: ${token.value}` : `${token.operator}:`;
    }
    return token.value;
  }

  private formatTokenForEditing(token: OmniboxToken): string {
    if (token.kind === 'operator' && token.operator) {
      return token.value ? `${token.operator}: ${token.value}` : `${token.operator}: `;
    }
    return token.value;
  }

  private generateId(): string {
    return `token-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
}
