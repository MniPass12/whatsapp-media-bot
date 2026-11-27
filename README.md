# WhatsApp Media Bot Offload Runner

Autonomous heavy media downloader and two-pass FFmpeg compressor for the Cloudflare Worker WhatsApp Edge Agent.

- Workflow: `.github/workflows/media-worker.yml`
- Processor: `scripts/process-media.mjs` (strictly targets <= 15.8 MB for WhatsApp's 16 MB upload cap)
