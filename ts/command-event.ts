export class CommandEvent extends CustomEvent {
  keyBindingAborted: boolean = false;
  propagationStopped: boolean = false;

  abortKeyBinding(): void {
    this.stopImmediatePropagation();
    this.keyBindingAborted = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
    super.stopPropagation();
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    super.stopImmediatePropagation();
  }
}


