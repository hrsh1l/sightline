# Attribution and licences

Sightline's own source in this repository was written for this prototype (see [ai.md](ai.md) for how AI tools
were used). No third-party source code was copied into the repository. Third-party software is used as
dependencies, installed by package managers and not committed.

## Runtime dependencies (npm, exact versions in package-lock.json)

| Package | Version | Licence | Use |
|---|---|---|---|
| @google/genai | 3.6.1 | Apache-2.0 | Gemini Live and generateContent (server only) |
| express | 5.3.0 | MIT | HTTP server |
| ws | 8.23.0 | MIT | WebSocket server |
| zod | 4.6.7 | MIT | Message validation |
| dotenv | 18.0.10 | BSD-2-Clause | Local .env loading |
| react, react-dom | 19.3.1 | MIT | UI |
| sharp | 0.35.5 | Apache-2.0 (prebuilt libvips binaries are LGPL-3.0-or-later) | Server-side cropping of label text regions |

Dev tooling (TypeScript 6.0.3, Vite 8.3.8, Vitest 5.1.1, Playwright 1.65.1, ESLint 10.15.0, typescript-eslint 8.74.0,
tsx 4.23.15, jsdom 31.0.1, Testing Library 16.3.3) is used under its respective open-source licences (MIT /
Apache-2.0) and is not shipped in the client bundle.

## Optional detector (services/detector, not required)

| Component | Version | Licence |
|---|---|---|
| ultralytics | 8.4.218 | AGPL-3.0 (package metadata) |
| YOLO26n weights (`yolo26n.pt`, downloaded at first run, not committed) | release v8.4.0 asset | AGPL-3.0 by default per https://www.ultralytics.com/license; an Ultralytics Enterprise Licence is offered for other terms |
| torch | 2.15.0 | Apache-2.0 AND BSD-2/3-Clause AND MIT and others (package metadata) |
| torchvision | 0.29.2 | BSD (package metadata) |
| opencv-python | 5.1.0.95 | Apache-2.0 |
| pillow | 13.0.0 | MIT-CMU |
| numpy | 2.5.5 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 (package metadata) |

The detector is a separate local process that is not distributed with the app. Anyone deploying it as a network
service should review AGPL-3.0 obligations (or the Enterprise Licence). The weights were trained on COCO; COCO's
own terms were not retrieved during this build and should be reviewed before any distribution of weights.

## Services

Google Gemini API (Live and generateContent) is used under the account holder's Google AI terms. Sightline is
not affiliated with Google, Meta, Ray-Ban or Ultralytics.
