const { calculateSpecificity } = require('clear-cut');
import { keyMap as uskeymap } from "./us-keymap";
const { slovakcmdkeymap } = require('./slovak-cmd-keymap');
import { keyMap as slovakqwertycmdkeymap } from "./slovak-qwerty-cmd-keymap";

const keyboard = navigator.keyboard;
let KeyboardLayout = null;
keyboard.getLayoutMap().then((map) => (KeyboardLayout = map));
const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'cmd']);
const ENDS_IN_MODIFIER_REGEX = /(ctrl|alt|shift|cmd)$/;
const WHITESPACE_REGEX = /\s+/;
const KEY_NAMES_BY_KEYBOARD_EVENT_CODE = {
    Space: 'space',
    Backspace: 'backspace',
};
const NON_CHARACTER_KEY_NAMES_BY_KEYBOARD_EVENT_KEY = {
    Control: 'ctrl',
    Meta: 'cmd',
    ArrowDown: 'down',
    ArrowUp: 'up',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};
const NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE = {
    Numpad0: 'numpad0',
    Numpad1: 'numpad1',
    Numpad2: 'numpad2',
    Numpad3: 'numpad3',
    Numpad4: 'numpad4',
    Numpad5: 'numpad5',
    Numpad6: 'numpad6',
    Numpad7: 'numpad7',
    Numpad8: 'numpad8',
    Numpad9: 'numpad9',
};
const DIGIT_KEYS_BY_KEYBOARD_EVENT_CODE = {
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
};
const LATIN_KEYMAP_CACHE = new WeakMap();
const isLatinKeymap = (keymap) => {
    if (!keymap) {
        return true;
    }
    let isLatin = LATIN_KEYMAP_CACHE.get(keymap);
    if (isLatin) {
        return isLatin;
    } else {
        isLatin =
            (!keymap.KeyA || isLatinCharacter(keymap.KeyA.unmodified)) &&
            (!keymap.KeyS || isLatinCharacter(keymap.KeyS.unmodified)) &&
            (!keymap.KeyD || isLatinCharacter(keymap.KeyD.unmodified)) &&
            (!keymap.KeyF || isLatinCharacter(keymap.KeyF.unmodified));
        LATIN_KEYMAP_CACHE.set(keymap, isLatin);
        return isLatin;
    }
};
const isASCIICharacter = (character) => {
    return (
        character &&
        character.length === 1 &&
        character.charCodeAt(0) <= 127
    );
};
const isLatinCharacter = (character) => {
    return (
        character &&
        character.length === 1 &&
        character.charCodeAt(0) <= 0x024F
    );
};
const isUpperCaseCharacter = (character) => {
    return (
        character &&
        character.length === 1 &&
        character.toLowerCase() !== character
    );
};
const isLowerCaseCharacter = (character) => {
    return (
        character &&
        character.length === 1 &&
        character.toUpperCase() !== character
    );
};
const isNumericCharacter = (character) => {
    return (
        character &&
        character.length === 1 &&
        character.charCodeAt(0) >= 48 &&
        character.charCodeAt(0) <= 57
    );
};
let usKeymap = uskeymap;
const usCharactersForKeyCode = (code) => {
    usKeymap = usKeymap || uskeymap;
    return usKeymap[code];
};

let slovakCmdKeymap = slovakcmdkeymap;
let slovakQwertyCmdKeymap = slovakqwertycmdkeymap;
const slovakCmdCharactersForKeyCode = (code, layout) => {
    slovakCmdKeymap = slovakCmdKeymap || slovakcmdkeymap;
    slovakQwertyCmdKeymap =
        slovakQwertyCmdKeymap || slovakqwertycmdkeymap;
    if (layout === 'com.apple.keylayout.Slovak') {
        return slovakCmdKeymap[code];
    } else {
        return slovakQwertyCmdKeymap[code];
    }
};

exports.normalizeKeystrokes = (keystrokes) => {
    const normalizedKeystrokes = [];
    for (const keystroke of keystrokes.split(WHITESPACE_REGEX)) {
        const normalizedKeystroke = normalizeKeystroke(keystroke);
        if (normalizedKeystroke) {
            normalizedKeystrokes.push(normalizedKeystroke);
        } else {
            return false;
        }
    }
    return normalizedKeystrokes.join(' ');
};
const normalizeKeystroke = (keystroke) => {
    const keyup = isKeyup(keystroke);
    if (keyup) {
        keystroke = keystroke.slice(1);
    }
    const keys = parseKeystroke(keystroke);
    if (!keys) {
        return false;
    }
    let primaryKey = null;
    const modifiers = new Set();
    for (const [key, i] of keys.entries()) {
        if (MODIFIERS.has(key)) {
            modifiers.add(key);
        } else {
            if (i === keys.length - 1) {
                primaryKey = key;
            } else {
                return false;
            }
        }
    }
    if (keyup) {
        primaryKey = primaryKey ? primaryKey.toLowerCase() : null;
    } else {
        if (isUpperCaseCharacter(primaryKey)) {
            modifiers.add('shift');
        }
    }
    const normalizedKeystroke = [];
    if (!keyup || (keyup && !primaryKey)) {
        if (modifiers.has('ctrl')) {
            normalizedKeystroke.push('ctrl');
        }
        if (modifiers.has('alt')) {
            normalizedKeystroke.push('alt');
        }
        if (modifiers.has('shift')) {
            normalizedKeystroke.push('shift');
        }
        if (modifiers.has('cmd')) {
            normalizedKeystroke.push('cmd');
        }
    }
    if (primaryKey) {
        normalizedKeystroke.push(primaryKey);
    }
    return normalizedKeystroke.join('-');
};
const parseKeystroke = (keystroke) => {
    const keys = [];
    let keyStart = 0;
    for (const [index, character] of keystroke.entries()) {
        if (character === '-') {
            if (index > keyStart) {
                keys.push(keystroke.substring(keyStart, index));
                keyStart = index + 1;
                if (keyStart === keystroke.length) {
                    return false;
                }
            }
        }
    }
    if (keyStart < keystroke.length) {
        keys.push(keystroke.substring(keyStart));
    }
    return keys;
};
exports.keystrokeForKeyboardEvent = (event, customKeystrokeResolvers) => {
    const { key, code, ctrlKey, altKey, shiftKey, metaKey } = event;
    if (NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code]) {
        key = NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code];
    }
    if (DIGIT_KEYS_BY_KEYBOARD_EVENT_CODE[code]) {
        key = DIGIT_KEYS_BY_KEYBOARD_EVENT_CODE[code];
    }
    if (KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code]) {
        key = KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code];
    }
    let isAltModifiedKey = false;
    const isNonCharacterKey = key.length > 1;
    if (isNonCharacterKey) {
        key = NON_CHARACTER_KEY_NAMES_BY_KEYBOARD_EVENT_KEY[key] || key.toLowerCase();
        if (key === 'altgraph' && process.platform === 'win32') {
            key = 'alt';
        }
    } else {
        key = key.toLowerCase();
        if (
            event.getModifierState('AltGraph') ||
            (process.platform === 'darwin' && altKey)
        ) {
            let nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
            if (nonAltModifiedKey && (ctrlKey || metaKey || !isASCIICharacter(key))) {
                key = nonAltModifiedKey;
            } else if (key !== nonAltModifiedKey) {
                altKey = false;
                isAltModifiedKey = true;
            }
        } else if (process.platform === 'win32' && event.code) {
            let nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
            if (nonAltModifiedKey && (metaKey || !isASCIICharacter(key))) {
                key = nonAltModifiedKey;
            } else if (key !== nonAltModifiedKey) {
                ctrlKey = false;
                altKey = false;
                isAltModifiedKey = true;
            }
        } else if (process.platform === 'linux') {
            let nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
            if (nonAltModifiedKey && (ctrlKey || altKey || metaKey)) {
                key = nonAltModifiedKey;
                altKey = event.getModifierState('AltGraph');
                isAltModifiedKey = !altKey;
            }
        }
    }
    if (event.code && key.length === 1) {
        if (!isLatinCharacter(key)) {
            const characters = usCharactersForKeyCode(event.code);
            if (event.shiftKey) {
                key = characters.withShift;
            } else if (characters.unmodified) {
                key = characters.unmodified;
            }
        }
    }
    let keystroke = '';
    if (key === 'ctrl' || (ctrlKey && event.type !== 'keyup')) {
        keystroke += 'ctrl';
    }
    if (key === 'alt' || (altKey && event.type !== 'keyup')) {
        if (keystroke.length > 0) {
            keystroke += '-';
        }
        keystroke += 'alt';
    }
    if (key === 'shift' || shiftKey) {
        if (keystroke) {
            keystroke += '-';
        }
        keystroke += 'shift';
    }
    if (key === 'cmd' || (metaKey && event.type !== 'keyup')) {
        if (keystroke) {
            keystroke += '-';
        }
        keystroke += 'cmd';
    }
    if (!MODIFIERS.has(key)) {
        if (keystroke) {
            keystroke += '-';
        }
        keystroke += key;
    }
    keystroke = normalizeKeystroke('^' + keystroke);
    return keystroke;
};
const nonAltModifiedKeyForKeyboardEvent = (event) => {
    if (event.code) {
        const characters = KeyboardLayout.get(event.code);
        if (characters) {
            return characters;
        }
    }
};
exports.MODIFIERS = MODIFIERS;
exports.characterForKeyboardEvent = (event) => {
    if (event.key.length === 1 && !(event.ctrlKey || event.metaKey)) {
        return event.key;
    }
};
exports.calculateSpecificity = calculateSpecificity;
exports.isBareModifier = (keystroke) => {
    return ENDS_IN_MODIFIER_REGEX.test(keystroke);
};

exports.isKeyup = (keystroke) => {
    return keystroke.startsWith('^') && keystroke !== '^';
};

exports.isModifierKeyup = (keystroke) => {
    return isKeyup(keystroke) && ENDS_IN_MODIFIER_REGEX.test(keystroke);
};

exports.keydownEvent = (key, options) => {
    return buildKeyboardEvent(key, 'keydown', options);
};
exports.keyupEvent = (key, options) => {
    return buildKeyboardEvent(key, 'keyup', options);
};
exports.getModifierKeys = (keystroke) => {
    const keys = keystroke.split('-');
    const mod_keys = [];
    for (const key of keys) {
        if (MODIFIERS.has(key)) {
            mod_keys.push(key);
        }
    }
    return mod_keys;
};
const buildKeyboardEvent = (key, eventType, { ctrl, shift, alt, cmd, keyCode, target, location } = {}) => {
    const ctrlKey = ctrl || false;
    const altKey = alt || false;
    const shiftKey = shift || false;
    const metaKey = cmd || false;
    const bubbles = true;
    const cancelable = true;
    const event = new KeyboardEvent(eventType, {
        key,
        ctrlKey,
        altKey,
        shiftKey,
        metaKey,
        bubbles,
        cancelable,
    });
    if (target) {
        Object.defineProperty(event, 'target', { get: () => target });
        Object.defineProperty(event, 'path', { get: () => [target] });
    }
    return event;
};


