# Third-party notices

## Harper flag definitions

`src/core/harper-flags.js` contains selected flag definitions from
[Automattic/harper](https://github.com/Automattic/harper), originally published
in `harper-core/annotations.json` under the Apache License 2.0.

weirsmith modifies that source by selecting the supported definitions and
wrapping them as a JavaScript module. The generated file identifies the source
and modification prominently. The complete licence is in
`LICENSES/Apache-2.0.txt`.

## Static web distribution

`npm run build:web` redistributes selected files from `harper.js` 2.4.0, also
from [Automattic/harper](https://github.com/Automattic/harper) under the Apache
License 2.0. Its `packWeirpackFiles` implementation contains bundled code from
[fflate](https://github.com/101arrowz/fflate), Copyright (c) 2026 Arjun Barrett,
under the MIT License in `LICENSES/fflate-MIT.txt`.

All original weirsmith source code is licensed under the MIT licence in
`LICENSE`.
