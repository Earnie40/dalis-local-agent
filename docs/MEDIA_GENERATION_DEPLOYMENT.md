# Image and video generation deployment

The DacaiLocalAgent UI and agent tools use the DACAIS-owned media API from the
separate local repository at `C:\Users\Kyleh\deepbrain-avatar-poc`. The repository
name is historical; this integration does not call any DeepBrain AI company API,
SDK, model, or hosted service.

## Local development

Configure `.env` with the selected Runpod ID and API/SSH credentials, then use:

```env
DACAI_IMAGE_BACKEND=dacais-media
DACAI_VIDEO_BACKEND=dacais-media
DACAI_MEDIA_TRANSPORT=ssh-tunnel
DACAI_MEDIA_BASE_URL=http://127.0.0.1:18090
DACAI_MEDIA_REMOTE_PORT=8090
DACAI_MEDIA_AUTOSTART=true
```

`pnpm dev` is the only startup command. The server supervises the full media
connection: it starts the configured billable pod when necessary, waits for its
new SSH endpoint, restores `/workspace/dacais-media/run-media.sh`, establishes a
loopback-only tunnel, and reconnects if the tunnel drops. The sidebar reports
`starting pod`, `waiting for ssh`, `starting service`, or `Ready · image + video`.

`DACAI_MEDIA_AUTOSTART=true` is an explicit cost opt-in. Set it to `false` when a
developer should start the pod manually. The legacy `pnpm run runpod:media`
command remains available for diagnostics but is not needed during normal dev.

Readiness is available without exposing credentials:

```text
GET  /api/infrastructure/media/status
POST /api/infrastructure/media/reconnect
```

## Production

Production does not use SSH. Put the media container behind a TLS endpoint and
configure the Dacai server with:

```env
NODE_ENV=production
DACAI_IMAGE_BACKEND=dacais-media
DACAI_VIDEO_BACKEND=dacais-media
DACAI_MEDIA_TRANSPORT=https
DACAI_MEDIA_BASE_URL=https://media.example.com
DACAI_MEDIA_TOKEN=<runtime secret>
DACAI_MEDIA_AUTOSTART=false
```

The tools reject plain HTTP, URL-embedded credentials, and an HTTPS production
configuration without a bearer token. Keep `DACAI_MEDIA_TOKEN`, `RUNPOD_API_KEY`,
database credentials, and registry credentials in the deployment platform's
secret store; never bake them into either image.

The media image is built from the avatar repository:

```powershell
docker build --platform linux/amd64 `
  -f runpod/Dockerfile.media `
  -t <registry>/dacais-media:<version> .
docker push <registry>/dacais-media:<version>
```

Deploy it on a Runpod GPU pod with a persistent volume mounted at `/workspace`,
ports `22/tcp,8090/http`, and runtime secret `DACAIS_MEDIA_TOKEN`. Existing
weights belong at `/workspace/dacais-media/models/sdxl-base` and
`/workspace/dacais-media/models/svd-xt`. On an empty volume, set
`DACAIS_MEDIA_DOWNLOAD_MODELS=true` for the first boot, then remove it. The image
requires the configured models before serving and preserves the official
Runpod `/start.sh`, so SSH remains available.

The Dacai application itself has two production image targets and a same-origin
reverse proxy:

```powershell
Copy-Item deploy/production.env.example .env.production
# Replace every placeholder through the deployment secret store.
docker compose -f deploy/compose.production.yml build
docker compose -f deploy/compose.production.yml up -d
```

The web target listens on port 8080 in the example. The server target is only
exposed to the compose network, runs database migrations at startup, and uses
authenticated HTTPS for media calls.

## Release gate

Before a real production push:

1. Pin an immutable media image tag or digest and confirm model licenses.
2. Put TLS and access control in front of port 8090; do not publish raw HTTP.
3. Inject secrets at runtime and rotate any credential used during staging.
4. Verify `/ping`, authenticated `/v1/health`, image generation, image editing,
   text-to-video, and image animation from the deployed Dacai server.
5. Configure monitoring, request limits, GPU cost alerts, backups for persistent
   media, and a stop/rollback procedure.
