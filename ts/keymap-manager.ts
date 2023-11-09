import * as fs from 'fs-plus';
import { isSelectorValid } from 'clear-cut';
import * as path from 'path';
import { Emitter, Disposable, CompositeDisposable } from 'event-kit';
import { KeyBinding, MATCH_TYPES } from './key-binding';
import CommandEvent from './command-event';
import {
    normalizeKeystrokes,
    keystrokeForKeyboardEvent,
    isBareModifier,
    keydownEvent,
    keyupEvent,
    characterForKeyboardEvent,
    keystrokesMatch,
    isKeyup,
} from './helpers';
import PartialKeyupMatcher from './partial-keyup-matcher';

const Platforms = ['darwin', 'freebsd', 'linux', 'sunos', 'win32'];
const OtherPlatforms = Platforms.filter((platform) => platform !== process.platform);

export default class KeymapManager {
    static buildKeydownEvent(key: string, options: any) {
        return keydownEvent(key, options);
    }

    static buildKeyupEvent(key: string, options: any) {
        return keyupEvent(key, options);
    }

    partialMatchTimeout: number = 1000;
    defaultTarget: any = null;
    pendingPartialMatches: any = null;
    pendingStateTimeoutHandle: any = null;
    pendingKeyupMatcher: PartialKeyupMatcher = new PartialKeyupMatcher();

    constructor(options: any = {}) {
        for (const [key, value] of Object.entries(options)) {
            this[key] = value;
        }
        this.watchSubscriptions = {};
        this.customKeystrokeResolvers = [];
        this.clear();
    }

    clear() {
        this.emitter = new Emitter();
        this.keyBindings = [];
        this.queuedKeyboardEvents = [];
        this.queuedKeystrokes = [];
        this.bindingsToDisable = [];
    }

    destroy() {
        for (const [filePath, subscription] of Object.entries(this.watchSubscriptions)) {
            subscription.dispose();
        }
    }

    onDidMatchBinding(callback: any) {
        this.emitter.on('did-match-binding', callback);
    }

    onDidPartiallyMatchBindings(callback: any) {
        this.emitter.on('did-partially-match-binding', callback);
    }

    onDidFailToMatchBinding(callback: any) {
        this.emitter.on('did-fail-to-match-binding', callback);
    }

    onDidReloadKeymap(callback: any) {
        this.emitter.on('did-reload-keymap', callback);
    }

    onDidUnloadKeymap(callback: any) {
        this.emitter.on('did-unload-keymap', callback);
    }

    onDidFailToReadFile(callback: any) {
        this.emitter.on('did-fail-to-read-file', callback);
    }

    build(source: string, keyBindingsBySelector: any, priority: number = 0, throwOnInvalidSelector: boolean = true) {
        const bindings = [];
        for (const [selector, keyBindings] of Object.entries(keyBindingsBySelector)) {
            if (throwOnInvalidSelector && !isSelectorValid(selector.replace(/!important/g, ''))) {
                console.warn(`Encountered an invalid selector adding key bindings from '${source}': '${selector}'`);
                continue;
            }
            if (typeof keyBindings !== 'object') {
                console.warn(`Encountered an invalid key binding when adding key bindings from '${source}' '${keyBindings}'`);
                continue;
            }
            for (const [keystrokes, command] of Object.entries(keyBindings)) {
                const commandString = command?.toString?.() ?? '';
                if (commandString.length === 0) {
                    console.warn(`Empty command for binding: \`${selector}\` \`${keystrokes}\` in ${source}`);
                    continue;
                }
                const normalizedKeystrokes = normalizeKeystrokes(keystrokes);
                if (normalizedKeystrokes) {
                    bindings.push(new KeyBinding(source, commandString, normalizedKeystrokes, selector, priority));
                } else {
                    console.warn(`Invalid keystroke sequence for binding: \`${keystrokes}: ${commandString}\` in ${source}`);
                }
            }
        }
        return bindings;
    }

    add(source: string, keyBindingsBySelector: any, priority: number = 0, throwOnInvalidSelector: boolean = true) {
        const addedKeyBindings = this.build(source, keyBindingsBySelector, priority, throwOnInvalidSelector);
        this.keyBindings.push(...addedKeyBindings);
        return new Disposable(() => {
            for (const keyBinding of addedKeyBindings) {
                const index = this.keyBindings.indexOf(keyBinding);
                if (index !== -1) {
                    this.keyBindings.splice(index, 1);
                }
            }
        });
    }

    removeBindingsFromSource(source: string) {
        this.keyBindings = this.keyBindings.filter((keyBinding) => keyBinding.source !== source);
    }

    getKeyBindings() {
        return this.keyBindings.slice();
    }

    findKeyBindings(params: any = {}) {
        const { keystrokes, command, target, keyBindings } = params;
        let bindings = keyBindings ?? this.keyBindings;
        if (command) {
            bindings = bindings.filter((binding) => binding.command === command);
        }
        if (keystrokes) {
            bindings = bindings.filter((binding) => binding.keystrokes === keystrokes);
        }
        if (target) {
            let candidateBindings = bindings;
            bindings = [];
            let element = target;
            while (element && element !== document) {
                const matchingBindings = candidateBindings
                    .filter((binding) => element.webkitMatchesSelector(binding.selector))
                    .sort((a, b) => a.compare(b));
                bindings.push(...matchingBindings);
                element = element.parentElement;
            }
        }
        return bindings;
    }

    loadKeymap(bindingsPath: string, options: any) {
        const checkIfDirectory = options?.checkIfDirectory ?? true;
        if (checkIfDirectory && fs.isDirectorySync(bindingsPath)) {
            for (const filePath of fs.listSync(bindingsPath, ['.json'])) {
                if (this.filePathMatchesPlatform(filePath)) {
                    this.loadKeymap(filePath, { checkIfDirectory: false });
                }
            }
        } else {
            this.add(bindingsPath, this.readKeymap(bindingsPath, options?.suppressErrors), options?.priority);
            if (options?.watch) {
                this.watchKeymap(bindingsPath, options);
            }
        }
    }

    watchKeymap(filePath: string, options: any) {
        // TODO: Implement watchKeymap
    }

    reloadKeymap(filePath: string, options: any) {
        if (fs.isFileSync(filePath)) {
            const bindings = this.readKeymap(filePath, true);
            if (typeof bindings !== 'string') {
                this.removeBindingsFromSource(filePath);
                this.add(filePath, bindings, options?.priority);
                this.emitter.emit('did-reload-keymap', { path: filePath });
            }
        } else {
            this.removeBindingsFromSource(filePath);
            this.emitter.emit('did-unload-keymap', { path: filePath });
        }
    }

    readKeymap(filePath: string, suppressErrors: boolean) {
        if (suppressErrors) {
            try {
                return JSON.parse(fs.readFileSync(filePath));
            } catch (error) {
                console.warn(`Failed to reload key bindings file: ${filePath}`, error.stack ?? error);
                this.emitter.emit('did-fail-to-read-file', error);
            }
        } else {
            return JSON.parse(fs.readFileSync(filePath));
        }
    }

    filePathMatchesPlatform(filePath: string) {
        const otherPlatforms = this.getOtherPlatforms();
        for (const component of path.basename(filePath).split('.').slice(0, -1)) {
            if (otherPlatforms.includes(component)) {
                return false;
            }
        }
        return true;
    }

    handleKeyboardEvent(event: any, { replay, disabledBindings } = {}) {
        if (event.keyCode === 229 && event.key !== 'Dead') {
            return;
        }
        const keystroke = keystrokeForKeyboardEvent(event);
        if (event.type === 'keydown' && this.queuedKeystrokes.length > 0 && isBareModifier(keystroke)) {
            event.preventDefault();
            return;
        }
        this.queuedKeystrokes.push(keystroke);
        this.queuedKeyboardEvents.push(event);
        const keystrokes = this.queuedKeystrokes.join(' ');
        let target = event.target;
        target = event.target === document.body && this.defaultTarget ? this.defaultTarget : target;
        const { partialMatchCandidates, pendingKeyupMatchCandidates, exactMatchCandidates } = this.findMatchCandidates(
            this.queuedKeystrokes,
            disabledBindings
        );
        let dispatchedExactMatch = null;
        const partialMatches = this.findPartialMatches(partialMatchCandidates, target);
        if (this.pendingPartialMatches) {
            const liveMatches = new Set([...partialMatches, ...exactMatchCandidates]);
            for (const binding of this.pendingPartialMatches) {
                if (!liveMatches.has(binding)) {
                    this.bindingsToDisable.push(binding);
                }
            }
        }
        const hasPartialMatches = partialMatches.length > 0;
        const shouldUsePartialMatches = hasPartialMatches;
        if (isKeyup(keystroke)) {
            exactMatchCandidates.push(...this.pendingKeyupMatcher.getMatches(keystroke));
        }
        if (exactMatchCandidates.length > 0) {
            let currentTarget = target;
            let eventHandled = false;
            while (!eventHandled && currentTarget && currentTarget !== document) {
                const exactMatches = this.findExactMatches(exactMatchCandidates, currentTarget);
                for (const exactMatchCandidate of exactMatches) {
                    if (exactMatchCandidate.command === 'native!') {
                        shouldUsePartialMatches = false;
                        eventHandled = true;
                        break;
                    }
                    if (exactMatchCandidate.command === 'abort!') {
                        event.preventDefault();
                        eventHandled = true;
                        break;
                    }
                    if (exactMatchCandidate.command === 'unset!') {
                        break;
                    }
                    if (hasPartialMatches) {
                        let allPartialMatchesContainKeyupRemainder = true;
                        for (const partialMatch of partialMatches) {
                            if (pendingKeyupMatchCandidates.indexOf(partialMatch) < 0) {
                                allPartialMatchesContainKeyupRemainder = false;
                                break;
                            }
                        }
                        if (allPartialMatchesContainKeyupRemainder === false) {
                            break;
                        }
                    } else {
                        shouldUsePartialMatches = false;
                    }
                    if (this.dispatchCommandEvent(exactMatchCandidate.command, target, event)) {
                        dispatchedExactMatch = exactMatchCandidate;
                        eventHandled = true;
                        for (const pendingKeyupMatch of pendingKeyupMatchCandidates) {
                            this.pendingKeyupMatcher.addPendingMatch(pendingKeyupMatch);
                        }
                        break;
                    }
                }
                currentTarget = currentTarget.parentElement;
            }
        }
        if (dispatchedExactMatch) {
            this.emitter.emit('did-match-binding', {
                keystrokes,
                eventType: event.type,
                binding: dispatchedExactMatch,
                keyboardEventTarget: target,
            });
        } else if (hasPartialMatches && shouldUsePartialMatches) {
            event.preventDefault();
            this.emitter.emit('did-partially-match-binding', {
                keystrokes,
                eventType: event.type,
                partiallyMatchedBindings: partialMatches,
                keyboardEventTarget: target,
            });
        } else if (!dispatchedExactMatch && !hasPartialMatches) {
            this.emitter.emit('did-fail-to-match-binding', {
                keystrokes,
                eventType: event.type,
                keyboardEventTarget: target,
            });
            if (event.defaultPrevented && event.type === 'keydown') {
                this.simulateTextInput(event);
            }
        }
        this.bindingsToDisable.push(...(dispatchedExactMatch ? [dispatchedExactMatch] : []));
        if (hasPartialMatches && shouldUsePartialMatches) {
            const enableTimeout =
                this.pendingStateTimeoutHandle ||
                dispatchedExactMatch ||
                characterForKeyboardEvent(this.queuedKeyboardEvents[0]);
            this.enterPendingState(partialMatches, enableTimeout);
        } else if (!dispatchedExactMatch && !hasPartialMatches && this.pendingPartialMatches) {
            this.terminatePendingState();
        } else {
            this.clearQueuedKeystrokes();
        }
    }

    keystrokeForKeyboardEvent(event: any) {
        return keystrokeForKeyboardEvent(event, this.customKeystrokeResolvers);
    }

    addKeystrokeResolver(resolver: any) {
        this.customKeystrokeResolvers.push(resolver);
        return new Disposable(() => {
            const index = this.customKeystrokeResolvers.indexOf(resolver);
            if (index >= 0) {
                this.customKeystrokeResolvers.splice(index, 1);
            }
        });
    }

    getPartialMatchTimeout() {
        return this.partialMatchTimeout;
    }

    simulateTextInput(keydownEvent: any) {
        const character = characterForKeyboardEvent(keydownEvent);
        if (character) {
            const textInputEvent = document.createEvent('TextEvent');
            textInputEvent.initTextEvent('textInput', true, true, window, character);
            keydownEvent.path[0].dispatchEvent(textInputEvent);
        }
    }

    findMatchCandidates(keystrokeArray: string[], disabledBindings: any) {
        const partialMatchCandidates = [];
        const exactMatchCandidates = [];
        const pendingKeyupMatchCandidates = [];
        const disabledBindingSet = new Set(disabledBindings);
        for (const binding of this.keyBindings) {
            const doesMatch = binding.matchesKeystrokes(keystrokeArray);
            if (doesMatch === MATCH_TYPES.EXACT) {
                exactMatchCandidates.push(binding);
            } else if (doesMatch === MATCH_TYPES.PARTIAL) {
                partialMatchCandidates.push(binding);
            } else if (doesMatch === MATCH_TYPES.PENDING_KEYUP) {
                partialMatchCandidates.push(binding);
                pendingKeyupMatchCandidates.push(binding);
            }
        }
        return { partialMatchCandidates, pendingKeyupMatchCandidates, exactMatchCandidates };
    }

    findPartialMatches(partialMatchCandidates: any, target: any) {
        const partialMatches = [];
        const ignoreKeystrokes = new Set();
        for (const binding of partialMatchCandidates) {
            if (binding.command === 'unset!') {
                ignoreKeystrokes.add(binding.keystrokes);
            }
        }
        while (partialMatchCandidates.length > 0 && target && target !== document) {
            partialMatchCandidates = partialMatchCandidates.filter((binding) => {
                if (!ignoreKeystrokes.has(binding.keystrokes) && target.webkitMatchesSelector(binding.selector)) {
                    partialMatches.push(binding);
                    return false;
                }
                return true;
            });
            target = target.parentElement;
        }
        partialMatches.sort((a, b) => b.keystrokeCount - a.keystrokeCount);
        return partialMatches;
    }

    findExactMatches(exactMatchCandidates: any, target: any) {
        return exactMatchCandidates
            .filter((binding) => target.webkitMatchesSelector(binding.selector))
            .sort((a, b) => a.compare(b));
    }

    clearQueuedKeystrokes() {
        this.queuedKeyboardEvents = [];
        this.queuedKeystrokes = [];
        this.bindingsToDisable = [];
    }

    enterPendingState(pendingPartialMatches: any, enableTimeout: boolean) {
        this.cancelPendingState();
        this.pendingPartialMatches = pendingPartialMatches;
        if (enableTimeout) {
            this.pendingStateTimeoutHandle = setTimeout(this.terminatePendingState.bind(this, true), this.partialMatchTimeout);
        }
    }

    cancelPendingState() {
        clearTimeout(this.pendingStateTimeoutHandle);
        this.pendingStateTimeoutHandle = null;
        this.pendingPartialMatches = null;
    }

    terminatePendingState(fromTimeout: boolean = false) {
        const bindingsToDisable = [...this.pendingPartialMatches, ...this.bindingsToDisable];
        const eventsToReplay = this.queuedKeyboardEvents;
        this.cancelPendingState();
        this.clearQueuedKeystrokes();
        let keyEventOptions = {
            replay: true,
            disabledBindings: bindingsToDisable,
        };
        for (const event of eventsToReplay) {
            keyEventOptions.disabledBindings = bindingsToDisable;
            this.handleKeyboardEvent(event, keyEventOptions);
            bindingsToDisable = null;
            if (bindingsToDisable && !this.pendingPartialMatches) {
                bindingsToDisable = null;
            }
        }
        if (fromTimeout && this.pendingPartialMatches) {
            this.terminatePendingState(true);
        }
    }

    dispatchCommandEvent(command: string, target: any, keyboardEvent: any) {
        const commandEvent = new CustomEvent(command, { bubbles: true, cancelable: true });
        Object.setPrototypeOf(commandEvent, CommandEvent.prototype);
        commandEvent.originalEvent = keyboardEvent;
        if (document.contains(target)) {
            target.dispatchEvent(commandEvent);
        } else {
            this.simulateBubblingOnDetachedTarget(target, commandEvent);
        }
        const { keyBindingAborted } = commandEvent;
        if (!keyBindingAborted) {
            keyboardEvent.preventDefault();
        }
        return !keyBindingAborted;
    }

    simulateBubblingOnDetachedTarget(target: any, commandEvent: any) {
        Object.defineProperty(commandEvent, 'target', { get: () => target });
        let currentTarget = target;
        while (currentTarget) {
            currentTarget.dispatchEvent(commandEvent);
            if (commandEvent.propagationStopped) {
                break;
            }
            if (currentTarget === window) {
                break;
            }
            currentTarget = currentTarget.parentNode ?? window;
        }
    }

    static getOtherPlatforms() {
        return OtherPlatforms;
    }
}


