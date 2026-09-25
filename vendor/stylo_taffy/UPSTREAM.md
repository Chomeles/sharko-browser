This directory contains a copy of the `stylo_taffy` crate from
https://github.com/DioxusLabs/blitz (version 0.3.0-beta.2), licensed under
MIT OR Apache-2.0 OR MPL-2.0. Modifications:

- its `stylo` dependency is bumped from 0.20 to 0.21 (no stylo_taffy release targets
  stylo 0.21 yet);
- `is_fixed_position` is forwarded to taffy (see vendor/README.md, patch 46).
