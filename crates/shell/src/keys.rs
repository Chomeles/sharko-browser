//! Keyboard: winit key events → DOM-style key events, and browser shortcuts.

use crate::chrome::Action;
use common::protocol::{InputEvent, Modifiers};
use winit::event::{ElementState, KeyEvent};
use winit::keyboard::{Key, KeyLocation, NamedKey, PhysicalKey};

pub enum Shortcut {
    Ui(Action),
    FocusUrl,
    CloseTab,
    NextTab(i32),
    /// usize::MAX = last tab
    TabIndex(usize),
    Fullscreen,
}

fn named_key(k: &NamedKey) -> String {
    match k {
        NamedKey::Space => " ".into(),
        NamedKey::Super => "Meta".into(),
        other => format!("{other:?}"),
    }
}

/// Convert a winit key event into our IPC key event (DOM `key` / `code` values).
pub fn convert(ev: &KeyEvent, mods: Modifiers) -> Option<InputEvent> {
    let key = match &ev.logical_key {
        Key::Named(n) => named_key(n),
        Key::Character(c) => c.to_string(),
        Key::Dead(_) => "Dead".into(),
        Key::Unidentified(_) => "Unidentified".into(),
    };
    let code = match ev.physical_key {
        PhysicalKey::Code(c) => {
            let s = format!("{c:?}");
            s.replace("Super", "Meta")
        }
        PhysicalKey::Unidentified(_) => "Unidentified".into(),
    };
    let location = match ev.location {
        KeyLocation::Standard => 0,
        KeyLocation::Left => 1,
        KeyLocation::Right => 2,
        KeyLocation::Numpad => 3,
    };
    Some(match ev.state {
        ElementState::Pressed => InputEvent::KeyDown {
            key,
            code,
            // Control combinations don't produce text input.
            text: if mods.ctrl && !mods.alt { None } else { ev.text.as_ref().map(|t| t.to_string()) },
            repeat: ev.repeat,
            location,
            mods,
        },
        ElementState::Released => InputEvent::KeyUp { key, code, location, mods },
    })
}

/// Browser-level shortcuts (handled before the page sees the key).
pub fn shortcut(ev: &InputEvent, m: Modifiers) -> Option<Shortcut> {
    let InputEvent::KeyDown { key, code, .. } = ev else { return None };
    let ctrl = m.ctrl || m.meta;
    let k = key.as_str();
    Some(match (ctrl, m.shift, m.alt, k) {
        (true, false, false, "t" | "T") => Shortcut::Ui(Action::NewTab),
        (true, false, false, "w" | "W") | (true, false, false, "F4") => Shortcut::CloseTab,
        (true, false, false, "l" | "L") | (false, false, true, "d" | "D") => Shortcut::FocusUrl,
        (false, false, false, "F6") => Shortcut::FocusUrl,
        (true, _, false, "r" | "R") | (_, _, false, "F5") => Shortcut::Ui(Action::Reload),
        (false, false, true, "ArrowLeft") | (false, false, false, "BrowserBack") => Shortcut::Ui(Action::Back),
        (false, false, true, "ArrowRight") | (false, false, false, "BrowserForward") => Shortcut::Ui(Action::Forward),
        (false, false, true, "Home") | (false, false, false, "BrowserHome") => Shortcut::Ui(Action::Home),
        (true, false, false, "Tab") | (true, false, false, "PageDown") => Shortcut::NextTab(1),
        (true, true, false, "Tab") | (true, false, false, "PageUp") => Shortcut::NextTab(-1),
        (true, _, false, "+" | "=") => Shortcut::Ui(Action::ZoomIn),
        (true, _, false, "-") => Shortcut::Ui(Action::ZoomOut),
        (true, false, false, "0") => Shortcut::Ui(Action::ZoomReset),
        (true, false, false, "9") => Shortcut::TabIndex(usize::MAX),
        (true, false, false, d) if d.len() == 1 && ("1"..="8").contains(&d) => {
            Shortcut::TabIndex(d.parse::<usize>().unwrap_or(1) - 1)
        }
        (false, false, false, "F11") => Shortcut::Fullscreen,
        _ => {
            // Numpad +/- with ctrl
            if ctrl && code == "NumpadAdd" {
                Shortcut::Ui(Action::ZoomIn)
            } else if ctrl && code == "NumpadSubtract" {
                Shortcut::Ui(Action::ZoomOut)
            } else {
                return None;
            }
        }
    })
}
