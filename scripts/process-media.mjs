import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FALLBACK_WHATSAPP_TOKEN =
  'WAAVjrWGKzhSIZBI9qvtV7IXgYftKEcSeSikSIuKPhSMNBCXPaMIvjYAXrsiTzfM1WaM4v09TsGKZBsUTc22qnsarm4cGfIZCdbQajxmwfFiYr3pP3FGRaZCmlNjcYG3R0ui8G6pxm8ZCWtoBI8TTSG3cGi6C4klAfi3794431ZBpGflzZAEZD';

const WHATSAPP_API_BASE = 'https://api.whatsapp.com/agent/v1';
const WHATSAPP_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || FALLBACK_WHATSAPP_TOKEN).trim();

// WhatsApp Agent Platform hard upload limit is 16 MB (16,777,216 bytes; we enforce <= 15.8 MB to be 100% safe)
const HARD_MAX_BYTES = 15_900_000;
const TARGET_BUDGET_BYTES = 15_100_000; // ~15.1 MB target leaves headroom for MP4 moov atom & container overhead

function parseJobPayload() {
  let payload = {};
  if (process.env.PAYLOAD_JSON && process.env.PAYLOAD_JSON !== 'null') {
    try {
      payload = JSON.parse(process.env.PAYLOAD_JSON);
    } catch {
      payload = {};
    }
  }

  return {
    job_id: payload.job_id || process.env.INPUT_JOB_ID || `gh_${Date.now()}`,
    to: payload.to || process.env.INPUT_TO || '',
    mode: payload.mode || process.env.INPUT_MODE || 'video',
    video_url: payload.video_url || process.env.INPUT_VIDEO_URL || '',
    title: payload.title || '',
    quality: payload.quality || process.env.INPUT_QUALITY || 'auto',
    query: payload.query || '',
    reply_to_wamid: payload.reply_to_wamid || undefined,
    callback_url: payload.callback_url || process.env.WORKER_CALLBACK_URL || '',
  };
}

function runCmd(bin, args, allowFailure = false) {
  const res = spawnSync(bin, args, { stdio: 'inherit' });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`${bin} exited with code ${res.status}`);
  }
  return res.status === 0;
}

function probeMedia(filePath) {
  const raw = execFileSync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]).toString('utf8');

  const info = JSON.parse(raw);
  const durationSec = Math.max(1, Number(info.format?.duration || 0));
  const sizeBytes = fs.statSync(filePath).size;
  const videoStream = (info.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (info.streams || []).find((s) => s.codec_type === 'audio');

  return {
    durationSec,
    sizeBytes,
    vcodec: videoStream?.codec_name || '',
    vprofile: videoStream?.profile || '',
    hasBFrames: Number(videoStream?.has_b_frames || 0) > 0,
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    acodec: audioStream?.codec_name || '',
  };
}

function selectAdaptiveScaleAndFps(videoBitrateBps, qualityPref) {
  let maxHeight = 720;
  let fpsFilter = '';

  if (qualityPref === '360p') {
    maxHeight = 360;
  } else if (qualityPref === '480p') {
    maxHeight = 480;
  }

  if (videoBitrateBps < 80_000) {
    maxHeight = Math.min(maxHeight, 144);
    fpsFilter = ',fps=15';
  } else if (videoBitrateBps < 160_000) {
    maxHeight = Math.min(maxHeight, 240);
    fpsFilter = ',fps=20';
  } else if (videoBitrateBps < 340_000) {
    maxHeight = Math.min(maxHeight, 360);
    fpsFilter = ',fps=24';
  } else if (videoBitrateBps < 750_000) {
    maxHeight = Math.min(maxHeight, 480);
  }

  return `scale=-2:'min(${maxHeight},ih)'${fpsFilter}`;
}

function encodeTwoPassVideo(inputPath, outputPath, durationSec, targetBytes, qualityPref) {
  const totalBitsPerSec = Math.floor((targetBytes * 8 * 0.93) / durationSec);
  const audioBps = durationSec <= 300 ? 96_000 : durationSec <= 900 ? 64_000 : 48_000;
  const audioChannels = audioBps <= 64_000 ? '1' : '2';
  const videoBps = Math.max(36_000, totalBitsPerSec - audioBps);

  const vf = selectAdaptiveScaleAndFps(videoBps, qualityPref);
  const passLog = path.join(path.dirname(outputPath), 'ffmpeg2pass');

  console.log(
    `Relative compression: duration=${durationSec.toFixed(1)}s, target=${(targetBytes / 1e6).toFixed(2)}MB, video=${Math.round(videoBps / 1000)}kbps, audio=${Math.round(audioBps / 1000)}kbps, vf="${vf}"`
  );

  // Pass 1 (H.264 Main without B-frames for maximum WhatsApp compatibility per manual)
  runCmd('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    String(videoBps),
    '-maxrate',
    String(Math.round(videoBps * 1.15)),
    '-bufsize',
    String(Math.round(videoBps * 2)),
    '-vf',
    vf,
    '-pass',
    '1',
    '-passlogfile',
    passLog,
    '-an',
    '-f',
    'mp4',
    '/dev/null',
  ]);

  // Pass 2 with AAC audio and +faststart moov atom
  runCmd('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    String(videoBps),
    '-maxrate',
    String(Math.round(videoBps * 1.15)),
    '-bufsize',
    String(Math.round(videoBps * 2)),
    '-vf',
    vf,
    '-pass',
    '2',
    '-passlogfile',
    passLog,
    '-c:a',
    'aac',
    '-b:a',
    String(audioBps),
    '-ac',
    audioChannels,
    '-movflags',
    '+faststart',
    outputPath,
  ]);
}

async function sendWhatsAppText(to, body, replyToWamid) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: body.slice(0, 4096), preview_url: false },
  };
  if (replyToWamid) {
    payload.context = { message_id: replyToWamid };
  }
  const res = await fetch(`${WHATSAPP_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('WhatsApp text send failed:', res.status, await res.text());
  }
}

async function uploadAndSendWhatsAppMedia(to, filePath, mimeType, mediaType, caption, replyToWamid) {
  const bytes = fs.readFileSync(filePath);
  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', blob, path.basename(filePath));

  const uploadRes = await fetch(`${WHATSAPP_API_BASE}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: form,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`WhatsApp media upload HTTP ${uploadRes.status}: ${errText}`);
  }

  const { id: mediaId } = await uploadRes.json();
  const msgPayload = {
    messaging_product: 'whatsapp',
    to,
    type: mediaType,
    [mediaType]:
      mediaType === 'audio'
        ? { id: mediaId }
        : { id: mediaId, caption: caption.slice(0, 1024) },
  };
  if (replyToWamid) {
    msgPayload.context = { message_id: replyToWamid };
  }

  const sendRes = await fetch(`${WHATSAPP_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(msgPayload),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`WhatsApp media message HTTP ${sendRes.status}: ${errText}`);
  }

  return mediaId;
}

async function reportCallback(job, data) {
  if (!job.callback_url) return;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CALLBACK_SECRET) {
    headers.Authorization = `Bearer ${process.env.CALLBACK_SECRET}`;
  }
  try {
    await fetch(job.callback_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_id: job.job_id, ...data }),
    });
  } catch (err) {
    console.warn('Callback warning:', err.message);
  }
}

async function main() {
  const job = parseJobPayload();
  if (!job.to || !job.to.startsWith('user:')) {
    throw new Error(`Invalid or missing recipient "to": "${job.to}"`);
  }

  const workDir = fs.mkdtempSync('/tmp/wa-media-');

  try {
    if (job.mode === 'search') {
      const searchJson = execFileSync('yt-dlp', [
        '--dump-json',
        '--flat-playlist',
        `ytsearch5:${job.query}`,
      ]).toString('utf8');

      const entries = searchJson
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      if (!entries.length) {
        await sendWhatsAppText(job.to, `No results found for "${job.query}".`, job.reply_to_wamid);
        return;
      }

      const lines = entries.map(
        (e, i) => `${i + 1}. ${e.title}\n   https://www.youtube.com/watch?v=${e.id}`
      );
      await reportCallback(job, {
        user_id: job.to,
        query: job.query,
        search_results: entries.map((e) => ({
          videoId: e.id,
          title: e.title || 'Untitled',
          channel: e.channel || e.uploader || 'YouTube',
          duration: e.duration_string || 'N/A',
          url: `https://www.youtube.com/watch?v=${e.id}`,
        })),
      });
      await sendWhatsAppText(
        job.to,
        `Results for "${job.query}" (via yt-dlp):\n\n${lines.join('\n')}\n\nQuick actions: /play 1 · /audio 1 · /info 1 · /queue add 1`,
        job.reply_to_wamid
      );
      return;
    }

    if (!job.video_url) {
      throw new Error('Missing video_url in payload');
    }

    // Fetch title if missing
    let videoTitle = job.title;
    if (!videoTitle) {
      try {
        videoTitle = execFileSync('yt-dlp', ['--get-title', '--no-playlist', job.video_url])
          .toString('utf8')
          .trim();
      } catch {
        videoTitle = 'YouTube Media';
      }
    }

    if (job.mode === 'audio') {
      const rawAudioTemplate = path.join(workDir, 'source.%(ext)s');
      runCmd('yt-dlp', [
        '-f',
        'bestaudio/best',
        '--no-playlist',
        '--max-filesize',
        '300M',
        '-o',
        rawAudioTemplate,
        job.video_url,
      ]);

      const sourceFile = fs
        .readdirSync(workDir)
        .map((f) => path.join(workDir, f))
        .find((f) => path.basename(f).startsWith('source.'));

      if (!sourceFile) throw new Error('Audio download failed');
      const meta = probeMedia(sourceFile);

      // Compute relative audio bitrate so MP3 always stays under 15.5 MB
      const maxAudioBps = Math.floor((TARGET_BUDGET_BYTES * 8 * 0.94) / meta.durationSec);
      const chosenKbps = Math.min(192, Math.max(32, Math.floor(maxAudioBps / 1000)));
      const outMp3 = path.join(workDir, 'output.mp3');

      runCmd('ffmpeg', [
        '-y',
        '-i',
        sourceFile,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        `${chosenKbps}k`,
        outMp3,
      ]);

      const finalBytes = fs.statSync(outMp3).size;
      if (finalBytes > HARD_MAX_BYTES) {
        throw new Error(`Compressed audio (${finalBytes} bytes) still exceeds 16 MB limit`);
      }

      const mediaId = await uploadAndSendWhatsAppMedia(
        job.to,
        outMp3,
        'audio/mpeg',
        'audio',
        '',
        job.reply_to_wamid
      );

      await sendWhatsAppText(
        job.to,
        `Sent audio: ${videoTitle} (${(finalBytes / 1e6).toFixed(2)} MB @ ${chosenKbps} kbps)`,
        job.reply_to_wamid
      );

      await reportCallback(job, {
        status: 'completed',
        source_size_bytes: meta.sizeBytes,
        compressed_size_bytes: finalBytes,
        duration_sec: Math.round(meta.durationSec),
        media_id: mediaId,
      });
      return;
    }

    // Video mode with relative two-pass compression strictly < 16 MB
    const rawTemplate = path.join(workDir, 'source.%(ext)s');
    runCmd('yt-dlp', [
      '-f',
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best',
      '--merge-output-format',
      'mp4',
      '--no-playlist',
      '--max-filesize',
      '600M',
      '-o',
      rawTemplate,
      job.video_url,
    ]);

    const sourceFile = fs
      .readdirSync(workDir)
      .map((f) => path.join(workDir, f))
      .find((f) => path.basename(f).startsWith('source.'));

    if (!sourceFile) throw new Error('Video download failed');

    const meta = probeMedia(sourceFile);
    const outMp4 = path.join(workDir, 'whatsapp_ready.mp4');

    const alreadyCompliant =
      meta.sizeBytes <= 15_400_000 &&
      meta.vcodec === 'h264' &&
      !meta.hasBFrames &&
      meta.acodec === 'aac';

    if (alreadyCompliant) {
      runCmd('ffmpeg', ['-y', '-i', sourceFile, '-c', 'copy', '-movflags', '+faststart', outMp4]);
    } else {
      // Pass 1+2 targeting 15.1 MB proportionally to duration
      encodeTwoPassVideo(sourceFile, outMp4, meta.durationSec, TARGET_BUDGET_BYTES, job.quality);

      let outSize = fs.statSync(outMp4).size;
      // Safety retry if VBR overshoot pushed past 15.8 MB
      if (outSize > HARD_MAX_BYTES) {
        console.log(`Overshoot (${(outSize / 1e6).toFixed(2)} MB > 15.9 MB). Retrying tighter relative pass...`);
        const tighterBudget = Math.floor(TARGET_BUDGET_BYTES * (TARGET_BUDGET_BYTES / outSize) * 0.88);
        const retryMp4 = path.join(workDir, 'whatsapp_retry.mp4');
        encodeTwoPassVideo(sourceFile, retryMp4, meta.durationSec, tighterBudget, job.quality);
        fs.renameSync(retryMp4, outMp4);
        outSize = fs.statSync(outMp4).size;
      }
    }

    const finalBytes = fs.statSync(outMp4).size;
    if (finalBytes > HARD_MAX_BYTES) {
      // Extreme ultra-long video fallback: send MP3 audio if under 16 MB, plus direct link
      await sendWhatsAppText(
        job.to,
        `Video "${videoTitle}" is too long (${Math.round(meta.durationSec / 60)} min) to fit in a 16 MB MP4 upload even at minimum bitrate.\nWatch directly: ${job.video_url}`,
        job.reply_to_wamid
      );
      await reportCallback(job, {
        status: 'too_long_fallback',
        source_size_bytes: meta.sizeBytes,
        compressed_size_bytes: finalBytes,
        duration_sec: Math.round(meta.durationSec),
        error_message: 'Duration exceeds minimum viable 16 MB MP4 bitrate',
      });
      return;
    }

    const origMb = (meta.sizeBytes / 1e6).toFixed(1);
    const finalMb = (finalBytes / 1e6).toFixed(2);
    const caption = `${videoTitle}\nCompressed ${origMb} MB -> ${finalMb} MB (WhatsApp 16 MB limit)`;

    const mediaId = await uploadAndSendWhatsAppMedia(
      job.to,
      outMp4,
      'video/mp4',
      'video',
      caption,
      job.reply_to_wamid
    );

    await reportCallback(job, {
      status: 'completed',
      source_size_bytes: meta.sizeBytes,
      compressed_size_bytes: finalBytes,
      duration_sec: Math.round(meta.durationSec),
      media_id: mediaId,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Job failed:', errMsg);
    await sendWhatsAppText(
      job.to,
      `Sorry, media processing failed for ${job.video_url}: ${errMsg.slice(0, 200)}`,
      job.reply_to_wamid
    );
    await reportCallback(job, {
      status: 'failed',
      error_message: errMsg.slice(0, 400),
    });
    process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
