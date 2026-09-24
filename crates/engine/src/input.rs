//! Conversion of IPC input events into Blitz UI events.

use blitz_traits::events::{
    BlitzImeEvent, BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta,
    BlitzWheelEvent, KeyState, MouseEventButton, MouseEventButtons, PointerCoords,
    PointerDetails, UiEvent,
};
use common::protocol::{InputEvent, Modifiers};
use keyboard_types::{Code, Key, Location, Modifiers as KbMods};
use std::str::FromStr;

fn mods(m: &Modifiers) -> KbMods {
    let mut k = KbMods::empty();
    if m.shift {
        k |= KbMods::SHIFT;
    }
    if m.ctrl {
        k |= KbMods::CONTROL;
    }
    if m.alt {
        k |= KbMods::ALT;
    }
    if m.meta {
        k |= KbMods::META;
    }
    k
}

fn button(b: u8) -> MouseEventButton {
    match b {
        1 => MouseEventButton::Auxiliary,
        2 => MouseEventButton::Secondary,
        3 => MouseEventButton::Fourth,
        4 => MouseEventButton::Fifth,
        _ => MouseEventButton::Main,
    }
}

fn coords(x: f32, y: f32, scroll: (f64, f64)) -> PointerCoords {
    PointerCoords {
        page_x: x + scroll.0 as f32,
        page_y: y + scroll.1 as f32,
        screen_x: x,
        screen_y: y,
        client_x: x,
        client_y: y,
    }
}

fn pointer(x: f32, y: f32, b: u8, buttons: u8, m: &Modifiers, scroll: (f64, f64)) -> BlitzPointerEvent {
    let buttons = MouseEventButtons::from_bits_truncate(buttons);
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: coords(x, y, scroll),
        button: button(b),
        buttons,
        mods: mods(m),
        details: PointerDetails {
            pressure: if buttons.is_empty() { 0.0 } else { 0.5 },
            ..Default::default()
        },
        element: Default::default(),
        active_pointers: Default::default(),
    }
}

fn location(l: u8) -> Location {
    match l {
        1 => Location::Left,
        2 => Location::Right,
        3 => Location::Numpad,
        _ => Location::Standard,
    }
}

fn key(k: &str) -> Key {
    Key::from_str(k).unwrap_or_else(|_| Key::Character(k.to_string()))
}

/// Convert an input event. `scroll` is the current viewport scroll offset (CSS px).
pub fn to_ui_event(ev: &InputEvent, scroll: (f64, f64)) -> Option<UiEvent> {
    Some(match ev {
        InputEvent::MouseMove { x, y, buttons, mods } => {
            UiEvent::PointerMove(pointer(*x, *y, 0, *buttons, mods, scroll))
        }
        InputEvent::MouseDown { x, y, button, buttons, mods } => {
            UiEvent::PointerDown(pointer(*x, *y, *button, *buttons, mods, scroll))
        }
        InputEvent::MouseUp { x, y, button, buttons, mods } => {
            UiEvent::PointerUp(pointer(*x, *y, *button, *buttons, mods, scroll))
        }
        InputEvent::Wheel { x, y, dx, dy, mods: m } => UiEvent::Wheel(BlitzWheelEvent {
            // Blitz follows winit's sign convention (positive = scroll up/left).
            delta: BlitzWheelDelta::Pixels(-*dx, -*dy),
            coords: coords(*x, *y, scroll),
            buttons: MouseEventButtons::None,
            mods: mods(m),
            element: Default::default(),
        }),
        InputEvent::KeyDown { key: k, code, text, repeat, location: l, mods: m } => {
            UiEvent::KeyDown(BlitzKeyEvent {
                key: key(k),
                code: Code::from_str(code).unwrap_or(Code::Unidentified),
                modifiers: mods(m),
                location: location(*l),
                is_auto_repeating: *repeat,
                is_composing: false,
                state: KeyState::Pressed,
                text: text.as_deref().map(smol_str::SmolStr::new),
            })
        }
        InputEvent::KeyUp { key: k, code, location: l, mods: m } => UiEvent::KeyUp(BlitzKeyEvent {
            key: key(k),
            code: Code::from_str(code).unwrap_or(Code::Unidentified),
            modifiers: mods(m),
            location: location(*l),
            is_auto_repeating: false,
            is_composing: false,
            state: KeyState::Released,
            text: None,
        }),
        InputEvent::ImeEnabled => UiEvent::Ime(BlitzImeEvent::Enabled),
        InputEvent::ImeDisabled => UiEvent::Ime(BlitzImeEvent::Disabled),
        InputEvent::ImePreedit { text, cursor } => {
            UiEvent::Ime(BlitzImeEvent::Preedit(text.clone(), *cursor))
        }
        InputEvent::ImeCommit(text) => UiEvent::Ime(BlitzImeEvent::Commit(text.clone())),
        InputEvent::MouseLeave | InputEvent::Focus(_) => return None,
    })
}
