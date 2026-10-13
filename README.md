# File Transfer

Upload a file, copy its link and share it. A small React and TypeScript application with a public demo on Vercel and a separate local mode for persistent disk storage.

**[Try the demo](https://file-transfer-app-chi.vercel.app/)** · **[Download the source](https://github.com/blvgor/file-transfer-app/archive/refs/heads/main.zip)**

![File Transfer upload screen](docs/preview.png)

## Public demo

- Files of up to **25 MiB**; links expire after **7 days**.
- Drag-and-drop, file picker and file paste, with upload progress.
- A shareable download page and one-click link copying.
- Unicode filenames and binary files, including names with spaces and special characters.
- Responsive desktop and mobile interface, with keyboard support.

Uploads go directly from the browser to private Vercel Blob storage. The server authorises one filename and size through a short-lived upload URL; the file body does not pass through the serverless function. Downloads use short-lived signed links.

Anyone with the share link can download the file until it expires. There are no accounts, passwords or end-to-end encryption. Expiry blocks access immediately; a daily job removes expired files from this application's storage namespace. Removal normally follows within 24 hours, provided the scheduled job succeeds.

The demo uses a free hosting allowance. Availability depends on that allowance; it is intended for trying the application, without a service guarantee.

## Run locally

Requires **Node.js 24.11 or newer within the 24.x release line**. Download and extract the source, then run these commands in the project folder:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3000**. One Node.js server serves the interface and upload API. Local mode needs no Vercel account or storage token: files and metadata stay on disk, and links survive a server restart.

Local mode also supports byte-range downloads. Its upload-size default is 10 GiB and can be changed; tests use smaller fixtures rather than a full 10 GiB upload. Links are accessible on the host machine unless the server is deployed publicly.

## Local configuration

Set these values in the server environment when needed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `3000` | Server port |
| `UPLOADS_DIR` | `backend/uploads` | Persistent file and metadata storage |
| `MAX_FILE_SIZE` | `10737418240` | Upload-size limit in bytes |
| `RETENTION_DAYS` | `7` | Time before files expire |
| `FRONTEND_URL` | Local Vite origins | Allowed origins for a separately hosted interface |

Public self-hosting requires HTTPS and persistent disk storage. Keep uploads outside an ephemeral deployment directory and set limits to match the host's capacity. Expired local files are cleaned at startup and every six hours. Run `npm run cleanup` to clean them immediately.

## Deploy on Vercel

The root `server.ts` is the Hono entry point. `npm run build:vercel` builds the frontend into `public/`; `vercel.json` defines the build and daily cleanup schedule.

1. Import the repository as a Vercel project.
2. Connect a **private** Vercel Blob store to that project. Keep its managed `BLOB_READ_WRITE_TOKEN` in the server environment.
3. Set a randomly generated `CRON_SECRET` in the production environment.
4. Deploy with the Hono configuration in `vercel.json`.

Cloud limits are defined in `backend/src/cloud.ts` and are independent of the local configuration. Never expose either secret through a `VITE_` variable or commit it to the repository. Hosting and storage charges depend on the provider plan and usage.

The Blob SDK is pinned to `2.8.1`. The build applies two narrow, version-checked fixes: UTF-8 decoding of signed-token payloads and escaping of CDN path segments. These preserve filenames containing non-ASCII text, `#`, `?` or `%`. Signature checks remain intact; review or remove the fixes when upgrading the SDK.

## Verification

```sh
npm run build
npm test
```

Tests cover local binary and Unicode round trips, ranges, persisted links, upload limits, expiry and cleanup. Cloud tests check scoped upload authorisation, cross-site request rejection, short-lived download links and authenticated cleanup. Regression tests exercise the actual Blob SDK with Unicode and special-character filenames.

The live demo was also checked with a 6 MiB binary round trip, a browser upload and actual recipient download with its original Unicode filename. Desktop, mobile, keyboard focus, expired links and recovery after a storage error were verified.

Built with **React, TypeScript, Vite, Hono and Vercel Blob**. Released under the [MIT licence](LICENSE).
