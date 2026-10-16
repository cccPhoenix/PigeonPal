# Marked (vendored)

- Project: https://github.com/markedjs/marked
- Version: 18.1.1
- Distribution: https://registry.npmjs.org/marked/-/marked-18.1.1.tgz
- License: MIT, included in LICENSE.md
- `marked.esm.js` SHA-256: `930457e5d55439f90465015cc507d3323366e80df5f7a701b61189d4e1046bda`

The published tarball was verified against its npm SHA-512 integrity value before extracting the browser ESM module. This is the unmodified published module. It has no runtime CDN or Node.js dependency in the browser. Library maintainers specify Node 20+ for Node usage; development checks run with Node 22.

The application uses a private Marked instance in `ui/format.js`: raw HTML renders as text, links are limited to HTTP/HTTPS/mailto, and Markdown images become explicit links instead of automatic requests. GFM tables, task lists, fenced code and normal Markdown blocks are supported. No user-configurable parser extensions run.

To update, fetch a pinned published version, verify its integrity, preserve the license, update this record, and run the Markdown render checks. Upstream renderer API: https://marked.js.org/using_pro#renderer
