# Contributing

Issues and focused pull requests are welcome. Before sending a change:

```bash
npm ci
make check
npm run export
npm run build:web
```

Keep `src/core/` browser-safe: no Node file-system, path, compression, `Buffer`
or `process` APIs. Node I/O belongs in `src/cli.js`; browser I/O belongs in
`src/web/read.js`.

Do not contribute dictionaries or packs containing word data. Test vocabulary
belongs only in `test/fixtures/`, where every entry should cover a specific
behaviour and be verified as missing in all five Harper dialects.

By contributing, you agree that your contribution is licensed under the MIT
licence in `LICENSE`.
